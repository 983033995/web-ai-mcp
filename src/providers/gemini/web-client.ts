import { createHash, randomUUID } from "node:crypto";
import type { ChatRequest, GeneratedMedia, MediaGenerationRequest, RemoteSession } from "../../core/provider.js";
import { authenticationError, captchaError, configurationError, GeminiWebError, httpError } from "./errors.js";
import { GeminiQuotaError, type GeminiMediaKind } from "./cooldown.js";
import { parseGeminiHistory } from "./history.js";
import { pendingGeminiMedia, verifiedGeminiMediaURL } from "./media.js";
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
type GeminiSession = RemoteSession & {
  conversationId: string; replyId: string; candidateId: string; accountHash: string; mediaKind?: GeminiMediaKind;
};

const STREAM_GENERATE_PATH = "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const BATCH_EXEC_PATH = "/_/BardChatUi/data/batchexecute";
const HISTORY_RPC = "hNvQHb";
const QUOTA_RPC = "aPya6c";
const MAX_MEDIA_PROBES = 10;
const MAX_MEDIA_REDIRECTS = 2;

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
  conversationId: string; replyId: string; candidateId: string; accountHash: string; mediaKind?: GeminiMediaKind;
} {
  if (!remoteId(previous.conversationId, "c_") || !remoteId(previous.replyId, "r_") || !remoteId(previous.candidateId, "rc_") ||
      typeof previous.accountHash !== "string" || !/^[a-f0-9]{64}$/.test(previous.accountHash) ||
      (previous.mediaKind !== undefined && previous.mediaKind !== "image" && previous.mediaKind !== "video")) throw sessionError();
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

function parseQuotaResetRpc(text: string, rpcId: string): number | undefined {
  const parts = text.split("\n");
  let expectedLength: number | undefined;
  let xssiSeen = false;
  let payloadStarted = false;
  let terminal = false;
  let endSeen = false;
  let outerEntries = 0;
  let hasRPC = false;
  let resetAtMs: number | undefined;
  let frameLines = 0;
  const allFramedWithObservedLengths = parts.every((line, index) => {
    if (!/^\d+$/.test(line.replace(/\r$/, ""))) return true;
    const next = parts[index + 1]?.replace(/\r$/, "");
    return next !== undefined && Number(line) === next.length + 2;
  });

  for (let index = 0; index < parts.length; index++) {
    const line = parts[index].replace(/\r$/, "");
    if (!line.trim()) continue;
    if (++frameLines > 64) throw new GeminiWebError("invalid_response", "Gemini quota response has too many frames");
    if (line === ")]}'") {
      if (xssiSeen || payloadStarted) throw new GeminiWebError("invalid_response", "Invalid Gemini quota response prefix");
      xssiSeen = true;
      continue;
    }
    if (line.startsWith(")]}'")) throw new GeminiWebError("invalid_response", "Invalid Gemini quota response prefix");
    payloadStarted = true;
    if (/^\d+$/.test(line)) {
      if (expectedLength !== undefined) throw new GeminiWebError("invalid_response", "Invalid Gemini quota frame length");
      expectedLength = Number(line);
      if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0 || expectedLength > 256 * 1024) {
        throw new GeminiWebError("invalid_response", "Invalid Gemini quota frame length");
      }
      continue;
    }
    if (line === "di") {
      if (terminal || expectedLength !== undefined) throw new GeminiWebError("invalid_response", "Invalid Gemini quota terminal frame");
      terminal = true;
      continue;
    }
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { throw new GeminiWebError("invalid_response", "Invalid Gemini quota response JSON"); }
    if (Buffer.byteLength(line, "utf8") > 256 * 1024) throw new GeminiWebError("invalid_response", "Gemini quota frame is oversized");
    const observedLength = expectedLength !== undefined && expectedLength === line.length + 2;
    if (expectedLength !== undefined) {
      const valid = expectedLength === Buffer.byteLength(line, "utf8") || expectedLength === line.length || observedLength;
      if (!valid) throw new GeminiWebError("invalid_response", "Gemini quota frame length does not match");
      expectedLength = undefined;
    }
    const entries = Array.isArray(frame) && typeof frame[0] === "string" ? [frame] : frame;
    if (!Array.isArray(entries) || !entries.length) throw new GeminiWebError("invalid_response", "Invalid Gemini quota frame");
    let sawDi = false;
    for (const entry of entries) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") throw new GeminiWebError("invalid_response", "Invalid Gemini quota frame entry");
      const kind = entry[0];
      if (kind === "af.httprm") {
        if (endSeen || entry.length !== 4 || !Number.isSafeInteger(entry[1]) || Number(entry[1]) < 0 ||
            typeof entry[2] !== "string" || !entry[2] || entry[2].length > 4096 ||
            !Number.isSafeInteger(entry[3]) || Number(entry[3]) < 0) {
          throw new GeminiWebError("invalid_response", "Invalid Gemini quota transport metadata");
        }
        outerEntries++;
        continue;
      }
      if (kind === "di") {
        if (terminal || sawDi || endSeen || entry.length !== 2 || !Number.isSafeInteger(entry[1]) || Number(entry[1]) < 0) {
          throw new GeminiWebError("invalid_response", "Invalid Gemini quota terminal entry");
        }
        outerEntries++;
        sawDi = true;
        continue;
      }
      if (kind === "e") {
        if (!terminal && !sawDi || endSeen || entry.length !== 5 || !Number.isSafeInteger(entry[1]) ||
            entry[2] !== null || entry[3] !== null || !Number.isSafeInteger(entry[4]) || Number(entry[4]) < 0) {
          throw new GeminiWebError("invalid_response", "Invalid Gemini quota end entry");
        }
        outerEntries++;
        if (entry[1] !== outerEntries || !observedLength || !allFramedWithObservedLengths ||
            entry[4] !== Buffer.byteLength(text, "utf8")) {
          throw new GeminiWebError("invalid_response", "Gemini quota end accounting does not match");
        }
        endSeen = true;
        continue;
      }
      if (terminal || sawDi || endSeen || kind !== "wrb.fr" || entry[1] !== rpcId || hasRPC || typeof entry[2] !== "string" ||
          Buffer.byteLength(entry[2], "utf8") > 64 * 1024 || (entry[5] !== undefined && entry[5] !== null)) {
        throw new GeminiWebError("invalid_response", "Unexpected Gemini quota RPC response");
      }
      let payload: unknown;
      try { payload = JSON.parse(entry[2]); } catch { throw new GeminiWebError("invalid_response", "Invalid Gemini quota RPC payload"); }
      if (!Array.isArray(payload) || typeof payload[0] !== "boolean" || typeof payload[1] !== "number" || !Number.isFinite(payload[1])) {
        throw new GeminiWebError("invalid_response", "Unexpected Gemini quota RPC payload shape");
      }
      hasRPC = true;
      const resetSeconds = Array.isArray(payload[2]) ? payload[2][0] : undefined;
      if (payload[0] === true && typeof resetSeconds === "number" && Number.isSafeInteger(resetSeconds) && resetSeconds > 0) {
        const candidateMs = resetSeconds * 1000;
        if (Number.isSafeInteger(candidateMs) && candidateMs > Date.now()) resetAtMs = candidateMs;
      }
      outerEntries++;
    }
    if (sawDi) terminal = true;
  }
  if (expectedLength !== undefined || !hasRPC || !terminal) throw new GeminiWebError("invalid_response", "Gemini quota RPC response is incomplete");
  return resetAtMs;
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
    return this.send(request, previous);
  }

  async generateMedia(request: MediaGenerationRequest, previous?: RemoteSession): Promise<GeminiWebReply & { accountHash?: string; mediaKind?: GeminiMediaKind }> {
    if (!request.prompt.trim() || request.prompt.length > 20_000) {
      throw new GeminiWebError("invalid_request", "Gemini media prompt must be nonempty and at most 20,000 characters");
    }
    if (request.model !== undefined || request.style !== undefined || request.referenceImages?.length ||
        request.ratio !== undefined || request.durationSeconds !== undefined) {
      throw new GeminiWebError("unsupported_capability", "Gemini Web media supports prompt and kind only; model, style, references, ratio and duration are not verified");
    }
    const prefix = request.kind === "image"
      ? "Generate an image based on this description: "
      : request.kind === "video" ? "Generate a short video based on this description: " : undefined;
    if (!prefix) throw new GeminiWebError("invalid_request", "Gemini media kind must be image or video");
    const reply = await this.send({ message: prefix + request.prompt.trim(), thinking: false, signal: request.signal }, previous, request.kind);
    return { ...reply, mediaKind: request.kind };
  }

  async getMedia(previous: RemoteSession, signal?: AbortSignal): Promise<GeminiWebReply & { accountHash?: string; mediaKind?: GeminiMediaKind }> {
    validateSession(previous);
    if (this.verificationBlocked) throw captchaError();
    return this.run(signal, async context => {
      const current = await this.loadContext(context);
      if (previous.accountHash !== current.accountHash) throw authenticationError();
      const url = new URL(BATCH_EXEC_PATH, this.baseUrl);
      url.search = new URLSearchParams({ rpcids: HISTORY_RPC, "source-path": "/app", bl: current.build,
        "f.sid": current.fsid, hl: "en", _reqid: String(this.nextRequestId()), rt: "c" }).toString();
      const payload = [previous.conversationId, 10, null, 1, [1], [4], null, 1];
      const form = new URLSearchParams({ at: current.at, "f.req": JSON.stringify([[[HISTORY_RPC, JSON.stringify(payload), null, "generic"]]]) });
      const modelHeader: unknown[] = [1, null, null, null, null, null, null, null, [4, 5, 6, 8], null, null, null, null, null, null, null];
      modelHeader.push(randomUUID().toUpperCase());
      const response = await this.request(url, {
        method: "POST", redirect: "manual", cache: "no-store", signal: context.signal,
        headers: { Cookie: this.cookie, "User-Agent": this.userAgent, Origin: this.baseUrl.origin,
          Referer: `${this.baseUrl.origin}/app`, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1",
          "x-goog-ext-525001261-jspb": JSON.stringify(modelHeader), "x-goog-ext-73010989-jspb": "[0]" },
        body: form,
      });
      if (!response.ok) await this.rejectResponse(response, context, false);
      const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (!response.body || !["application/json", "text/plain", "application/x-ndjson"].includes(contentType ?? "")) {
        cancelResponseWithoutWaiting(response);
        throw new GeminiWebError("invalid_response", "Gemini history returned an unsupported response type");
      }
      const status = await parseGeminiHistory(response.body, context.signal, previous);
      const media = await this.confirmMedia(status.media, context.signal);
      return { content: status.content, media, conversationId: previous.conversationId, replyId: previous.replyId,
        candidateId: previous.candidateId, accountHash: current.accountHash, mediaKind: previous.mediaKind };
    });
  }

  /** Authenticated media fetch, restricted to Gemini's verified contribution origin and download path. */
  async fetchMedia(urlValue: string, init: RequestInit = {}): Promise<Response> {
    let kind: GeminiMediaKind = "image";
    try {
      if (new URL(urlValue).searchParams.get("filename")?.toLowerCase().endsWith(".mp4")) kind = "video";
    } catch { /* fetchMediaChecked returns the fixed validation error below. */ }
    return (await this.fetchMediaChecked(urlValue, kind, init)).response;
  }

  private async fetchMediaChecked(urlValue: string, kind: "image" | "video", init: RequestInit = {}): Promise<{ response: Response; url: string }> {
    const initialURL = verifiedGeminiMediaURL(urlValue, kind);
    if (!initialURL || (init.method !== undefined && init.method.toUpperCase() !== "GET") || init.body !== undefined) {
      throw new GeminiWebError("unsupported_capability", "Gemini media fetch accepts verified GET URLs only");
    }
    const sourceHeaders = new Headers(init.headers);
    let currentURL = new URL(initialURL);
    for (let redirects = 0; redirects <= MAX_MEDIA_REDIRECTS; redirects++) {
      const headers = new Headers({ "User-Agent": this.userAgent,
        Origin: this.baseUrl.origin, Referer: `${this.baseUrl.origin}/app` });
      if (currentURL.hostname === "contribution.usercontent.google.com" || currentURL.hostname === "lh3.google.com") {
        headers.set("Cookie", this.cookie);
      }
      for (const name of ["accept", "range"]) {
        const value = sourceHeaders.get(name);
        if (value) headers.set(name, value);
      }
      const response = await this.request(currentURL, { ...init, method: "GET", redirect: "manual", credentials: "omit",
        cache: "no-store", headers });
      if (response.status < 300 || response.status >= 400) return { response, url: currentURL.href };
      const location = response.headers.get("location");
      cancelResponseWithoutWaiting(response);
      if (!location || redirects === MAX_MEDIA_REDIRECTS) return { response, url: currentURL.href };
      let destination: URL;
      try { destination = new URL(location, currentURL); } catch { return { response, url: currentURL.href }; }
      const validated = verifiedGeminiMediaURL(destination.href, kind);
      if (!validated) return { response, url: currentURL.href };
      currentURL = new URL(validated);
    }
    throw new GeminiWebError("network_error", "Gemini media redirect limit exceeded");
  }

  private async send(request: ChatRequest, previous?: RemoteSession, quotaKind?: GeminiMediaKind): Promise<GeminiWebReply & { accountHash?: string }> {
    if (!request.message.trim()) throw new GeminiWebError("invalid_request", "Message must not be empty");
    if (request.thinking) throw new GeminiWebError("unsupported_capability", "Gemini Web thinking mode is not enabled");
    if (previous) validateSession(previous);
    if (this.verificationBlocked) throw captchaError();
    return this.run(request.signal, async (context) => {
      const current = await this.loadContext(context);
      if (previous && previous.accountHash !== current.accountHash) throw authenticationError();
      context.signal.throwIfAborted();

      const prompt = request.systemPrompt ? `${request.systemPrompt}\n\n${request.message}` : request.message;
      const endpoint = new URL(STREAM_GENERATE_PATH, this.baseUrl);
      endpoint.search = new URLSearchParams({ bl: current.build, "f.sid": current.fsid, hl: "en",
        _reqid: String(this.nextRequestId()), rt: "c" }).toString();
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
      let reply: GeminiWebReply;
      try {
        reply = await parseGeminiStream(response.body, context.signal, { quotaKind });
      } catch (error) {
        if (!(error instanceof GeminiQuotaError)) throw error;
        const resetAtMs = await this.readQuotaReset(context, current);
        throw new GeminiQuotaError(error.kind, resetAtMs);
      }
      if (previous) {
        if (reply.conversationId && reply.conversationId !== previous.conversationId) {
          throw new GeminiWebError("session_state_error", "Gemini changed the conversation lineage; close this conversation explicitly", true);
        }
        if ((reply.replyId && reply.replyId === previous.replyId) ||
            (reply.candidateId && reply.candidateId === previous.candidateId)) {
          throw new GeminiWebError("session_state_error", "Gemini reply lineage did not advance; close this conversation explicitly", true);
        }
      }
      const media = quotaKind ? await this.confirmMedia(reply.media ?? [], context.signal) : reply.media;
      let finalMedia = media;
      if (quotaKind && !finalMedia?.length && reply.completionStatus === 1 && reply.conversationId && reply.replyId && reply.candidateId) {
        finalMedia = [pendingGeminiMedia(quotaKind, reply)];
      }
      return { ...reply, ...(finalMedia ? { media: finalMedia } : {}), accountHash: current.accountHash };
    });
  }

  private nextRequestId(): number {
    const result = this.requestId;
    this.requestId = this.requestId >= 2_147_000_000 ? 100000 : this.requestId + 100000;
    return result;
  }

  private async readQuotaReset(context: RequestContext, current: GeminiContext): Promise<number | undefined> {
    const url = new URL(BATCH_EXEC_PATH, this.baseUrl);
    url.search = new URLSearchParams({ rpcids: QUOTA_RPC, "source-path": "/app", bl: current.build,
      "f.sid": current.fsid, hl: "en", _reqid: String(this.nextRequestId()), rt: "c" }).toString();
    const form = new URLSearchParams({ at: current.at, "f.req": JSON.stringify([[[QUOTA_RPC, "[]", null, "generic"]]]) });
    const modelHeader: unknown[] = [1, null, null, null, null, null, null, null, [4, 5, 6, 8], null, null, null, null, null, null, null];
    modelHeader.push(randomUUID().toUpperCase());
    const response = await this.request(url, {
      method: "POST", redirect: "manual", cache: "no-store", signal: context.signal,
      headers: { Cookie: this.cookie, "User-Agent": this.userAgent, Origin: this.baseUrl.origin,
        Referer: `${this.baseUrl.origin}/app`, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1",
        "x-goog-ext-525001261-jspb": JSON.stringify(modelHeader), "x-goog-ext-73010989-jspb": "[0]" },
      body: form,
    });
    if (!response.ok) await this.rejectResponse(response, context, false);
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!response.body || !["application/json", "text/plain", "application/x-ndjson"].includes(contentType ?? "")) {
      cancelResponseWithoutWaiting(response);
      throw new GeminiWebError("invalid_response", "Gemini quota status returned an unsupported response type");
    }
    const text = await readText(response, context.signal, 256 * 1024, "quota status");
    return parseQuotaResetRpc(text, QUOTA_RPC);
  }

  private async confirmMedia(media: GeneratedMedia[], signal: AbortSignal): Promise<GeneratedMedia[]> {
    if (media.length > MAX_MEDIA_PROBES) throw new GeminiWebError("invalid_response", "Gemini returned too many media items");
    const results: GeneratedMedia[] = [];
    for (const item of media) {
      const { probeUrl: _probeUrl, ...visible } = item as GeneratedMedia & { probeUrl?: string };
      if (!item.url || item.status === "unavailable") {
        results.push({ id: item.id, type: item.type, status: !item.url && item.status === "pending" ? "pending" : "unavailable" });
        continue;
      }
      const probeUrl = (item as GeneratedMedia & { probeUrl?: string }).probeUrl;
      const safeURL = verifiedGeminiMediaURL(probeUrl ?? item.url, item.type);
      if (!safeURL) { results.push({ id: item.id, type: item.type, status: "unavailable" }); continue; }
      signal.throwIfAborted();
      let response: Response | undefined;
      let finalURL = safeURL;
      try {
        const checked = await this.fetchMediaChecked(safeURL, item.type, { method: "GET", signal,
          headers: { Accept: item.type === "image" ? "image/*" : "video/mp4" } });
        response = checked.response;
        finalURL = checked.url;
        const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        const ready = response.status === 200 && (item.type === "image"
          ? ["image/png", "image/jpeg", "image/webp"].includes(contentType ?? "")
          : contentType === "video/mp4");
        results.push(ready ? { ...visible, url: finalURL, status: "completed" } : { id: item.id, type: item.type, status: "pending" });
      } catch (error) {
        if (signal.aborted) throw error;
        results.push({ id: item.id, type: item.type, status: "pending" });
      } finally {
        if (response) cancelResponseWithoutWaiting(response);
      }
    }
    return results;
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
      if (error instanceof GeminiQuotaError) throw error;
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
