import { GeminiMediaRecoveryError, GeminiWebError } from "./errors.js";
import { GeminiQuotaError, type GeminiMediaKind } from "./cooldown.js";
import { extractGeminiCandidateMedia } from "./media.js";
import type { GeneratedMedia } from "../../core/provider.js";

export interface GeminiWebReply {
  content: string;
  conversationId?: string;
  replyId?: string;
  candidateId?: string;
  media?: GeneratedMedia[];
  completionStatus?: number;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_FRAMES = 512;
const malformed = () => new GeminiWebError("invalid_response", "Invalid or incomplete Gemini Web stream", true);
const streamError = () => new GeminiWebError("stream_error", "Gemini Web reported a stream error; upstream details suppressed", true);
const id = (value: unknown, prefix: "c_" | "r_" | "rc_"): value is string => typeof value === "string" &&
  value.length <= 256 && new RegExp(`^${prefix}[A-Za-z0-9_-]{1,${256 - prefix.length}}$`).test(value);
const nested = (value: unknown, path: readonly number[]): unknown => {
  let current = value;
  for (const index of path) {
    if (!Array.isArray(current)) return undefined;
    current = current[index];
  }
  return current;
};

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

function jsonFrame(line: string): unknown {
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) throw malformed();
  try { return JSON.parse(line); } catch { throw malformed(); }
}

function validFrameLength(expected: number, line: string): boolean {
  const utf8Bytes = Buffer.byteLength(line, "utf8");
  return expected === utf8Bytes || expected === line.length || expected === line.length + 2;
}

function applyFrame(frame: unknown, state: {
  conversationId?: string; replyId?: string; candidateId?: string; content: string; records: number;
  endRecordSeen: boolean; outerEntries: number; totalBytes?: number; allObservedLengths: boolean;
  media: GeneratedMedia[]; completionStatus?: number; sawCandidate: boolean; sawProgress: boolean; lineageConflict: boolean;
}, alreadyTerminal: boolean, observedLength: boolean, quotaKind?: GeminiMediaKind): boolean {
  if (!Array.isArray(frame)) throw malformed();
  const entries = typeof frame[0] === "string" ? [frame] : frame;
  if (!entries.length) throw malformed();
  let sawTerminal = false;
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") throw malformed();
    const kind = entry[0];
    if (kind === "af.httprm") {
      // Transport metadata varies by turn; its timing need not equal `di`.
      if (state.endRecordSeen || entry.length !== 4 || !Number.isSafeInteger(entry[1]) || Number(entry[1]) < 0 ||
          typeof entry[2] !== "string" || !entry[2] || entry[2].length > 4096 || /[\u0000-\u001f\u007f]/.test(entry[2]) ||
          !Number.isSafeInteger(entry[3]) || Number(entry[3]) < 0) throw malformed();
      state.outerEntries++;
      continue;
    }
    if (kind === "di") {
      if (alreadyTerminal || sawTerminal || state.endRecordSeen || entry.length !== 2 ||
          !Number.isSafeInteger(entry[1]) || Number(entry[1]) < 0) throw malformed();
      state.outerEntries++;
      sawTerminal = true;
      continue;
    }
    if (kind === "e") {
      if (!alreadyTerminal && !sawTerminal) throw streamError();
      if (state.endRecordSeen || entry.length !== 5 || !Number.isSafeInteger(entry[1]) ||
          entry[2] !== null || entry[3] !== null || !Number.isSafeInteger(entry[4]) ||
          Number(entry[4]) < 0 || Number(entry[4]) > MAX_RESPONSE_BYTES) throw malformed();
      state.outerEntries++;
      if (entry[1] !== state.outerEntries || !observedLength || !state.allObservedLengths) throw malformed();
      state.totalBytes = Number(entry[4]);
      state.endRecordSeen = true;
      continue;
    }
    if (kind === "er") throw streamError();
    if (alreadyTerminal || sawTerminal || state.endRecordSeen) throw malformed();
    if (kind !== "wrb.fr") throw malformed();
    const outerQuotaCode = nested(entry, [5, 2, 0, 1, 0]);
    if (outerQuotaCode !== undefined) {
      let emptyQuotaPayload = false;
      if (typeof entry[2] === "string" && Buffer.byteLength(entry[2], "utf8") <= MAX_FRAME_BYTES) {
        try {
          const value: unknown = JSON.parse(entry[2]);
          emptyQuotaPayload = Array.isArray(value) && value.every(item => item === null);
        } catch { /* An unverified error payload can never authorize account fallback. */ }
      }
      if (outerQuotaCode === 1037 && quotaKind && !state.sawCandidate && !state.sawProgress && !state.content &&
          state.media.length === 0 && state.records === 0 && emptyQuotaPayload) throw new GeminiQuotaError(quotaKind);
      throw streamError();
    }
    let record: unknown;
    if (typeof entry[2] === "string" && Buffer.byteLength(entry[2], "utf8") <= MAX_FRAME_BYTES) {
      try { record = JSON.parse(entry[2]); } catch { throw malformed(); }
    } else {
      throw malformed();
    }
    const queueing = outerQuotaCode === undefined && Array.isArray(entry[5]) && entry[5].length > 0;
    if (!Array.isArray(record)) throw malformed();
    // In the confirmed success shape slot zero is null. A populated slot is
    // an upstream error record; do not return any earlier partial candidate.
    if (record[0] !== undefined && record[0] !== null) throw streamError();
    state.records++;
    state.outerEntries++;
    state.sawProgress ||= queueing;
    const metadata = record[1];
    if (metadata !== undefined && metadata !== null) {
      if (!Array.isArray(metadata)) throw malformed();
      const conversationId = metadata[0];
      const replyId = metadata[1];
      if (conversationId !== undefined && conversationId !== null) {
        if (!id(conversationId, "c_") || (state.conversationId && conversationId !== state.conversationId)) {
          state.lineageConflict = true; throw malformed();
        }
        state.conversationId = conversationId;
      }
      if (replyId !== undefined && replyId !== null) {
        if (!id(replyId, "r_") || (state.replyId && replyId !== state.replyId)) {
          state.lineageConflict = true; throw malformed();
        }
        state.replyId = replyId;
      }
    }
    const candidates = record[4];
    if (candidates !== undefined && candidates !== null && !Array.isArray(candidates)) throw streamError();
    const candidate = Array.isArray(candidates) ? candidates[0] : undefined;
    if (candidate === undefined || candidate === null) continue;
    if (!Array.isArray(candidate)) throw malformed();
    state.sawCandidate = true;
    const candidateId = candidate[0];
    if (candidateId !== undefined && candidateId !== null) {
      if (!id(candidateId, "rc_") || (state.candidateId && candidateId !== state.candidateId)) {
        state.lineageConflict = true; throw malformed();
      }
      state.candidateId = candidateId;
    }
    const candidateText = candidate[1];
    if (candidateText !== undefined && candidateText !== null) {
      if (!Array.isArray(candidateText)) throw malformed();
      if (candidateText[0] !== undefined && candidateText[0] !== null) {
        if (typeof candidateText[0] !== "string") throw malformed();
        state.content = candidateText[0];
      }
    }
    if (quotaKind) {
      const extracted = extractGeminiCandidateMedia(candidate, {
        conversationId: state.conversationId, replyId: state.replyId, candidateId: state.candidateId,
      }, quotaKind);
      if (extracted.mediaPresent) state.media = extracted.media;
      if (extracted.completionStatus !== undefined) state.completionStatus = extracted.completionStatus;
    }
  }
  return sawTerminal;
}

/**
 * Gemini's StreamGenerate response is XSSI-prefixed, line framed, and carries
 * batchexecute `wrb.fr` records. Numeric frame lengths accept UTF-8 byte
 * counts, UTF-16 code-unit counts, and the observed code-unit count including
 * the two framing newlines. A split UTF-8 sequence is decoded incrementally.
 */
export async function parseGeminiStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  options: { quotaKind?: GeminiMediaKind } = {},
): Promise<GeminiWebReply> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const state: { conversationId?: string; replyId?: string; candidateId?: string; content: string; records: number;
    endRecordSeen: boolean; outerEntries: number; totalBytes?: number; allObservedLengths: boolean;
    media: GeneratedMedia[]; completionStatus?: number; sawCandidate: boolean; sawProgress: boolean; lineageConflict: boolean } = {
    content: "", records: 0, endRecordSeen: false, outerEntries: 0, allObservedLengths: true,
    media: [], sawCandidate: false, sawProgress: false, lineageConflict: false,
  };
  let pending = "";
  let bytes = 0;
  let lines = 0;
  let expectedLength: number | undefined;
  let currentFrameObservedLength = false;
  let terminal = false;
  let xssiSeen = false;
  let payloadStarted = false;
  let reachedEnd = false;
  const abort = () => cancelWithoutWaiting(reader);
  signal.addEventListener("abort", abort, { once: true });

  function consumeLine(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (++lines > MAX_FRAMES * 3) throw malformed();
    if (!line.trim()) return;
    if (line === ")]}'") {
      if (xssiSeen || payloadStarted) throw malformed();
      xssiSeen = true;
      return;
    }
    if (line.startsWith(")]}'")) throw malformed();
    payloadStarted = true;
    if (line === "e" || line === "er") throw streamError();
    if (line === "di") {
      if (terminal) throw malformed();
      if (expectedLength !== undefined && !validFrameLength(expectedLength, line)) throw malformed();
      expectedLength = undefined;
      terminal = true;
      return;
    }
    if (/^\d+$/.test(line)) {
      if (expectedLength !== undefined) throw malformed();
      const length = Number(line);
      if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_FRAME_BYTES) throw malformed();
      expectedLength = length;
      return;
    }
    const json = jsonFrame(line);
    currentFrameObservedLength = expectedLength !== undefined && expectedLength === line.length + 2;
    state.allObservedLengths &&= currentFrameObservedLength;
    if (expectedLength !== undefined) {
      if (!validFrameLength(expectedLength, line)) throw malformed();
      expectedLength = undefined;
    }
    terminal = applyFrame(json, state, terminal, currentFrameObservedLength, options.quotaKind) || terminal;
    currentFrameObservedLength = false;
    if (state.records > MAX_FRAMES) throw malformed();
  }

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await readWithAbort(reader, signal);
      signal.throwIfAborted();
      if (done) {
        reachedEnd = true;
        pending += decoder.decode();
        if (pending) { consumeLine(pending); pending = ""; }
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw malformed();
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        consumeLine(line);
      }
      if (Buffer.byteLength(pending, "utf8") > MAX_FRAME_BYTES) throw malformed();
    }
    const acceptedDeferredMedia = Boolean(options.quotaKind && state.completionStatus === 1 &&
      id(state.conversationId, "c_") && id(state.replyId, "r_") && id(state.candidateId, "rc_"));
    if (expectedLength !== undefined || !terminal || !state.records || (!state.content && !state.media.length && !acceptedDeferredMedia) ||
        (state.endRecordSeen && state.totalBytes !== bytes)) throw malformed();
    return { content: state.content, conversationId: state.conversationId, replyId: state.replyId,
      candidateId: state.candidateId, ...(state.media.length ? { media: state.media } : {}),
      ...(state.completionStatus === undefined ? {} : { completionStatus: state.completionStatus }) };
  } catch (error) {
    if (options.quotaKind && !signal.aborted && !state.lineageConflict && error instanceof GeminiWebError &&
        ["invalid_response", "stream_error"].includes(error.code) && id(state.conversationId, "c_") &&
        id(state.replyId, "r_") && (state.candidateId === undefined || id(state.candidateId, "rc_"))) {
      throw new GeminiMediaRecoveryError(error, { conversationId: state.conversationId, replyId: state.replyId,
        ...(state.candidateId ? { candidateId: state.candidateId } : {}) });
    }
    if (error instanceof GeminiWebError || error instanceof GeminiQuotaError || signal.aborted) throw error;
    throw malformed();
  } finally {
    signal.removeEventListener("abort", abort);
    if (!reachedEnd) cancelWithoutWaiting(reader);
    if (!signal.aborted) {
      try { reader.releaseLock(); } catch { /* A cancellation may still have a pending read. */ }
    }
  }
}
