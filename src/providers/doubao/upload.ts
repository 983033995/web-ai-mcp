import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { FileInput } from "../../core/provider.js";
import { businessError, DoubaoWebError, httpError } from "./errors.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_STORAGE_RESPONSE_BYTES = 64 * 1024;
const IMAGE_VERSION = "2018-08-01";
const AWS_REGION = "cn-north-1";
const AWS_SERVICE = "imagex";
const PREPARE_BODY = { tenant_id: "5", scene_id: "5", resource_type: 1 } as const;

export interface DoubaoUploaderOptions {
  chatUrl: URL;
  userAgent: string;
  fetch?: typeof fetch;
  /** Injectable clock for deterministic SigV4 tests. */
  now?: () => Date;
  nonce?: () => string;
}

export interface DoubaoAttachment {
  type: 3;
  identifier: string;
  file: { uri: string; url: ""; file_type: 0; name: string; size: number };
  parse_state: 1;
  review_state: 1;
  upload_status: 1;
  progress: 100;
  src: "";
}

interface UploadToken {
  access_key: string;
  secret_key: string;
  session_token: string;
}

interface UploadAllocation {
  host: string;
  storeUri: string;
  auth: string;
  sessionKey: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const configurationError = () => new DoubaoWebError("configuration_error",
  "Doubao file upload requires this account's chat URL, Cookie and User-Agent");

function loopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

function officialStorageHost(host: string): boolean {
  return /^tos-[a-z0-9-]+\.(snssdk|douyin)\.com$/i.test(host) || /^[a-z0-9-]+\.vodupload\.com$/i.test(host);
}

function safeFileName(file: FileInput): void {
  if (!file || typeof file.name !== "string" || !Buffer.isBuffer(file.buffer)) {
    throw new DoubaoWebError("invalid_file", "Expected a buffered .txt file");
  }
  if (!file.buffer.length) throw new DoubaoWebError("invalid_file", "Empty files cannot be uploaded");
  if (file.buffer.length > MAX_FILE_BYTES) throw new DoubaoWebError("invalid_file", "Doubao .txt files are limited to 10 MiB");
  if (Buffer.byteLength(file.name, "utf8") > 255 || !/^[\p{L}\p{N}][\p{L}\p{N}._ -]*\.txt$/iu.test(file.name) ||
      file.name.includes("..")) {
    throw new DoubaoWebError("invalid_file", "Use a safe .txt filename without path separators");
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function signImageRequest(url: URL, method: "GET" | "POST", body: string, token: UploadToken, now: Date): Record<string, string> {
  if (url.pathname !== "/top/v1" || !Number.isFinite(now.getTime())) {
    throw new DoubaoWebError("configuration_error", "Invalid Doubao image upload signing parameters");
  }
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = stamp.slice(0, 8);
  const payloadHash = sha256(body);
  const signedHeaders: Record<string, string> = {
    "x-amz-date": stamp,
    "x-amz-security-token": token.session_token
  };
  if (method === "POST") signedHeaders["x-amz-content-sha256"] = payloadHash;
  const names = Object.keys(signedHeaders).sort();
  const canonicalHeaders = names.map((name) => `${name}:${signedHeaders[name]!.trim()}\n`).join("");
  const canonicalRequest = [method, url.pathname, canonicalQuery(url), canonicalHeaders, names.join(";"), payloadHash].join("\n");
  const scope = `${date}/${AWS_REGION}/${AWS_SERVICE}/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${token.secret_key}`, date), AWS_REGION), AWS_SERVICE), "aws4_request");
  const signature = createHmac("sha256", signingKey)
    .update(["AWS4-HMAC-SHA256", stamp, scope, sha256(canonicalRequest)].join("\n"))
    .digest("hex");
  return {
    ...signedHeaders,
    Authorization: `AWS4-HMAC-SHA256 Credential=${token.access_key}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`
  };
}

function crc32(buffer: Buffer): string {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

function fieldString(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);
}

function safeStoreUri(value: unknown): value is string {
  if (!fieldString(value, 2048)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && /^[A-Za-z0-9._~-]+$/.test(part));
}

function responseError(value: unknown): DoubaoWebError | undefined {
  const storageSuccess = isRecord(value) && value.code === 2000;
  const mapped = storageSuccess ? undefined : businessError(value, false);
  if (mapped) return new DoubaoWebError(mapped.code, mapped.message, false);
  if (!isRecord(value)) return undefined;
  const metadata = isRecord(value.ResponseMetadata) ? value.ResponseMetadata : undefined;
  if (metadata?.Error || value.error || value.Error) {
    return new DoubaoWebError("website_error", "Doubao Web rejected the file upload request", false);
  }
  return undefined;
}

function statusError(status: number): DoubaoWebError {
  const mapped = httpError(status);
  return new DoubaoWebError(mapped.code, mapped.message, false);
}

export class DoubaoUploader {
  private readonly request: typeof fetch;
  private readonly url: URL;
  private readonly cookie: string;
  private readonly userAgent: string;
  private readonly now: () => Date;
  private readonly nonce: () => string;
  private readonly referer: string;

  constructor(cookie: string, options: DoubaoUploaderOptions) {
    if (typeof cookie !== "string" || !options || !(options.chatUrl instanceof URL) || !cookie.trim() || /[\r\n]/.test(cookie) ||
        typeof options.userAgent !== "string" || !options.userAgent.trim() || /[\r\n]/.test(options.userAgent)) throw configurationError();
    const chatUrl = new URL(options.chatUrl);
    const website = chatUrl.origin === "https://www.doubao.com";
    const local = chatUrl.protocol === "http:" && loopback(chatUrl.hostname);
    if ((!website && !local) || chatUrl.pathname !== "/chat/completion" || chatUrl.username || chatUrl.password || chatUrl.hash ||
        [...chatUrl.searchParams.keys()].some((key) => /cookie|sessionid|csrf/i.test(key))) throw configurationError();
    this.url = chatUrl;
    this.cookie = cookie.trim();
    this.userAgent = options.userAgent.trim();
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? (() => randomBytes(12).toString("hex"));
    this.referer = `${chatUrl.origin}/chat`;
  }

  async upload(file: FileInput, signal: AbortSignal): Promise<DoubaoAttachment> {
    safeFileName(file);
    if (!signal || typeof signal.throwIfAborted !== "function") throw new DoubaoWebError("invalid_request", "An upload AbortSignal is required");
    try {
      signal.throwIfAborted();
      const grant = await this.prepare(signal);
      const allocation = await this.allocate(file, grant.serviceId, grant.token, signal);
      await this.sendBytes(file, allocation, signal);
      await this.commit(allocation, grant.serviceId, grant.token, signal);
      return {
        type: 3,
        identifier: randomUUID(),
        file: { uri: allocation.storeUri, url: "", file_type: 0, name: file.name, size: file.buffer.length },
        parse_state: 1,
        review_state: 1,
        upload_status: 1,
        progress: 100,
        src: ""
      };
    } catch (error) {
      if (signal.aborted) throw new DoubaoWebError("cancelled", "Doubao file upload cancelled", false);
      if (error instanceof DoubaoWebError) throw error;
      throw new DoubaoWebError("network_error", "Doubao file upload failed; no automatic retry was performed", false);
    }
  }

  private async prepare(signal: AbortSignal): Promise<{ serviceId: string; token: UploadToken }> {
    const url = new URL(this.url);
    url.pathname = "/alice/resource/prepare_upload";
    const value = await this.requestJson(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: this.cookie,
        "User-Agent": this.userAgent,
        Origin: this.url.origin,
        Referer: this.referer,
        "Agw-Js-Conv": "str"
      },
      body: JSON.stringify(PREPARE_BODY)
    }, signal, MAX_JSON_BYTES);
    if (!isRecord(value) || !isRecord(value.data) || !fieldString(value.data.service_id, 256) || !isRecord(value.data.upload_auth_token)) {
      throw new DoubaoWebError("invalid_response", "Doubao did not return valid upload authorization", false);
    }
    const raw = value.data.upload_auth_token;
    if (!fieldString(raw.access_key, 512) || !fieldString(raw.secret_key, 512) || !fieldString(raw.session_token, 4096)) {
      throw new DoubaoWebError("invalid_response", "Doubao returned incomplete upload authorization", false);
    }
    return { serviceId: value.data.service_id, token: {
      access_key: raw.access_key, secret_key: raw.secret_key, session_token: raw.session_token
    } };
  }

  private async allocate(file: FileInput, serviceId: string, token: UploadToken, signal: AbortSignal): Promise<UploadAllocation> {
    const url = new URL("/top/v1", this.url.origin);
    url.searchParams.set("Action", "ApplyImageUpload");
    url.searchParams.set("Version", IMAGE_VERSION);
    url.searchParams.set("ServiceId", serviceId);
    url.searchParams.set("NeedFallback", "true");
    url.searchParams.set("FileSize", String(file.buffer.length));
    url.searchParams.set("FileExtension", ".txt");
    url.searchParams.set("s", this.nonce());
    const value = await this.requestJson(url, {
      method: "GET",
      headers: {
        ...signImageRequest(url, "GET", "", token, this.now()),
        Accept: "application/json",
        Cookie: this.cookie,
        "User-Agent": this.userAgent,
        Origin: this.url.origin,
        Referer: this.referer
      }
    }, signal, MAX_JSON_BYTES);
    const result = isRecord(value) && isRecord(value.Result) ? value.Result : undefined;
    const address = result && isRecord(result.UploadAddress) ? result.UploadAddress : undefined;
    const stores = address && Array.isArray(address.StoreInfos) ? address.StoreInfos : undefined;
    const store = stores?.[0];
    const hosts = address && Array.isArray(address.UploadHosts) ? address.UploadHosts : undefined;
    const host = hosts?.[0];
    if (!isRecord(address) || !isRecord(store) || !fieldString(store.Auth, 4096) || !safeStoreUri(store.StoreUri) ||
        !fieldString(address.SessionKey, 4096) || typeof host !== "string" || !this.allowedStorageHost(host)) {
      throw new DoubaoWebError("invalid_response", "Doubao returned invalid file upload allocation", false);
    }
    return { host, storeUri: store.StoreUri, auth: store.Auth, sessionKey: address.SessionKey };
  }

  private allowedStorageHost(host: string): boolean {
    if (loopback(this.url.hostname)) return host === this.url.hostname;
    return officialStorageHost(host);
  }

  private async sendBytes(file: FileInput, allocation: UploadAllocation, signal: AbortSignal): Promise<void> {
    const target = loopback(this.url.hostname)
      ? new URL(`/upload/v1/${allocation.storeUri}`, this.url.origin)
      : new URL(`/upload/v1/${allocation.storeUri}`, `https://${allocation.host}`);
    const expectedCrc = crc32(file.buffer);
    const response = await this.fetch(target, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: allocation.auth,
        "Content-Type": "application/octet-stream",
        "Content-CRC32": expectedCrc,
        "Content-Disposition": `attachment; filename="upload.txt"; filename*=UTF-8''${awsEncode(file.name)}`,
        Origin: this.url.origin,
        Referer: this.referer,
        "User-Agent": this.userAgent
      },
      body: new Uint8Array(file.buffer)
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw statusError(response.status);
    }
    const payload = await this.readJson(response, signal, MAX_STORAGE_RESPONSE_BYTES);
    const error = responseError(payload);
    if (error) throw error;
    const value = isRecord(payload) ? payload : undefined;
    const data = value && isRecord(value.data) ? value.data : undefined;
    if (value?.code !== 2000 || !fieldString(data?.crc32, 64) || data.crc32.toLowerCase() !== expectedCrc) {
      throw new DoubaoWebError("upload_integrity_error", "Doubao file storage did not confirm the uploaded bytes", false);
    }
  }

  private async commit(allocation: UploadAllocation, serviceId: string, token: UploadToken, signal: AbortSignal): Promise<void> {
    const url = new URL("/top/v1", this.url.origin);
    url.searchParams.set("Action", "CommitImageUpload");
    url.searchParams.set("Version", IMAGE_VERSION);
    url.searchParams.set("ServiceId", serviceId);
    const body = JSON.stringify({ SessionKey: allocation.sessionKey });
    const value = await this.requestJson(url, {
      method: "POST",
      headers: {
        ...signImageRequest(url, "POST", body, token, this.now()),
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: this.cookie,
        "User-Agent": this.userAgent,
        Origin: this.url.origin,
        Referer: this.referer
      },
      body
    }, signal, MAX_JSON_BYTES);
    const result = isRecord(value) && isRecord(value.Result) ? value.Result : undefined;
    const results = result && Array.isArray(result.Results) ? result.Results : undefined;
    const committed = results?.some((entry) => isRecord(entry) && entry.Uri === allocation.storeUri &&
      (entry.UriStatus === 2000 || entry.UriStatus === "2000"));
    if (!committed) throw new DoubaoWebError("upload_commit_error", "Doubao did not confirm the uploaded file", false);
  }

  private async requestJson(url: URL, init: RequestInit, signal: AbortSignal, maxBytes: number): Promise<unknown> {
    const response = await this.fetch(url, { ...init, redirect: "error", signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw statusError(response.status);
    }
    const value = await this.readJson(response, signal, maxBytes);
    const error = responseError(value);
    if (error) throw error;
    return value;
  }

  private async fetch(url: URL, init: RequestInit): Promise<Response> {
    if (url.origin !== this.url.origin && !this.isAllowedStorageOrigin(url)) {
      throw new DoubaoWebError("access_denied", "Doubao file upload target is outside the approved domains", false);
    }
    return this.request(url, init);
  }

  private isAllowedStorageOrigin(url: URL): boolean {
    if (loopback(this.url.hostname)) return url.origin === this.url.origin;
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    return officialStorageHost(url.hostname);
  }

  private async readJson(response: Response, signal: AbortSignal, limit: number): Promise<unknown> {
    if (!response.body) throw new DoubaoWebError("invalid_response", "Empty Doubao upload response", false);
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    let size = 0;
    let text = "";
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new DoubaoWebError("invalid_response", "Oversized Doubao upload response", false);
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      try { return JSON.parse(text) as unknown; } catch {
        throw new DoubaoWebError("invalid_response", "Invalid Doubao upload JSON response", false);
      }
    } catch (error) {
      if (error instanceof DoubaoWebError || signal.aborted) throw error;
      throw new DoubaoWebError("invalid_response", "Could not read Doubao upload response", false);
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
