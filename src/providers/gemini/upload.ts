import type { FileInput } from "../../core/provider.js";
import { GeminiWebError } from "./errors.js";

const UPLOAD_URL = "https://content-push.googleapis.com/upload";
const GEMINI_ORIGIN = "https://gemini.google.com";
const PUSH_ID = "feeds/mcudyrk2a4khkz";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 5;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const uploadIdPattern = /^\/contrib_service\/[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,256}$/;

export interface GeminiUploadedFile {
  /** Ephemeral upstream upload response, kept in memory for one StreamGenerate request. */
  uploadId: string;
  filename: string;
  mimeType: string;
}

export interface GeminiUploadOptions {
  userAgent: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface ValidatedFile extends FileInput { mimeType: string }

function uploadError(code: string, message: string): GeminiWebError {
  return new GeminiWebError(code, message, false);
}

function validateFilename(name: unknown): name is string {
  return typeof name === "string" && Buffer.byteLength(name, "utf8") <= 255 &&
    /^[\p{L}\p{N}][\p{L}\p{N}._ -]*\.(?:txt|png|jpe?g|webp|mp4)$/iu.test(name) &&
    !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

function fileMime(name: string, buffer: Buffer): string | undefined {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "txt") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      return text.includes("\0") ? undefined : "text/plain";
    } catch { return undefined; }
  }
  if (extension === "png") {
    const valid = buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      buffer.toString("ascii", 12, 16) === "IHDR" && buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(20) > 0;
    return valid ? "image/png" : undefined;
  }
  if (extension === "jpg" || extension === "jpeg") {
    return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff ? "image/jpeg" : undefined;
  }
  if (extension === "webp") {
    const valid = buffer.length >= 16 && buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.readUInt32LE(4) + 8 === buffer.length && buffer.toString("ascii", 8, 12) === "WEBP";
    return valid ? "image/webp" : undefined;
  }
  if (extension === "mp4") {
    if (buffer.length < 16 || buffer.toString("ascii", 4, 8) !== "ftyp") return undefined;
    const boxSize = buffer.readUInt32BE(0);
    return boxSize >= 16 && boxSize <= buffer.length ? "video/mp4" : undefined;
  }
  return undefined;
}

function validateFiles(files: FileInput[]): ValidatedFile[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) {
    throw uploadError("invalid_file", "Select between one and five supported Gemini files");
  }
  let totalBytes = 0;
  const validated: ValidatedFile[] = [];
  for (const file of files) {
    if (!file || !validateFilename(file.name) || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0 ||
        file.buffer.length > MAX_FILE_BYTES) {
      throw uploadError("invalid_file", "Gemini files must be ordinary TXT, PNG, JPEG, WebP or MP4 buffers up to 10 MiB each");
    }
    totalBytes += file.buffer.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw uploadError("invalid_file", "Gemini file uploads are limited to 20 MiB total");
    const mimeType = fileMime(file.name, file.buffer);
    if (!mimeType) throw uploadError("invalid_file", "Gemini file content does not match its supported filename type");
    validated.push({ name: file.name, buffer: file.buffer, mimeType });
  }
  return validated;
}

function makeOperation(options: GeminiUploadOptions): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  if (!options || typeof options.userAgent !== "string" || !options.userAgent.trim() ||
      /[\u0000-\u001f\u007f]/.test(options.userAgent) || options.userAgent.length > 1024) {
    throw uploadError("configuration_error", "Gemini file upload requires a valid User-Agent");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw uploadError("configuration_error", "Gemini file upload timeout is invalid");
  }
  const controller = new AbortController();
  let didTimeout = false;
  const externalSignal = options.signal;
  const abortExternal = () => controller.abort(externalSignal?.reason ?? new DOMException("Upload cancelled", "AbortError"));
  if (externalSignal?.aborted) abortExternal();
  else externalSignal?.addEventListener("abort", abortExternal, { once: true });
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort(new DOMException("Upload timed out", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortExternal);
    },
  };
}

function abortError(signal: AbortSignal, timedOut: () => boolean): GeminiWebError | undefined {
  if (!signal.aborted) return undefined;
  return timedOut()
    ? uploadError("timeout_error", "Gemini file upload timed out; no chat request was sent")
    : uploadError("cancelled", "Gemini file upload was cancelled; no chat request was sent");
}

function cancelResponse(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* The response may already be closed. */ }
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

async function readBoundedText(response: Response, signal: AbortSignal): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES) {
      cancelResponse(response);
      throw uploadError("invalid_response", "Gemini file upload returned an invalid response");
    }
  }
  if (!response.body) throw uploadError("invalid_response", "Gemini file upload returned an empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { try { void reader.cancel().catch(() => undefined); } catch { /* The reader may already be closed. */ } };
  signal.addEventListener("abort", abort, { once: true });
  let reachedEnd = false;
  let size = 0;
  let text = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await raceAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (done) { reachedEnd = true; break; }
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw uploadError("invalid_response", "Gemini file upload returned an oversized response");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof GeminiWebError) throw error;
    throw uploadError("invalid_response", "Gemini file upload returned an invalid response");
  } finally {
    signal.removeEventListener("abort", abort);
    if (!reachedEnd) abort();
    try { reader.releaseLock(); } catch { /* Cancellation may still have a pending read. */ }
  }
}

async function uploadOne(file: ValidatedFile, options: GeminiUploadOptions, signal: AbortSignal, timedOut: () => boolean): Promise<GeminiUploadedFile> {
  let request: Promise<Response>;
  try {
    const form = new FormData();
    const bytes = new ArrayBuffer(file.buffer.length);
    new Uint8Array(bytes).set(file.buffer);
    form.append("file", new Blob([bytes], { type: file.mimeType }), file.name);
    request = (options.fetch ?? fetch)(UPLOAD_URL, {
      method: "POST",
      headers: {
        Origin: GEMINI_ORIGIN,
        Referer: `${GEMINI_ORIGIN}/`,
        "X-Tenant-Id": "bard-storage",
        "Push-ID": PUSH_ID,
        "User-Agent": options.userAgent.trim(),
      },
      body: form,
      credentials: "omit",
      redirect: "manual",
      signal,
    });
  } catch {
    const aborted = abortError(signal, timedOut);
    if (aborted) throw aborted;
    throw uploadError("file_upload_error", "Gemini file upload failed; no chat request was sent");
  }
  request.then(response => { if (signal.aborted) cancelResponse(response); }, () => undefined);
  let response: Response;
  try { response = await raceAbort(request, signal); }
  catch {
    const aborted = abortError(signal, timedOut);
    if (aborted) throw aborted;
    throw uploadError("file_upload_error", "Gemini file upload failed; no chat request was sent");
  }
  if (response.status >= 300 && response.status < 400) {
    cancelResponse(response);
    throw uploadError("file_upload_error", "Gemini file upload redirect was blocked; no chat request was sent");
  }
  if (!response.ok) {
    cancelResponse(response);
    throw uploadError("file_upload_error", "Gemini file upload failed; no chat request was sent");
  }
  let uploadId: string;
  try { uploadId = await readBoundedText(response, signal); }
  catch (error) {
    const aborted = abortError(signal, timedOut);
    if (aborted) throw aborted;
    throw error;
  }
  if (!uploadIdPattern.test(uploadId)) {
    throw uploadError("invalid_response", "Gemini file upload returned an invalid identifier");
  }
  return { uploadId, filename: file.name, mimeType: file.mimeType };
}

/** Upload already-authorized in-memory files to Gemini Web, without credentials or disk access. */
export async function uploadGeminiFiles(files: FileInput[], options: GeminiUploadOptions): Promise<GeminiUploadedFile[]> {
  const validated = validateFiles(files);
  const operation = makeOperation(options);
  const results: GeminiUploadedFile[] = [];
  try {
    for (const file of validated) {
      const aborted = abortError(operation.signal, operation.timedOut);
      if (aborted) throw aborted;
      results.push(await uploadOne(file, options, operation.signal, operation.timedOut));
    }
    return results;
  } finally {
    operation.cleanup();
  }
}
