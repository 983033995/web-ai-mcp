import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError, type FileInput } from "../src/core/provider.js";
import { uploadGeminiFiles, type GeminiUploadedFile } from "../src/providers/gemini/upload.js";

function file(name: string, buffer: Buffer): FileInput { return { name, buffer }; }

function pngFixture(): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(2, 16);
  buffer.writeUInt32BE(3, 20);
  return buffer;
}

function webpFixture(): Buffer {
  const buffer = Buffer.alloc(16);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(8, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8 ", 12, "ascii");
  return buffer;
}

function mp4Fixture(): Buffer {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32BE(16, 0);
  buffer.write("ftyp", 4, "ascii");
  buffer.write("isom", 8, "ascii");
  return buffer;
}

const options = (fetch: typeof globalThis.fetch, extra: { signal?: AbortSignal; timeoutMs?: number } = {}) => ({
  userAgent: "Fixture Browser/1.0", fetch, ...extra,
});

test("uploads supported files in order with observed multipart fields and returns only ephemeral descriptors", async () => {
  const inputs = [
    file("notes.txt", Buffer.from("plain UTF-8 notes\n", "utf8")),
    file("image.png", pngFixture()),
    file("photo.jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    file("preview.webp", webpFixture()),
    file("clip.mp4", mp4Fixture()),
  ];
  const observed: Array<{ url: string; method: string | undefined; headers: Headers; credentials: RequestCredentials | undefined; redirect: RequestRedirect | undefined; name: string; mime: string; bytes: Buffer }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const form = init?.body as FormData;
    const part = form.get("file") as Blob & { name?: string };
    observed.push({
      url: String(input), method: init?.method, headers: new Headers(init?.headers), credentials: init?.credentials,
      redirect: init?.redirect, name: part.name ?? "", mime: part.type, bytes: Buffer.from(await part.arrayBuffer()),
    });
    return new Response(`/contrib_service/ttl_1d/upload-${observed.length}`, { status: 200 });
  };

  const result: GeminiUploadedFile[] = await uploadGeminiFiles(inputs, options(mockFetch));
  assert.deepEqual(result, inputs.map((input, index) => ({
    uploadId: `/contrib_service/ttl_1d/upload-${index + 1}`,
    filename: input.name,
    mimeType: ["text/plain", "image/png", "image/jpeg", "image/webp", "video/mp4"][index],
  })));
  assert.equal(observed.length, inputs.length);
  for (const [index, request] of observed.entries()) {
    assert.equal(request.url, "https://content-push.googleapis.com/upload");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("origin"), "https://gemini.google.com");
    assert.equal(request.headers.get("referer"), "https://gemini.google.com/");
    assert.equal(request.headers.get("x-tenant-id"), "bard-storage");
    assert.equal(request.headers.get("push-id"), "feeds/mcudyrk2a4khkz");
    assert.equal(request.headers.get("user-agent"), "Fixture Browser/1.0");
    assert.equal(request.headers.has("cookie"), false);
    assert.equal(request.credentials, "omit");
    assert.equal(request.redirect, "manual");
    assert.equal(request.name, inputs[index].name);
    assert.equal(request.mime, result[index].mimeType);
    assert.deepEqual(request.bytes, inputs[index].buffer);
  }
});

test("validates every in-memory file before making any upload request", async () => {
  let calls = 0;
  const mockFetch: typeof fetch = async () => { calls++; return new Response("/contrib_service/ttl_1d/id"); };
  const validText = file("ok.txt", Buffer.from("ok", "utf8"));
  const invalidInputs: FileInput[][] = [
    [],
    Array.from({ length: 6 }, (_, index) => file(`file-${index}.txt`, Buffer.from("x"))),
    [validText, file("bad.png", Buffer.from("not a PNG"))],
    [file("bad.txt", Buffer.from([0xff, 0xfe]))],
    [file("bad.mp4", Buffer.from("not an MP4"))],
    [file("bad/name.txt", Buffer.from("path"))],
    [file("empty.txt", Buffer.alloc(0))],
    [file("big.txt", Buffer.alloc(10 * 1024 * 1024 + 1, 0x61))],
    [file("one.txt", Buffer.alloc(10 * 1024 * 1024, 0x61)), file("two.txt", Buffer.alloc(10 * 1024 * 1024, 0x61)), file("three.txt", Buffer.from("x"))],
  ];
  for (const invalid of invalidInputs) {
    await assert.rejects(uploadGeminiFiles(invalid, options(mockFetch)), error =>
      error instanceof ProviderError && error.code === "invalid_file");
  }
  assert.equal(calls, 0);
});

test("blocks redirects and rejects non-success or non-identifier responses without leaking response data", async () => {
  const secret = "https://redirect-canary.example/path?cookie=upload-secret";
  for (const response of [
    new Response(null, { status: 302, headers: { Location: secret } }),
    new Response("private error body upload-secret", { status: 403 }),
    new Response("<html>login page</html>", { status: 200 }),
    new Response("not a file reference", { status: 200 }),
  ]) {
    let calls = 0;
    const mockFetch: typeof fetch = async (_input, init) => {
      calls++;
      assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).has("cookie"), false);
      return response;
    };
    await assert.rejects(uploadGeminiFiles([file("notes.txt", Buffer.from("safe"))], options(mockFetch)), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes("upload-secret"), false);
      assert.equal(error.message.includes("login"), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("rejects oversized upload responses and a later failed file returns no partial descriptor list", async () => {
  const oversized: typeof fetch = async () => new Response("x".repeat(64 * 1024 + 1));
  await assert.rejects(uploadGeminiFiles([file("notes.txt", Buffer.from("safe"))], options(oversized)), error =>
    error instanceof ProviderError && error.code === "invalid_response");

  let calls = 0;
  const secondFails: typeof fetch = async () => {
    calls++;
    return calls === 1 ? new Response("/contrib_service/ttl_1d/first") : new Response("error", { status: 500 });
  };
  await assert.rejects(uploadGeminiFiles([
    file("one.txt", Buffer.from("one")), file("two.txt", Buffer.from("two")),
  ], options(secondFails)), error => error instanceof ProviderError && error.code === "file_upload_error");
  assert.equal(calls, 2);
});

test("cancellation and timeout abort upload without retry", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  let calls = 0;
  const unused: typeof fetch = async () => { calls++; return new Response("/contrib_service/ttl_1d/id"); };
  await assert.rejects(uploadGeminiFiles([file("notes.txt", Buffer.from("safe"))], options(unused, { signal: cancelled.signal })), error =>
    error instanceof ProviderError && error.code === "cancelled");
  assert.equal(calls, 0);

  const pending: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  await assert.rejects(uploadGeminiFiles([file("notes.txt", Buffer.from("safe"))], options(pending, { timeoutMs: 10 })), error =>
    error instanceof ProviderError && error.code === "timeout_error");
});

test("cancellation during a stalled upload response body releases the stream", async () => {
  const controller = new AbortController();
  let streamCancelled = false;
  const mockFetch: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new TextEncoder().encode("/contrib_service/")); },
    cancel() { streamCancelled = true; },
  }));
  const pending = uploadGeminiFiles([file("notes.txt", Buffer.from("safe"))], options(mockFetch, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, error => error instanceof ProviderError && error.code === "cancelled");
  assert.equal(streamCancelled, true);
});
