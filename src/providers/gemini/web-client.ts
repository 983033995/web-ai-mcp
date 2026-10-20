import { createHash, randomUUID } from "node:crypto";
import type { ChatRequest, RemoteSession } from "../../core/provider.js";
import { authenticationError, captchaError, configurationError, GeminiWebError, httpError } from "./errors.js";
import { parseGeminiStream, type GeminiWebReply } from "./stream.js";

export interface GeminiWebClientOptions {
  baseUrl?: string;
  userAgent?: string;
  timeout?: number;
  fetch?: typeof fetch;
}

const MAX_HTML_BYTES = 4 * 1024 * 1024;
const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const remoteId = (value: unknown, prefix: "c_" | "r_" | "rc_"): value is string => typeof value === "string" &&
  value.length <= 256 && new RegExp(`^${prefix}[A-Za-z0-9_-]{1,${256 - prefix.length}}$`).test(value);
const sessionError = () => new GeminiWebError("session_state_error", "Invalid Gemini remote session; close it explicitly before starting another conversation");

interface GeminiContext { at: string; build: string; fsid: string; accountHash: string }
interface RequestContext { signal: AbortSignal; writeSent: boolean }

function ownSessionCookie(cookie: string): boolean {
  if (!cookie.trim() || /[\r\n]/.test(cookie)) return false;
  return cookie.split(";").some((part) => {
    const index = part.indexOf("=");
    return index > 0 && part.slice(0, index).trim() === "__Secure-1PSID" && part.slice(index + 1).trim().length > 0;
  });
}

function decodeString(value: string): string | undefined {
  try { return JSON.parse(`"${value}"`); } catch { return undefined; }
}

function field(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"${escaped}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(html);
  if (!match) return undefined;
  const value = decodeString(match[1]);
  return value && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

function isCaptchaPage(html: string): boolean {
  return /unusual traffic|verify you are human|captcha challenge|sorry\/index|automated queries/i.test(html);
}

function isLoginPage(html: string): boolean {
  return /accounts\.google\.com\/(?:ServiceLogin|signin)|identifierId|Sign in to continue/i.test(html);
}

function readWithAbort<T>(reader: ReadableStreamDefaultReader<T>, signal: AbortSignal): Promise<ReadableStreamReadResult<T>> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([reader.read(), aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

function cancelWithoutWaiting<T>(reader: ReadableStreamDefaultReader<T>): void {
  try { void reader.cancel().catch(() => {}); } catch { /* The stream may already be closed or errored. */ }
}

function cancelResponseWithoutWaiting(response: Response): void {
  try { void response.body?.cancel().catch(() => {}); } catch { /* The body may already be closed or errored. */ }
}

async function readText(response: Response, signal: AbortSignal, maxBytes: number, label: string, sessionUncertain = false): Promise<string> {
  if (!response.body) throw new GeminiWebError("invalid_response", `Empty Gemini ${label} response`, sessionUncertain);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => cancelWithoutWaiting(reader);
  signal.addEventListener("abort", abort, { once: true });
  let size = 0;
  let text = "";
  let reachedEnd = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await readWithAbort(reader, signal);
      signal.throwIfAborted();
      if (done) { reachedEnd = true; break; }
      size += value.byteLength;
      if (size > maxBytes) throw new GeminiWebError("invalid_response", `Oversized Gemini ${label} response`, sessionUncertain);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (signal.aborted || error instanceof GeminiWebError) throw error;
    throw new GeminiWebError("invalid_response", `Invalid Gemini ${label} response`, sessionUncertain);
  } finally {
    signal.removeEventListener("abort", abort);
    if (!reachedEnd) cancelWithoutWaiting(reader);
    if (!signal.aborted) {
      try { reader.releaseLock(); } catch { /* A cancellation may still have a pending read. */ }
    }
  }
}

function validateSession(previous: RemoteSession): asserts previous is RemoteSession & {
  conversationId: string; replyId: string; candidateId: string; accountHash: string;
} {
  if (!remoteId(previous.conversationId, "c_") || !remoteId(previous.replyId, "r_") || !remoteId(previous.candidateId, "rc_") ||
      typeof previous.accountHash !== "string" || !/^[a-f0-9]{64}$/.test(previous.accountHash)) throw sessionError();
}

function chatPayload(prompt: string, previous?: RemoteSession): unknown[] {
  const payload: unknown[] = Array(81).fill(null);
  payload[0] = [prompt, 0, null, null, null, null, 0];
  payload[1] = ["en"];
  payload[2] = previous
    ? [previous.conversationId, previous.replyId, previous.candidateId, null, null, null, null, null, null, ""]
    : ["", "", "", null, null, null, null, null, null, ""];
  for (const index of [7, 10, 27, 68, 79, 80]) payload[index] = 1;
  for (const index of [11, 18, 53]) payload[index] = 0;
  payload[6] = [1];
  payload[17] = [[0]];
  payload[30] = [4];
  payload[41] = [1];
  payload[59] = randomUUID().toUpperCase();
  payload[61] = [];
  return payload;
}

/** Own-account Gemini Web StreamGenerate client. Never retries a submitted chat. */
export class GeminiWebClient {
  private readonly baseUrl: URL;
  private readonly timeout: number;
  private readonly request: typeof fetch;
  private readonly userAgent: string;
  private readonly cookie: string;
  private verificationBlocked = false;
  private requestId = 100000;

  constructor(cookie: string, options: GeminiWebClientOptions = {}) {
    if (!ownSessionCookie(cookie)) throw configurationError();
    this.cookie = cookie.trim();
    this.userAgent = options.userAgent ?? process.env.GEMINI_USER_AGENT ?? "";
    if (!this.userAgent.trim() || /[\r\n]/.test(this.userAgent) || this.userAgent.length > 2048) throw configurationError();
    const rawBaseUrl = options.baseUrl ?? process.env.GEMINI_WEB_BASE_URL ?? "https://gemini.google.com";
    try { this.baseUrl = new URL(rawBaseUrl); } catch { throw configurationError(); }
    const production = this.baseUrl.origin === "https://gemini.google.com";
    const local = localHosts.has(this.baseUrl.hostname) && this.baseUrl.protocol === "http:";
    if ((!production && !local) || this.baseUrl.pathname !== "/" || this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) {
      throw configurationError();
    }
    this.timeout = options.timeout ?? Number(process.env.GEMINI_TIMEOUT || "60000");
    if (!Number.isSafeInteger(this.timeout) || this.timeout <= 0 || this.timeout > 600000) throw configurationError();
    this.request = options.fetch ?? fetch;
  }

  /** Configuration is checked by the constructor; discovery never contacts Gemini. */
  async initialize(): Promise<void> {}

  async chat(request: ChatRequest, previous?: RemoteSession): Promise<GeminiWebReply & { accountHash?: string }> {
    if (!request.message.trim()) throw new GeminiWebError("invalid_request", "Message must not be empty");
    if (request.thinking) throw new GeminiWebError("unsupported_capability", "Gemini Web thinking mode is not enabled");
    if (previous) validateSession(previous);
    if (this.verificationBlocked) throw captchaError();
    return this.run(request.signal, async (context) => {
      const current = await this.loadContext(context);
      if (previous && previous.accountHash !== current.accountHash) throw authenticationError();
      context.signal.throwIfAborted();

      const prompt = request.systemPrompt ? `${request.systemPrompt}\n\n${request.message}` : request.message;
      const endpoint = new URL("/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate", this.baseUrl);
      endpoint.search = new URLSearchParams({ bl: current.build, "f.sid": current.fsid, hl: "en",
        _reqid: String(this.requestId), rt: "c" }).toString();
      this.requestId = this.requestId >= 2_147_000_000 ? 100000 : this.requestId + 1;
      const payload = chatPayload(prompt, previous);
      const form = new URLSearchParams({ at: current.at, "f.req": JSON.stringify([null, JSON.stringify(payload)]) });
      context.writeSent = true;
      const response = await this.request(endpoint, {
        method: "POST", redirect: "manual", cache: "no-store", signal: context.signal,
        headers: { Cookie: this.cookie, "User-Agent": this.userAgent, Origin: this.baseUrl.origin,
          Referer: `${this.baseUrl.origin}/`, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1" },
        body: form
      });
      if (!response.ok) {
        await this.rejectResponse(response, context, true);
      }
      const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (contentType === "text/html") {
        const html = await readText(response, context.signal, 64 * 1024, "chat", true);
        if (isCaptchaPage(html)) throw captchaError(true);
        if (isLoginPage(html)) throw authenticationError(true);
        throw new GeminiWebError("invalid_response", "Gemini Web returned an unexpected HTML response", true);
      }
      if (contentType !== "application/json" && contentType !== "text/plain" && contentType !== "application/x-ndjson") {
        cancelResponseWithoutWaiting(response);
        throw new GeminiWebError("invalid_response", "Gemini Web returned an unexpected stream type", true);
      }
      if (!response.body) throw new GeminiWebError("invalid_response", "Empty Gemini Web stream", true);
      const reply = await parseGeminiStream(response.body, context.signal);
      if (previous) {
        if (reply.conversationId && reply.conversationId !== previous.conversationId) {
          throw new GeminiWebError("session_state_error", "Gemini changed the conversation lineage; close this conversation explicitly", true);
        }
        if ((reply.replyId && reply.replyId === previous.replyId) ||
            (reply.candidateId && reply.candidateId === previous.candidateId)) {
          throw new GeminiWebError("session_state_error", "Gemini reply lineage did not advance; close this conversation explicitly", true);
        }
      }
      return { ...reply, accountHash: current.accountHash };
    });
  }

  private async run<T>(signal: AbortSignal | undefined, operation: (context: RequestContext) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), this.timeout);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const context: RequestContext = { signal: controller.signal, writeSent: false };
    try {
      controller.signal.throwIfAborted();
      return await operation(context);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GeminiWebError(signal?.aborted ? "cancelled" : "timeout_error",
          signal?.aborted ? "Gemini Web request cancelled" : `Gemini Web request timed out (${this.timeout}ms)`, context.writeSent);
      }
      if (error instanceof GeminiWebError) {
        if (error.code === "captcha_required") this.verificationBlocked = true;
        throw error;
      }
      throw new GeminiWebError("network_error", "Gemini Web transport failed; no automatic retry was performed", context.writeSent);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async fetchInit(context: RequestContext): Promise<Response> {
    context.signal.throwIfAborted();
    return this.request(new URL("/app", this.baseUrl), { method: "GET", redirect: "manual", cache: "no-store",
      signal: context.signal, headers: { Cookie: this.cookie, "User-Agent": this.userAgent,
        Origin: this.baseUrl.origin, Referer: `${this.baseUrl.origin}/` } });
  }

  private async loadContext(context: RequestContext): Promise<GeminiContext> {
    const response = await this.fetchInit(context);
    if (!response.ok) {
      await this.rejectResponse(response, context, false);
    }
    const html = await readText(response, context.signal, MAX_HTML_BYTES, "initialization");
    if (isCaptchaPage(html)) throw captchaError();
    const at = field(html, "SNlM0e");
    const build = field(html, "cfb2h");
    const fsid = field(html, "FdrFJe");
    const email = field(html, "oPEP7c");
    if (!at || !build || !fsid || !email || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
      if (isLoginPage(html) || !email) throw authenticationError();
      throw new GeminiWebError("invalid_response", "Gemini Web initialization did not include usable request context");
    }
    const accountHash = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
    return { at, build, fsid, accountHash };
  }

  private async rejectResponse(response: Response, context: RequestContext, writeSent: boolean): Promise<never> {
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (contentType === "text/html") {
      const html = await readText(response, context.signal, 64 * 1024, "error", writeSent);
      if (isCaptchaPage(html)) throw captchaError(writeSent);
      if (isLoginPage(html)) throw authenticationError(writeSent);
    } else {
      cancelResponseWithoutWaiting(response);
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      try {
        if (new URL(location, this.baseUrl).hostname === "accounts.google.com") throw authenticationError(writeSent);
      } catch (error) {
        if (error instanceof GeminiWebError) throw error;
      }
    }
    throw httpError(response.status, writeSent);
  }
}
