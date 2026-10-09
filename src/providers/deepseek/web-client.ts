import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ChatRequest, FileInput, RemoteSession } from "../../core/provider.js";
import { DeepSeekWebError, httpError, authenticationError, isAuthenticationCode } from "./errors.js";
import { solvePow, type PowChallenge } from "./pow.js";
import { parseSSE, type WebReply } from "./sse.js";

const challengeSchema = z.object({
  algorithm: z.literal("DeepSeekHashV1"), challenge: z.string().min(1), salt: z.string().min(1),
  difficulty: z.number().int().positive().safe(), expire_at: z.number().int().positive().safe(),
  signature: z.string().min(1), target_path: z.string().min(1)
});
interface RequestContext { signal: AbortSignal; completionSent: boolean }
interface ClientOptions {
  baseUrl?: string; timeout?: number; fetch?: typeof fetch;
  solve?: (challenge: PowChallenge, signal: AbortSignal) => Promise<number>;
}

/** Own-account website transport. Never retries a write or logs upstream bodies. */
export class DeepSeekWebClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly request: typeof fetch;
  private readonly solver?: ClientOptions["solve"];
  private module?: WebAssembly.Module;

  constructor(private readonly token: string, options: ClientOptions = {}) {
    if (!token.trim()) throw new DeepSeekWebError("configuration_error", "Missing DEEPSEEK_USER_TOKEN (own website account)");
    this.baseUrl = (options.baseUrl ?? process.env.DEEPSEEK_WEB_BASE_URL ?? "https://chat.deepseek.com/api/v0").replace(/\/$/, "");
    const url = new URL(this.baseUrl);
    const website = url.origin === "https://chat.deepseek.com" && url.pathname === "/api/v0";
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.protocol === "http:";
    if ((!website && !local) || url.username || url.password || url.search || url.hash) {
      throw new DeepSeekWebError("configuration_error", "Web base URL must be DeepSeek Web or a loopback test server");
    }
    this.timeout = options.timeout ?? Number(process.env.DEEPSEEK_TIMEOUT || "60000");
    if (!Number.isSafeInteger(this.timeout) || this.timeout <= 0 || this.timeout > 2_147_483_647) {
      throw new DeepSeekWebError("configuration_error", "DEEPSEEK_TIMEOUT must be a positive integer in milliseconds");
    }
    this.request = options.fetch ?? fetch;
    this.solver = options.solve;
  }

  async initialize(): Promise<void> {
    if (this.solver) return;
    try {
      const bytes = await readFile(new URL("./upstream/sha3_wasm_bg.wasm", import.meta.url));
      this.module = await WebAssembly.compile(new Uint8Array(bytes));
    } catch {
      throw new DeepSeekWebError("pow_unavailable", "Missing or invalid pinned PoW WASM; run npm run setup:upstream and npm run build");
    }
  }

  private async run<T>(signal: AbortSignal | undefined, operation: (context: RequestContext) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), this.timeout);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const context = { signal: controller.signal, completionSent: false };
    try {
      controller.signal.throwIfAborted();
      return await operation(context);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DeepSeekWebError(signal?.aborted ? "cancelled" : "timeout_error",
          signal?.aborted ? "DeepSeek Web request cancelled" : `DeepSeek Web request timed out (${this.timeout}ms)`, context.completionSent);
      }
      if (error instanceof DeepSeekWebError) {
        if (context.completionSent && error.code === "http_error") throw new DeepSeekWebError(error.code, error.message, true);
        throw error;
      }
      throw new DeepSeekWebError("network_error", "DeepSeek Web transport failed; no automatic retry was performed", context.completionSent);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async fetch(path: string, context: RequestContext, init: RequestInit = {}): Promise<Response> {
    context.signal.throwIfAborted();
    const response = await this.request(this.baseUrl + path, {
      ...init, redirect: "error", signal: context.signal,
      headers: { Authorization: `Bearer ${this.token}`, "x-client-platform": "web",
        Origin: "https://chat.deepseek.com", Referer: "https://chat.deepseek.com/", ...init.headers }
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw httpError(response.status);
    }
    return response;
  }

  private async json(path: string, context: RequestContext, payload?: unknown, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.fetch(path, context, payload === undefined ? init : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
    let envelope;
    try { envelope = await response.json(); } catch {
      throw new DeepSeekWebError("invalid_response", "Invalid DeepSeek Web JSON response");
    }
    if (isAuthenticationCode(envelope?.code) || isAuthenticationCode(envelope?.data?.biz_code)) throw authenticationError();
    if (!envelope || envelope.code !== 0 || envelope.data?.biz_code !== 0) {
      throw new DeepSeekWebError("website_error", "DeepSeek Web rejected the request; check account access on the website");
    }
    const data = envelope.data?.biz_data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new DeepSeekWebError("invalid_response", "Missing DeepSeek Web response data");
    return data;
  }

  private async session(context: RequestContext): Promise<string> {
    const data = await this.json("/chat_session/create", context, { agent: "chat" });
    if (typeof data.id !== "string" || !data.id) throw new DeepSeekWebError("invalid_session", "Missing DeepSeek Web session ID");
    return data.id;
  }

  private async proof(path: string, context: RequestContext): Promise<string> {
    const data = await this.json("/chat/create_pow_challenge", context, { target_path: path });
    const parsed = challengeSchema.safeParse(data.challenge);
    if (!parsed.success || parsed.data.target_path !== path) throw new DeepSeekWebError("pow_challenge_error", "Invalid or unsupported DeepSeek Web PoW challenge");
    const challenge = parsed.data;
    if (!this.solver && !this.module) throw new DeepSeekWebError("pow_unavailable", "Initialize the DeepSeek Web client before use");
    const answer = this.solver ? await this.solver(challenge, context.signal) : await solvePow(this.module!, challenge, context.signal);
    return Buffer.from(JSON.stringify({ algorithm: challenge.algorithm, challenge: challenge.challenge,
      salt: challenge.salt, signature: challenge.signature, target_path: challenge.target_path, answer })).toString("base64");
  }

  private async complete(context: RequestContext, sessionId: string, parent: number | null,
    prompt: string, thinking: boolean, fileIds: string[]): Promise<WebReply & { sessionId: string }> {
    const proof = await this.proof("/api/v0/chat/completion", context);
    context.signal.throwIfAborted();
    context.completionSent = true;
    const response = await this.fetch("/chat/completion", context, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", "x-ds-pow-response": proof },
      body: JSON.stringify({ chat_session_id: sessionId, parent_message_id: parent, prompt,
        ref_file_ids: fileIds, thinking_enabled: thinking, search_enabled: false })
    });
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      await response.body?.cancel();
      throw new DeepSeekWebError("invalid_response", "Expected DeepSeek Web SSE response", true);
    }
    return { ...await parseSSE(response.body, context.signal), sessionId };
  }

  async chat(request: ChatRequest, previous?: RemoteSession): Promise<WebReply & { sessionId: string }> {
    if (previous && (typeof previous.sessionId !== "string" || !previous.sessionId ||
      !Number.isSafeInteger(previous.lastMessageId) || Number(previous.lastMessageId) < 0)) {
      throw new DeepSeekWebError("invalid_session", "Invalid DeepSeek remote session lineage");
    }
    return this.run(request.signal, async (context) => {
      const id = previous ? previous.sessionId as string : await this.session(context);
      const prompt = request.systemPrompt ? request.systemPrompt + "\n\n" + request.message : request.message;
      return this.complete(context, id, previous ? previous.lastMessageId as number : null, prompt, request.thinking, []);
    });
  }

  async analyzeFiles(files: FileInput[], instruction: string, thinking: boolean, signal?: AbortSignal): Promise<WebReply & { sessionId: string }> {
    return this.run(signal, async (context) => {
      const sessionId = await this.session(context);
      const ids: string[] = [];
      for (const file of files) {
        const proof = await this.proof("/api/v0/file/upload_file", context);
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(file.buffer)]), file.name);
        const data = await this.json("/file/upload_file", context, undefined, {
          method: "POST", headers: { "x-ds-pow-response": proof }, body: form
        });
        if (typeof data.id !== "string" || !data.id) throw new DeepSeekWebError("file_upload_error", "Missing uploaded file ID");
        ids.push(data.id);
      }
      const deadline = Date.now() + Math.min(30_000, this.timeout);
      const pending = new Set(ids);
      while (pending.size) {
        for (const id of pending) {
          const data = await this.json("/file/fetch_files?file_ids=" + encodeURIComponent(id), context);
          const file = z.object({ files: z.array(z.object({ id: z.string(), status: z.string() })) }).safeParse(data);
          const status = file.success ? file.data.files.find((entry) => entry.id === id)?.status : undefined;
          if (status === "SUCCESS") pending.delete(id);
          else if (status === "FAILED") throw new DeepSeekWebError("file_parse_error", "DeepSeek Web file parsing failed");
          else if (!status) throw new DeepSeekWebError("invalid_response", "Missing uploaded file parsing status");
        }
        if (!pending.size) break;
        if (Date.now() >= deadline) throw new DeepSeekWebError("file_parse_timeout", "DeepSeek Web file parsing timed out");
        await delay(Math.min(1000, deadline - Date.now()), undefined, { signal: context.signal });
      }
      return this.complete(context, sessionId, null, instruction, thinking, ids);
    });
  }
}
