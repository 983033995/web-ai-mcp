import { createHash, randomUUID } from "node:crypto";
import { ProviderError, type ChatRequest, type GeneratedMedia, type MediaGenerationRequest, type RemoteSession } from "../../core/provider.js";
import { authenticationError, captchaError, configurationError, GeminiMediaRecoveryError, GeminiWebError, httpError } from "./errors.js";
import { GeminiQuotaError, type GeminiMediaKind } from "./cooldown.js";
import { findGeminiMediaTurn, parseGeminiHistory } from "./history.js";
import { applyGeminiMediaControls, pendingGeminiMedia, validateGeminiMediaRatio, verifiedGeminiMediaURL } from "./media.js";
import { parseGeminiStream, type GeminiWebReply } from "./stream.js";
import { encodeGeminiSelection, GEMINI_THINKING_LEVELS, parseGeminiModels, resolveGeminiModel, resolveGeminiThinkingLevel, type GeminiModelCatalog } from "./selection.js";
import { uploadGeminiFiles } from "./upload.js";

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
const MODELS_RPC = "otAQ7b";
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
  conversationId: string; replyId: string; candidateId?: string; accountHash: string; mediaKind?: GeminiMediaKind;
} {
  if (!remoteId(previous.conversationId, "c_") || !remoteId(previous.replyId, "r_") ||
      (!remoteId(previous.candidateId, "rc_") && !(previous.mediaReadOnly === true && previous.candidateId === undefined &&
        (previous.mediaKind === "image" || previous.mediaKind === "video"))) ||
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

function parseGeminiRpc(text: string, rpcId: string): unknown {
  const parts = text.split("\n");
  let expectedLength: number | undefined;
  let xssiSeen = false;
  let payloadStarted = false;
  let terminal = false;
  let endSeen = false;
  let outerEntries = 0;
  let hasRPC = false;
  let rpcPayload: unknown;
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
      hasRPC = true;
      rpcPayload = payload;
      outerEntries++;
    }
    if (sawDi) terminal = true;
  }
  if (expectedLength !== undefined || !hasRPC || !terminal) throw new GeminiWebError("invalid_response", "Gemini quota RPC response is incomplete");
  return rpcPayload;
}

function parseQuotaResetRpc(text: string, rpcId: string): number | undefined {
  const payload = parseGeminiRpc(text, rpcId);
  if (!Array.isArray(payload) || typeof payload[0] !== "boolean" || typeof payload[1] !== "number" || !Number.isFinite(payload[1])) {
    throw new GeminiWebError("invalid_response", "Unexpected Gemini quota RPC payload shape");
  }
  const seconds = Array.isArray(payload[2]) ? payload[2][0] : undefined;
  const ms = typeof seconds === "number" ? seconds * 1000 : NaN;
  return payload[0] === true && Number.isSafeInteger(seconds) && Number.isSafeInteger(ms) && ms > Date.now() ? ms : undefined;
}

export type GeminiSelectedReply = GeminiWebReply & { accountHash?: string; model?: string; thinkingLevel?: string; warning?: string; mediaReadOnly?: boolean };

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

  async chat(request: ChatRequest, previous?: RemoteSession): Promise<GeminiSelectedReply> {
    return this.send(request, previous);
  }

  async recoverMedia(conversationId: string, kind: GeminiMediaKind, signal?: AbortSignal): Promise<GeminiSelectedReply & { mediaKind: GeminiMediaKind; mediaReadOnly: true }> {
    if (!remoteId(conversationId, "c_") || (kind !== "image" && kind !== "video")) throw sessionError();
    if (this.verificationBlocked) throw captchaError();
    return this.run(signal, async context => {
      const current = await this.loadContext(context);
      const response = await this.readHistory(conversationId, context, current);
      const raw = await readText(response, context.signal, 2 * 1024 * 1024, "media recovery");
      const selection = await findGeminiMediaTurn(new Response(raw).body!, context.signal, kind);
      const lineage = { conversationId, ...selection, mediaKind: kind };
      const status = await parseGeminiHistory(new Response(raw).body!, context.signal, lineage);
      return { ...lineage, accountHash: current.accountHash, content: status.content,
        media: await this.confirmMedia(status.media, context.signal), mediaReadOnly: true };
    });
  }

  async getModels(previous?: RemoteSession, signal?: AbortSignal): Promise<GeminiModelCatalog> {
    if (previous) validateSession(previous);
    if (this.verificationBlocked) throw captchaError();
    return this.run(signal, async context => {
      const current = await this.loadContext(context);
      if (previous && previous.accountHash !== current.accountHash) throw authenticationError();
      return this.readModels(context, current);
    });
  }

  async generateMedia(request: MediaGenerationRequest, previous?: RemoteSession): Promise<GeminiSelectedReply & { mediaKind?: GeminiMediaKind }> {
    if (!request.prompt.trim() || request.prompt.length > 20_000) {
      throw new GeminiWebError("invalid_request", "Gemini media prompt must be nonempty and at most 20,000 characters");
    }
    if (request.style !== undefined || request.durationSeconds !== undefined) {
      throw new GeminiWebError("unsupported_capability", "Gemini Web style and duration fields are not verified");
    }
    validateGeminiMediaRatio(request.kind, request.ratio);
    if (request.referenceVideos?.length && request.kind !== "video") throw new GeminiWebError("invalid_request", "Video references require video generation");
    if (request.referenceImages?.some(f => !/\.(png|jpe?g|webp)$/i.test(f.name)) ||
        request.referenceVideos?.some(f => !/\.mp4$/i.test(f.name))) throw new GeminiWebError("invalid_file", "Reference file type is unsupported");
    const prefix = request.kind === "image"
      ? "Generate an image based on this description: "
      : request.kind === "video" ? "Generate a short video based on this description: " : undefined;
    if (!prefix) throw new GeminiWebError("invalid_request", "Gemini media kind must be image or video");
    const files = [...(request.referenceImages ?? []), ...(request.referenceVideos ?? [])];
    const ratioInstruction = request.ratio ? `\nRequested output aspect ratio: ${request.ratio}.` : "";
    const referenceInstruction = files.length ? "\nUse the attached files as visual references for this creation." : "";
    const reply = await this.send({ message: prefix + request.prompt.trim() + ratioInstruction + referenceInstruction,
      thinking: false, model: request.model, thinkingLevel: request.thinkingLevel, files: files.length ? files : undefined,
      signal: request.signal }, previous, request.kind, request.ratio);
    const warnings = [request.referenceVideos?.length ? "The video was uploaded as a reference attachment; Gemini may decline video-reference generation or return prose. Only completed media confirms generation." : undefined].filter(Boolean);
    return { ...reply, mediaKind: request.kind, warning: [reply.warning, ...warnings].filter(Boolean).join(" ") || undefined };
  }

  async getMedia(previous: RemoteSession, signal?: AbortSignal): Promise<GeminiWebReply & { accountHash?: string; mediaKind?: GeminiMediaKind }> {
    validateSession(previous);
    if (this.verificationBlocked) throw captchaError();
    return this.run(signal, async context => {
      const current = await this.loadContext(context);
      if (previous.accountHash !== current.accountHash) throw authenticationError();
      const response = await this.readHistory(previous.conversationId, context, current);
      let candidateId = previous.candidateId;
      let body = response.body!;
      if (!candidateId) {
        const raw = await readText(response, context.signal, 2 * 1024 * 1024, "media recovery");
        const selected = await findGeminiMediaTurn(new Response(raw).body!, context.signal, previous.mediaKind!, previous.replyId);
        candidateId = selected.candidateId;
        body = new Response(raw).body!;
      }
      const status = await parseGeminiHistory(body, context.signal, { ...previous, candidateId });
      const media = await this.confirmMedia(status.media, context.signal);
      return { content: status.content, media, conversationId: previous.conversationId, replyId: previous.replyId,
        candidateId, accountHash: current.accountHash, mediaKind: previous.mediaKind };
    });
  }

  private async readHistory(conversationId: string, context: RequestContext, current: GeminiContext): Promise<Response> {
    const url = new URL(BATCH_EXEC_PATH, this.baseUrl);
    url.search = new URLSearchParams({ rpcids: HISTORY_RPC, "source-path": "/app", bl: current.build,
      "f.sid": current.fsid, hl: "en", _reqid: String(this.nextRequestId()), rt: "c" }).toString();
    const payload = [conversationId, 10, null, 1, [1], [4], null, 1];
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
    return response;
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

  private async send(request: ChatRequest, previous?: RemoteSession, quotaKind?: GeminiMediaKind, ratio?: string): Promise<GeminiSelectedReply> {
    if (previous?.mediaReadOnly) throw new GeminiWebError("session_state_error", "Recovered media sessions cannot submit new messages");
    if (!request.message.trim()) throw new GeminiWebError("invalid_request", "Message must not be empty");
    if (request.thinking) throw new GeminiWebError("unsupported_capability", "Use the explicit thinkingLevel selection for Gemini");
    if (previous) validateSession(previous);
    if (this.verificationBlocked) throw captchaError();
    return this.run(request.signal, async (context) => {
      const current = await this.loadContext(context);
      if (previous && previous.accountHash !== current.accountHash) throw authenticationError();
      context.signal.throwIfAborted();

      const modelName = request.model ?? (typeof previous?.model === "string" ? previous.model : undefined);
      const levelName = request.thinkingLevel ?? (typeof previous?.thinkingLevel === "string" ? previous.thinkingLevel : undefined);
      const level = resolveGeminiThinkingLevel(levelName, GEMINI_THINKING_LEVELS.map(({ preferenceValue, ...option }) => ({ ...option, wireValue: preferenceValue })));
      const catalog = modelName !== undefined || levelName !== undefined ? await this.readModels(context, current) : undefined;
      const model = catalog ? resolveGeminiModel(modelName, catalog.models) : undefined;
      const selected = encodeGeminiSelection(model, level, randomUUID());
      const uploaded = request.files?.length ? await uploadGeminiFiles(request.files, {
        fetch: this.request, userAgent: this.userAgent, signal: context.signal,
      }) : undefined;

      const prompt = request.systemPrompt ? `${request.systemPrompt}\n\n${request.message}` : request.message;
      const endpoint = new URL(STREAM_GENERATE_PATH, this.baseUrl);
      endpoint.search = new URLSearchParams({ bl: current.build, "f.sid": current.fsid, hl: "en",
        _reqid: String(this.nextRequestId()), rt: "c" }).toString();
      const payload = chatPayload(prompt, previous);
      if (quotaKind) applyGeminiMediaControls(payload, quotaKind, ratio);
      for (const [index, value] of Object.entries(selected.payloadPatch)) payload[Number(index)] = value;
      if (uploaded) (payload[0] as unknown[])[3] = uploaded.map(file => [[file.uploadId], file.filename]);
      const form = new URLSearchParams({ at: current.at, "f.req": JSON.stringify([null, JSON.stringify(payload)]) });
      context.writeSent = true;
      const response = await this.request(endpoint, {
        method: "POST", redirect: "manual", cache: "no-store", signal: context.signal,
        headers: { Cookie: this.cookie, "User-Agent": this.userAgent, Origin: this.baseUrl.origin,
          Referer: `${this.baseUrl.origin}/`, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1",
          ...selected.headers },
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
      let recovered = false;
      try {
        reply = await parseGeminiStream(response.body, context.signal, { quotaKind });
      } catch (error) {
        if (error instanceof GeminiQuotaError) {
          const resetAtMs = await this.readQuotaReset(context, current);
          throw new GeminiQuotaError(error.kind, resetAtMs);
        }
        if (!(error instanceof GeminiMediaRecoveryError) || !quotaKind) throw error;
        if (previous && error.lineage.conversationId !== previous.conversationId) throw error;
        // A failed stream is never replayed. Only authoritative history for the exact
        // observed reply/candidate may prove an accepted, queryable media operation.
        let status;
        let confirmedLineage;
        try {
          const response = await this.readHistory(error.lineage.conversationId, context, current);
          const raw = await readText(response, context.signal, 2 * 1024 * 1024, "media recovery", true);
          const selection = error.lineage.candidateId ? { replyId: error.lineage.replyId, candidateId: error.lineage.candidateId }
            : await findGeminiMediaTurn(new Response(raw).body!, context.signal, quotaKind, error.lineage.replyId);
          confirmedLineage = { conversationId: error.lineage.conversationId, ...selection };
          status = await parseGeminiHistory(new Response(raw).body!, context.signal, { ...confirmedLineage, mediaKind: quotaKind });
        } catch (readError) {
          if (readError instanceof ProviderError && readError.code === "history_not_found") {
            // Keep only the observed c/r and a read-only handle while the asynchronous
            // candidate is absent. This never declares completion or permits another write.
            confirmedLineage = error.lineage;
            status = { content: "The video request returned conversation/reply identifiers; media is awaiting read-only confirmation.",
              media: [pendingGeminiMedia(quotaKind, error.lineage)], completionStatus: 1 };
          } else {
            if (readError instanceof ProviderError) throw new GeminiWebError(readError.code, readError.message, true);
            throw error;
          }
        }
        if (!status.media.length) throw error;
        reply = { ...confirmedLineage, content: status.content, media: status.media, completionStatus: status.completionStatus };
        recovered = true;
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
      return { ...reply, ...(finalMedia ? { media: finalMedia } : {}), accountHash: current.accountHash,
        ...(recovered ? { mediaReadOnly: true, warning: "The generation response requires read-only history follow-up; media may still be awaiting confirmation. This key supports media status/download only, never resubmission." } : {}),
        ...(model ? { model: model.modelId } : {}), ...(level ? { thinkingLevel: level.id } : {}) };
    });
  }

  private nextRequestId(): number {
    const result = this.requestId;
    this.requestId = this.requestId >= 2_147_000_000 ? 100000 : this.requestId + 100000;
    return result;
  }

  private async readModels(context: RequestContext, current: GeminiContext): Promise<GeminiModelCatalog> {
    const url = new URL(BATCH_EXEC_PATH, this.baseUrl);
    url.search = new URLSearchParams({ rpcids: MODELS_RPC, "source-path": "/app", bl: current.build,
      "f.sid": current.fsid, hl: "en", _reqid: String(this.nextRequestId()), rt: "c" }).toString();
    const response = await this.request(url, {
      method: "POST", redirect: "manual", cache: "no-store", signal: context.signal,
      headers: { Cookie: this.cookie, "User-Agent": this.userAgent, Origin: this.baseUrl.origin,
        Referer: `${this.baseUrl.origin}/app`, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1" },
      body: new URLSearchParams({ at: current.at, "f.req": JSON.stringify([[[MODELS_RPC, "[]", null, "generic"]]]) }),
    });
    if (!response.ok) await this.rejectResponse(response, context, false);
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!["application/json", "text/plain", "application/x-ndjson"].includes(type ?? "")) {
      cancelResponseWithoutWaiting(response);
      throw new GeminiWebError("invalid_response", "Gemini model discovery returned an unsupported response type");
    }
    return parseGeminiModels(parseGeminiRpc(await readText(response, context.signal, 256 * 1024, "model discovery"), MODELS_RPC));
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
      if (error instanceof ProviderError) {
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
