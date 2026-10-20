import type { GeneratedMedia } from "../../core/provider.js";
import { GeminiWebError } from "./errors.js";
import { extractGeminiCandidateMedia, pendingGeminiMedia } from "./media.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const malformed = () => new GeminiWebError("invalid_response", "Invalid Gemini history response");

export interface GeminiHistoryResult {
  content: string;
  media: GeneratedMedia[];
  completionStatus?: number;
}

function nested(value: unknown, path: readonly number[]): unknown {
  let current = value;
  for (const index of path) {
    if (!Array.isArray(current)) return undefined;
    current = current[index];
  }
  return current;
}

function validFramedLength(expected: number, line: string): boolean {
  return expected === Buffer.byteLength(line, "utf8") || expected === line.length || expected === line.length + 2;
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

function cancelWithoutWaiting(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try { void reader.cancel().catch(() => {}); } catch { /* The stream may already be closed or errored. */ }
}

/** Read only the turns RPC. It never submits or retries a chat/generation request. */
async function readHistoryRecords(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<unknown[][]> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let lines = 0;
  let pending = "";
  let expectedLength: number | undefined;
  let terminal = false;
  let endSeen = false;
  let observedLengths = true;
  let endBytes: number | undefined;
  let outerEntries = 0;
  let xssiSeen = false;
  let payloadStarted = false;
  let reachedEnd = false;
  const rpcRecords: unknown[][] = [];
  const abort = () => cancelWithoutWaiting(reader);
  signal.addEventListener("abort", abort, { once: true });

  function dispatch(value: unknown): void {
    if (!Array.isArray(value)) throw malformed();
    const entries = typeof value[0] === "string" ? [value] : value;
    if (!entries.length) throw malformed();
    let sawDi = false;
    for (const entry of entries) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") throw malformed();
      const kind = entry[0];
      if (kind === "af.httprm") {
        if (endSeen || entry.length !== 4 || !Number.isSafeInteger(entry[1]) || Number(entry[1]) < 0 ||
            typeof entry[2] !== "string" || !entry[2] || entry[2].length > 4096 || /[\u0000-\u001f\u007f]/.test(entry[2]) ||
            !Number.isSafeInteger(entry[3]) || Number(entry[3]) < 0) throw malformed();
        outerEntries++;
        continue;
      }
      if (kind === "di") {
        if (terminal || sawDi || endSeen || entry.length !== 2 || !Number.isSafeInteger(entry[1]) || Number(entry[1]) < 0) throw malformed();
        outerEntries++;
        sawDi = true;
        continue;
      }
      if (kind === "e") {
        if (!terminal && !sawDi) throw malformed();
        if (endSeen || entry.length !== 5 || !Number.isSafeInteger(entry[1]) || entry[2] !== null || entry[3] !== null ||
            !Number.isSafeInteger(entry[4]) || Number(entry[4]) < 0 || Number(entry[4]) > MAX_BYTES) throw malformed();
        outerEntries++;
        if (entry[1] !== outerEntries || !observedLengths) throw malformed();
        endBytes = Number(entry[4]);
        endSeen = true;
        continue;
      }
      if (terminal || sawDi || endSeen || kind !== "wrb.fr" || entry[1] !== "hNvQHb" ||
          typeof entry[2] !== "string" || Buffer.byteLength(entry[2], "utf8") > MAX_FRAME_BYTES) throw malformed();
      let record: unknown;
      try { record = JSON.parse(entry[2]); } catch { throw malformed(); }
      if (!Array.isArray(record)) throw malformed();
      if (entry[5] !== undefined && entry[5] !== null) throw malformed();
      outerEntries++;
      rpcRecords.push(record);
      if (rpcRecords.length > 4) throw malformed();
    }
    if (sawDi) terminal = true;
  }

  function consumeLine(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (++lines > 1024) throw malformed();
    if (!line.trim()) return;
    if (line === ")]}'") {
      if (xssiSeen || payloadStarted) throw malformed();
      xssiSeen = true;
      return;
    }
    if (line.startsWith(")]}'")) throw malformed();
    payloadStarted = true;
    if (line === "di") {
      if (terminal || expectedLength !== undefined) throw malformed();
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
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) throw malformed();
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw malformed(); }
    const observed = expectedLength !== undefined && expectedLength === line.length + 2;
    if (expectedLength !== undefined) {
      if (!validFramedLength(expectedLength, line)) throw malformed();
      observedLengths &&= observed;
      expectedLength = undefined;
    }
    dispatch(value);
  }

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await readWithAbort(reader, signal);
      signal.throwIfAborted();
      if (done) {
        reachedEnd = true;
        pending += decoder.decode();
        if (pending) consumeLine(pending);
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw malformed();
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        consumeLine(line);
      }
      if (Buffer.byteLength(pending, "utf8") > MAX_FRAME_BYTES) throw malformed();
    }
    if (expectedLength !== undefined || !terminal || (endSeen && endBytes !== bytes) || !rpcRecords.length) throw malformed();
  } catch (error) {
    if (error instanceof GeminiWebError || signal.aborted) throw error;
    throw malformed();
  } finally {
    signal.removeEventListener("abort", abort);
    if (!reachedEnd) cancelWithoutWaiting(reader);
    if (!signal.aborted) {
      try { reader.releaseLock(); } catch { /* A cancellation may still have a pending read. */ }
    }
  }

  return rpcRecords;
}

/** Explicit recovery from an owner-provided conversation URL, never a new generation. */
export async function findGeminiMediaTurn(
  body: ReadableStream<Uint8Array>, signal: AbortSignal, kind: "image" | "video", requestedReplyId?: string,
): Promise<{ replyId: string; candidateId: string }> {
  const records = await readHistoryRecords(body, signal);
  for (const record of records) {
    const turns = record[0];
    if (!Array.isArray(turns) || turns.length > 20) throw malformed();
    for (const turn of turns) {
      const replyId = nested(turn, [0, 1]);
      if (requestedReplyId && replyId !== requestedReplyId) continue;
      const candidates = nested(turn, [3, 0]);
      if (typeof replyId !== "string" || !/^r_[A-Za-z0-9_-]{1,254}$/.test(replyId) || !Array.isArray(candidates) || candidates.length > 8) continue;
      for (const candidate of candidates) {
        const candidateId = Array.isArray(candidate) ? candidate[0] : undefined;
        if (typeof candidateId !== "string" || !/^rc_[A-Za-z0-9_-]{1,253}$/.test(candidateId)) continue;
        const extracted = extractGeminiCandidateMedia(candidate, { replyId, candidateId }, kind);
        if (extracted.mediaPresent || (requestedReplyId && extracted.completionStatus === 1)) return { replyId, candidateId };
      }
    }
  }
  throw new GeminiWebError("history_not_found", "No generated media turn was found; no new request was sent");
}

export async function parseGeminiHistory(
  body: ReadableStream<Uint8Array>, signal: AbortSignal,
  lineage: { conversationId: string; replyId: string; candidateId: string; mediaKind?: "image" | "video" },
): Promise<GeminiHistoryResult> {
  for (const record of await readHistoryRecords(body, signal)) {
    const turns = record[0];
    if (!Array.isArray(turns) || turns.length > 20) throw malformed();
    for (const turn of turns) {
      if (!Array.isArray(turn) || nested(turn, [0, 1]) !== lineage.replyId) continue;
      const candidates = nested(turn, [3, 0]);
      if (!Array.isArray(candidates) || candidates.length > 8) throw malformed();
      const candidate = candidates.find(item => Array.isArray(item) && item[0] === lineage.candidateId);
      if (!candidate) continue;
      let extracted;
      try {
        extracted = extractGeminiCandidateMedia(candidate, lineage, lineage.mediaKind);
      } catch {
        throw malformed();
      }
      let media = extracted.media;
      if (!media.length && extracted.completionStatus === 1 && lineage.mediaKind) {
        media = [pendingGeminiMedia(lineage.mediaKind, lineage)];
      }
      return {
        content: "Gemini history status was refreshed without submitting a new generation request.",
        media,
        completionStatus: extracted.completionStatus,
      };
    }
  }
  throw new GeminiWebError("history_not_found", "Gemini has not published the requested media turn in history yet; no new request was sent.");
}
