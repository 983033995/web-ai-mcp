import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { ProviderError } from "./provider.js";

const IMAGE_LIMIT = 20 * 1024 * 1024;
const VIDEO_LIMIT = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 45_000;

export type MediaType = "image" | "video";
export type MediaDownloadOptions = {
  directory?: string;
  fetch?: typeof fetch;
  validateUrl: (value: string, type: MediaType) => URL;
};
type FileFormat = { mimeType: string; extension: string; signatureLength: number; matches: (bytes: Buffer) => boolean };

const formats: Record<MediaType, readonly FileFormat[]> = {
  image: [
    { mimeType: "image/png", extension: "png", signatureLength: 8,
      matches: bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    { mimeType: "image/jpeg", extension: "jpg", signatureLength: 3,
      matches: bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
    { mimeType: "image/webp", extension: "webp", signatureLength: 12,
      matches: bytes => bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" },
  ],
  video: [
    { mimeType: "video/mp4", extension: "mp4", signatureLength: 12,
      matches: bytes => bytes.toString("ascii", 4, 8) === "ftyp" },
  ],
};

const configurationError = () => new ProviderError(
  "Media download directory is not configured or is unavailable", "download_configuration_error"
);
const invalidResponse = () => new ProviderError("Media server returned an invalid media file", "invalid_response");
const downloadError = () => new ProviderError("Could not download or save the media file", "download_error");

/** Validate an existing absolute directory without creating or changing it. */
export async function validateMediaDirectory(directory = process.env.WEB_AI_MEDIA_DIR): Promise<string> {
  if (!directory?.trim() || !isAbsolute(directory)) throw configurationError();
  const path = resolve(directory);
  try {
    const root = parse(path).root;
    let current = root;
    const parts = path.slice(root.length).split(sep).filter(Boolean);
    const uid = process.getuid?.();
    const components = [root];
    for (const part of parts) {
      current = join(current, part);
      components.push(current);
    }
    for (const [index, component] of components.entries()) {
      current = component;
      const target = index === components.length - 1;
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw configurationError();
      if (!entry.isDirectory()) throw configurationError();
      if (uid !== undefined && entry.uid !== 0 && entry.uid !== uid) throw configurationError();
      const writableByOthers = uid !== undefined && (entry.mode & 0o022) !== 0;
      const rootStickyAncestor = !target && entry.uid === 0 && (entry.mode & 0o1000) !== 0;
      if (writableByOthers && !rootStickyAncestor) throw configurationError();
    }
    const actual = await realpath(path);
    const expected = await stat(path);
    if (actual !== path || !expected.isDirectory()) throw configurationError();
    return path;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw configurationError();
  }
}

/** Keep an open directory handle as an inode sentinel while using the verified path. */
async function openVerifiedDirectory(value: string): Promise<{ path: string; handle: Awaited<ReturnType<typeof open>> }> {
  const path = await validateMediaDirectory(value);
  if (!value.trim() || !isAbsolute(value)) throw configurationError();
  try {
    const expected = await lstat(path);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      await handle.close();
      throw configurationError();
    }
    return { path, handle };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw configurationError();
  }
}

async function assertDirectoryStable(path: string, handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  try {
    await validateMediaDirectory(path);
    const opened = await handle.stat();
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== opened.dev || current.ino !== opened.ino ||
        await realpath(path) !== path) throw configurationError();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw configurationError();
  }
}

function failureForAbort(timedOut: boolean): ProviderError {
  return timedOut
    ? new ProviderError("Media download timed out", "timeout_error")
    : new ProviderError("Media download was cancelled", "cancelled");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ProviderError("Media download was interrupted", "download_error"));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => rejectPromise(new ProviderError("Media download was interrupted", "download_error"));
    const finish = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { finish(); resolvePromise(value); }, error => { finish(); rejectPromise(error); });
  });
}

async function readAt(handle: Awaited<ReturnType<typeof open>>, length: number, position: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(bytes, read, length - read, position + read);
    if (!result.bytesRead) break;
    read += result.bytesRead;
  }
  return bytes.subarray(0, read);
}

async function validPng(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<boolean> {
  if (size < 8) return false;
  const signature = await readAt(handle, 8, 0);
  if (!signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
  let position = 8;
  let chunks = 0;
  let hasHeader = false;
  while (position < size && ++chunks <= 65_536) {
    const header = await readAt(handle, 8, position);
    if (header.length !== 8) return false;
    const length = header.readUInt32BE(0);
    const kind = header.toString("ascii", 4, 8);
    if (!/^[A-Za-z]{4}$/.test(kind) || length > size - position - 12) return false;
    if (!hasHeader) {
      if (kind !== "IHDR" || length !== 13) return false;
      hasHeader = true;
    } else if (kind === "IHDR") return false;
    position += length + 12;
    if (kind === "IEND") return length === 0 && position === size && hasHeader;
  }
  return false;
}

async function validJpeg(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<boolean> {
  if (size < 12) return false;
  const prefix = await readAt(handle, 2, 0);
  const trailer = await readAt(handle, 2, size - 2);
  if (!prefix.equals(Buffer.from([0xff, 0xd8])) || !trailer.equals(Buffer.from([0xff, 0xd9]))) return false;
  let position = 2;
  let markers = 0;
  let hasFrame = false;
  let hasScan = false;
  while (position < size - 2 && ++markers <= 1024) {
    const prefixByte = await readAt(handle, 1, position++);
    if (prefixByte[0] !== 0xff) return false;
    let marker = await readAt(handle, 1, position++);
    while (marker[0] === 0xff) marker = await readAt(handle, 1, position++);
    if (marker.length !== 1 || marker[0] === 0x00 || marker[0] === 0xd8 || marker[0] === 0xd9) return false;
    if (marker[0] === 0x01 || (marker[0] >= 0xd0 && marker[0] <= 0xd7)) continue;
    const lengthBytes = await readAt(handle, 2, position);
    if (lengthBytes.length !== 2) return false;
    const segmentLength = lengthBytes.readUInt16BE(0);
    if (segmentLength < 2 || segmentLength > size - 2 - position) return false;
    const isFrame = (marker[0] >= 0xc0 && marker[0] <= 0xc3) || (marker[0] >= 0xc5 && marker[0] <= 0xc7) ||
      (marker[0] >= 0xc9 && marker[0] <= 0xcb) || (marker[0] >= 0xcd && marker[0] <= 0xcf);
    if (isFrame) {
      if (segmentLength < 8) return false;
      const dimensions = await readAt(handle, 5, position + 2);
      if (dimensions.length !== 5 || dimensions.readUInt16BE(1) === 0 || dimensions.readUInt16BE(3) === 0) return false;
      hasFrame = true;
    }
    position += segmentLength;
    if (marker[0] === 0xda) {
      if (segmentLength < 6 || position > size - 2) return false;
      hasScan = true;
      break;
    }
  }
  return hasFrame && hasScan;
}

async function validWebp(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<boolean> {
  if (size < 20) return false;
  const header = await readAt(handle, 12, 0);
  if (header.length !== 12 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WEBP" ||
      header.readUInt32LE(4) + 8 !== size) return false;
  let position = 12;
  let chunks = 0;
  while (position < size && ++chunks <= 65_536) {
    const chunk = await readAt(handle, 8, position);
    if (chunk.length !== 8 || !/^[\x20-\x7e]{4}$/.test(chunk.toString("ascii", 0, 4))) return false;
    const length = chunk.readUInt32LE(4);
    const paddedLength = length + (length % 2);
    if (paddedLength > size - position - 8) return false;
    position += 8 + paddedLength;
  }
  return chunks > 0 && chunks <= 65_536 && position === size;
}

async function validMp4(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<boolean> {
  let position = 0;
  let boxes = 0;
  const seen = new Set<string>();
  while (position < size && ++boxes <= 4096) {
    const header = await readAt(handle, 8, position);
    if (header.length !== 8) return false;
    let boxSize = BigInt(header.readUInt32BE(0));
    const kind = header.toString("ascii", 4, 8);
    let headerSize = 8;
    if (!/^[\x20-\x7e]{4}$/.test(kind)) return false;
    if (boxSize === 1n) {
      const extended = await readAt(handle, 8, position + 8);
      if (extended.length !== 8) return false;
      boxSize = extended.readBigUInt64BE(0);
      headerSize = 16;
    } else if (boxSize === 0n) boxSize = BigInt(size - position);
    if (boxSize < BigInt(headerSize) || boxSize > BigInt(size - position)) return false;
    const length = Number(boxSize);
    if (!Number.isSafeInteger(length)) return false;
    if (kind === "ftyp" && length >= 16) seen.add(kind);
    if (kind === "moov" && length > headerSize) seen.add(kind);
    if (kind === "mdat" && length > headerSize) seen.add(kind);
    position += length;
  }
  return position === size && boxes <= 4096 && seen.has("ftyp") && seen.has("moov") && seen.has("mdat");
}

async function validFile(handle: Awaited<ReturnType<typeof open>>, mimeType: string, size: number): Promise<boolean> {
  if (mimeType === "image/png") return validPng(handle, size);
  if (mimeType === "image/jpeg") return validJpeg(handle, size);
  if (mimeType === "image/webp") return validWebp(handle, size);
  if (mimeType === "video/mp4") return validMp4(handle, size);
  return false;
}

/**
 * Download a completed media URL into a configured, pre-existing local directory.
 * Callers must provide a provider-specific URL policy validator; redirects and
 * ambient credentials remain disabled by the downloader.
 */
export async function downloadMediaFile(
  url: string,
  type: MediaType,
  signal: AbortSignal | undefined,
  options: MediaDownloadOptions,
): Promise<{ localPath: string; bytes: number; mimeType: string }> {
  const configuredDirectory = options.directory ?? process.env.WEB_AI_MEDIA_DIR;
  if (!configuredDirectory?.trim()) throw configurationError();
  if (type !== "image" && type !== "video") throw invalidResponse();
  const remote = options.validateUrl(url, type);
  const directory = await openVerifiedDirectory(configuredDirectory);
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, DOWNLOAD_TIMEOUT_MS);
  const id = randomUUID();
  const temporaryPath = join(directory.path, `.${id}.part`);
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryIdentity: { dev: number; ino: number } | undefined;
  let finalPath: string | undefined;
  let finalLinked = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let responseBody: ReadableStream<Uint8Array> | null = null;
  let size = 0;
  let bytes = Buffer.alloc(0);

  const throwIfAborted = () => {
    if (controller.signal.aborted) throw failureForAbort(timedOut);
  };

  try {
    throwIfAborted();
    await assertDirectoryStable(directory.path, directory.handle);
    const fileFlags = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    temporaryHandle = await open(temporaryPath, fileFlags, 0o600);
    const openedFile = await temporaryHandle.stat();
    temporaryIdentity = { dev: openedFile.dev, ino: openedFile.ino };
    await assertDirectoryStable(directory.path, directory.handle);

    const request = options.fetch ?? fetch;
    const response = await abortable(request(remote.href, {
      redirect: "error", credentials: "omit", signal: controller.signal,
    }), controller.signal);
    responseBody = response.body;
    if (!response.ok || !responseBody) throw downloadError();
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const format = formats[type].find(candidate => candidate.mimeType === mimeType);
    if (!format) throw invalidResponse();

    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      if (!/^\d+$/.test(declaredLength)) throw invalidResponse();
      const declaredSize = Number(declaredLength);
      if (!Number.isSafeInteger(declaredSize) || declaredSize > (type === "image" ? IMAGE_LIMIT : VIDEO_LIMIT)) throw invalidResponse();
    }

    reader = responseBody.getReader();
    while (true) {
      throwIfAborted();
      pendingRead = reader.read();
      const { done, value } = await abortable(pendingRead, controller.signal);
      pendingRead = undefined;
      if (done) break;
      if (!value?.byteLength) continue;
      size += value.byteLength;
      if (size > (type === "image" ? IMAGE_LIMIT : VIDEO_LIMIT)) throw invalidResponse();
      if (bytes.length < format.signatureLength) {
        const needed = format.signatureLength - bytes.length;
        bytes = Buffer.concat([bytes, Buffer.from(value.subarray(0, needed))]);
      }
      if (bytes.length >= format.signatureLength && !format.matches(bytes)) throw invalidResponse();
      await assertDirectoryStable(directory.path, directory.handle);
      throwIfAborted();
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await temporaryHandle.write(value, offset, value.byteLength - offset);
        if (!bytesWritten) throw downloadError();
        offset += bytesWritten;
      }
    }
    throwIfAborted();
    if (size < format.signatureLength || !format.matches(bytes)) throw invalidResponse();
    if (declaredLength !== null && Number(declaredLength) !== size) throw invalidResponse();
    if (!await validFile(temporaryHandle, format.mimeType, size)) throw invalidResponse();
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    await assertDirectoryStable(directory.path, directory.handle);
    finalPath = join(directory.path, `${id}.${format.extension}`);
    await link(temporaryPath, finalPath);
    finalLinked = true;
    throwIfAborted();
    await assertDirectoryStable(directory.path, directory.handle);
    await unlink(temporaryPath);
    temporaryIdentity = undefined;
    return { localPath: finalPath, bytes: size, mimeType: format.mimeType };
  } catch (error) {
    if (controller.signal.aborted) throw failureForAbort(timedOut);
    if (error instanceof ProviderError) {
      if (error.code === "download_configuration_error") throw configurationError();
      if (error.code === "invalid_response") throw invalidResponse();
    }
    throw downloadError();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
    if (reader) {
      void reader.cancel().catch(() => {});
      void pendingRead?.catch(() => {});
      try { reader.releaseLock(); } catch { /* A pending read owns the lock until its cancellation settles. */ }
    } else if (responseBody) void responseBody.cancel().catch(() => {});
    if (temporaryHandle) await temporaryHandle.close().catch(() => {});

    const cleanIfOwned = async (path: string, identity: { dev: number; ino: number } | undefined) => {
      if (!identity) return;
      try {
        await assertDirectoryStable(directory.path, directory.handle);
        const current = await lstat(path);
        if (!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await unlink(path);
      } catch { /* Preserve files if the configured directory changed during cleanup. */ }
    };
    await cleanIfOwned(temporaryPath, temporaryIdentity);
    if (finalLinked && finalPath) {
      try {
        await assertDirectoryStable(directory.path, directory.handle);
        const current = await lstat(finalPath);
        if (temporaryIdentity && current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) await unlink(finalPath);
      } catch { /* Preserve files if the configured directory changed during cleanup. */ }
    }
    await directory.handle.close().catch(() => {});
  }
}
