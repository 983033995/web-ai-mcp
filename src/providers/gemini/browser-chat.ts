import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import type { ChatRequest, RemoteSession } from "../../core/provider.js";
import { GeminiWebClient, type GeminiSelectedReply, type GeminiWebClientOptions } from "./web-client.js";
import { GeminiWebError, assertGeminiAnswer } from "./errors.js";
import { resolveGeminiModel, type GeminiModelCatalog } from "./selection.js";
import type { BrowserChatInput, BrowserModelsInput } from "./browser-runtime.js";
import { validateGeminiFiles } from "./upload.js";
import { SessionStore } from "../../core/session-store.js";

const prefix = "WEB_AI_BROWSER_RESULT:";
type Runner = (input: BrowserChatInput, signal?: AbortSignal) => Promise<GeminiSelectedReply>;

function browserRunner<T, I extends BrowserModelsInput>(command: string, operation: "browserChat" | "browserModels"): (input: I, signal?: AbortSignal) => Promise<T> {
  return (input, signal) => new Promise((resolve, reject) => {
    const script = `const {${operation}}=await import(${JSON.stringify(new URL("./browser-runtime.js", import.meta.url).href)});
try {const result=await ${operation}(${JSON.stringify(input)},{taskSpace});console.log(${JSON.stringify(prefix)}+JSON.stringify({result}));}
catch(error){console.log(${JSON.stringify(prefix)}+JSON.stringify({error:{code:error.code||"browser_error",uncertain:Boolean(error.sessionUncertain)}}));}`;
    const abort = AbortSignal.any([AbortSignal.timeout(input.timeoutMs + 10_000), ...(signal ? [signal] : [])]);
    const child = spawn(command, ["nodejs"], { stdio: ["pipe", "pipe", "pipe"], signal: abort });
    let output = "", oversized = false;
    const capture = (chunk: Buffer) => {
      if (Buffer.byteLength(output) + chunk.length > 3 * 1024 * 1024) oversized = true;
      else output += String(chunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.stdin.on("error", () => {});
    child.on("error", () => reject(new GeminiWebError(abort.aborted ? signal?.aborted ? "cancelled" : "timeout_error" : "browser_error",
      "The configured browser command did not complete; no automatic replay was performed", operation === "browserChat")));
    child.on("close", () => {
      if (oversized) return reject(new GeminiWebError("invalid_response", "Oversized browser result", true));
      const line = output.split("\n").reverse().find(line => line.startsWith(prefix));
      if (!line) return reject(new GeminiWebError("browser_error", "The browser did not return a confirmed result; inspect its Page before further writes", operation === "browserChat"));
      try {
        const value = JSON.parse(line.slice(prefix.length));
        if (value.error) {
          const known = ["authentication_error", "session_state_error", "invalid_request", "invalid_response", "history_not_found", "website_error", "configuration_error", "browser_error"];
          reject(new GeminiWebError(known.includes(value.error.code) ? value.error.code : "browser_error", "Gemini browser chat failed; no automatic retry was performed", Boolean(value.error.uncertain)));
        } else resolve(value.result as T);
      } catch { reject(new GeminiWebError("invalid_response", "Invalid browser result", true)); }
    });
    child.stdin.end(script);
  });
}

/** Explicit native UI transport for chat only. Media/read-only HTTP tools remain separate. */
export class GeminiBrowserChatClient extends GeminiWebClient {
  private readonly runner: Runner;
  private readonly modelRunner: (input: BrowserModelsInput, signal?: AbortSignal) => Promise<GeminiModelCatalog>;
  private readonly browserTimeout: number;
  private readonly browserLease: SessionStore;
  constructor(cookie: string, private readonly browser: { spaceId: number; email: string; command?: string },
    options: GeminiWebClientOptions & { runBrowser?: Runner } = {}) {
    super(cookie, { ...options, accountId: browser.email });
    this.browserTimeout = options.timeout ?? Number(process.env.GEMINI_TIMEOUT || "60000");
    this.browserLease = new SessionStore(0, Date.now, join(tmpdir(), `web-ai-gemini-browser-${process.getuid?.() ?? "user"}-${browser.spaceId}.json`));
    const command = browser.command ?? process.env.GEMINI_BROWSER_COMMAND ?? "ego-browser";
    this.runner = options.runBrowser ?? browserRunner(command, "browserChat");
    this.modelRunner = browserRunner(command, "browserModels");
  }

  override async getModels(previous?: RemoteSession, signal?: AbortSignal): Promise<GeminiModelCatalog> {
    signal?.throwIfAborted();
    const expected = createHash("sha256").update(this.browser.email.toLowerCase()).digest("hex");
    if (previous?.accountHash && previous.accountHash !== expected) throw new GeminiWebError("authentication_error", "The conversation belongs to another browser owner");
    return this.modelRunner({ spaceId: this.browser.spaceId, email: this.browser.email, timeoutMs: this.browserTimeout }, signal);
  }

  override async chat(request: ChatRequest, previous?: RemoteSession): Promise<GeminiSelectedReply> {
    return this.browserLease.exclusive("browser", () => this.chatOnce(request, previous));
  }

  private async chatOnce(request: ChatRequest, previous?: RemoteSession): Promise<GeminiSelectedReply> {
    request.signal?.throwIfAborted();
    if (!request.message.trim() || request.thinking) throw new GeminiWebError("invalid_request", "Use a nonempty message and thinking_level for browser chat");
    if (previous?.mediaReadOnly || (previous && (!/^c_[A-Za-z0-9_-]{1,254}$/.test(String(previous.conversationId)) ||
        !/^r_[A-Za-z0-9_-]{1,254}$/.test(String(previous.replyId)) || !/^rc_[A-Za-z0-9_-]{1,253}$/.test(String(previous.candidateId)) ||
        !/^[a-f0-9]{64}$/.test(String(previous.accountHash))))) throw new GeminiWebError("session_state_error", "Invalid browser conversation lineage");
    const thinkingLevel = request.thinkingLevel ?? (previous?.thinkingLevel as string | undefined) ?? "low";
    if (!["low", "medium", "high"].includes(thinkingLevel)) throw new GeminiWebError("invalid_request", "Unsupported thinking level");
    let model = request.model ?? (previous?.model as string | undefined);
    if (model && (/^[a-f0-9]{8,64}$/i.test(model) || model.startsWith("gemini-"))) {
      model = resolveGeminiModel(model, (await this.getModels(previous, request.signal)).models)?.displayName;
    }
    if (model && (model.length > 160 || /[\u0000-\u001f\u007f]/.test(model))) throw new GeminiWebError("invalid_request", "Invalid browser model");
    let directory: string | undefined;
    try {
      const paths: string[] = [];
      if (request.files?.length) {
        validateGeminiFiles(request.files);
        directory = await mkdtemp(join(tmpdir(), "web-ai-gemini-upload-"));
        for (const file of request.files) {
          if (basename(file.name) !== file.name || paths.some(path => basename(path) === file.name)) throw new GeminiWebError("invalid_file", "Invalid or duplicate browser upload name");
          const path = join(directory, file.name);
          await writeFile(path, file.buffer, { mode: 0o600, flag: "wx" });
          paths.push(path);
        }
      }
      const result = await this.runner({ spaceId: this.browser.spaceId, email: this.browser.email,
        message: request.systemPrompt ? `${request.systemPrompt}\n\n${request.message}` : request.message, model,
        thinkingLevel: thinkingLevel as BrowserChatInput["thinkingLevel"],
        previous: previous ? { conversationId: String(previous.conversationId), replyId: String(previous.replyId),
          candidateId: String(previous.candidateId), accountHash: String(previous.accountHash) } : undefined,
        files: paths, timeoutMs: this.browserTimeout }, request.signal);
      if (!result?.content?.trim() || !/^c_[A-Za-z0-9_-]+$/.test(result.conversationId ?? "") ||
          !/^r_[A-Za-z0-9_-]+$/.test(result.replyId ?? "") || !/^rc_[A-Za-z0-9_-]+$/.test(result.candidateId ?? "") ||
          result.accountHash !== createHash("sha256").update(this.browser.email.toLowerCase()).digest("hex") ||
          (previous && (result.conversationId !== previous.conversationId || result.replyId === previous.replyId || result.candidateId === previous.candidateId))) {
        throw new GeminiWebError("invalid_response", "Browser result has incomplete conversation lineage", true);
      }
      assertGeminiAnswer(result.content);
      return result;
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }
}
