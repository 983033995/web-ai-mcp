import { test } from "node:test";
import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { downloadMediaFile, validateMediaDirectory } from "../src/providers/doubao/download.js";
import { ProviderError } from "../src/core/provider.js";

const imageUrl = "https://p5-flow-imagex-sign.byteimg.com/fixture.png?x-signature=fixture";
const videoUrl = "https://v11-vdl.doubao.com/fixture.mp4?fixture=1";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6N8AAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0,
  0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
  0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0, 0xff, 0xd9,
]);
const mp4Box = (kind: string, contents: Buffer) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(contents.length + 8, 0);
  header.write(kind, 4, 4, "ascii");
  return Buffer.concat([header, contents]);
};
const mp4ExtendedBox = (kind: string, contents: Buffer) => {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(kind, 4, 4, "ascii");
  header.writeBigUInt64BE(BigInt(contents.length + 16), 8);
  return Buffer.concat([header, contents]);
};
const mp4 = Buffer.concat([mp4ExtendedBox("ftyp", Buffer.from("isom\0\0\0\0", "binary")),
  mp4Box("moov", Buffer.from([1])), mp4Box("mdat", Buffer.from([2]))]);
const webpChunk = Buffer.alloc(10);
webpChunk.write("VP8 ", 0, 4, "ascii");
webpChunk.writeUInt32LE(1, 4);
webpChunk[8] = 1;
const webpHeader = Buffer.alloc(12);
webpHeader.write("RIFF", 0, 4, "ascii");
webpHeader.writeUInt32LE(14, 4);
webpHeader.write("WEBP", 8, 4, "ascii");
const webp = Buffer.concat([webpHeader, webpChunk]);

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(resolve(".validation-media-download-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function response(body: Buffer, contentType: string, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(body, { status, headers: { "content-type": contentType, ...extraHeaders } });
}

async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, error => error instanceof ProviderError && error.code === code);
}

test("downloads permitted images and video as private, MIME-derived files without credentials", async (t) => {
  const directory = await fixture(t);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const request: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return String(url) === imageUrl ? response(png, "image/png; charset=binary") : response(mp4, "video/mp4");
  };

  const image = await downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: request });
  const video = await downloadMediaFile(videoUrl, "video", undefined, { directory, fetch: request });
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.bytes, png.length);
  assert.match(image.localPath, /\.png$/);
  assert.deepEqual(await readFile(image.localPath), png);
  assert.equal(video.mimeType, "video/mp4");
  assert.match(video.localPath, /\.mp4$/);
  assert.deepEqual(await readFile(video.localPath), mp4);
  for (const info of [image, video]) assert.equal((await stat(info.localPath)).mode & 0o777, 0o600);
  assert.equal(requests.length, 2);
  for (const call of requests) {
    assert.equal(call.init?.redirect, "error");
    assert.equal(call.init?.credentials, "omit");
    assert.equal(call.init?.headers, undefined);
    assert.ok(call.init?.signal instanceof AbortSignal);
  }
});

test("checks WebP RIFF length and derives the WebP extension", async (t) => {
  const directory = await fixture(t);
  const downloaded = await downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: async () => response(webp, "image/webp") });
  assert.equal(downloaded.mimeType, "image/webp");
  assert.match(downloaded.localPath, /\.webp$/);
  assert.deepEqual(await readFile(downloaded.localPath), webp);
  const malformed = Buffer.from(webp);
  malformed.writeUInt32LE(15, 4);
  await rejectsCode(downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: async () => response(malformed, "image/webp") }),
    "invalid_response");
});

test("requires a configured valid directory before making a network request", async (t) => {
  const directory = await fixture(t);
  const previous = process.env.WEB_AI_MEDIA_DIR;
  delete process.env.WEB_AI_MEDIA_DIR;
  let calls = 0;
  try {
    await rejectsCode(downloadMediaFile(imageUrl, "image", undefined, { fetch: async () => { calls++; return response(png, "image/png"); } }),
      "download_configuration_error");
    await rejectsCode(downloadMediaFile(imageUrl, "image", undefined, { directory: "relative/path", fetch: async () => { calls++; return response(png, "image/png"); } }),
      "download_configuration_error");
    process.env.WEB_AI_MEDIA_DIR = directory;
    assert.equal(await validateMediaDirectory(), directory);
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env.WEB_AI_MEDIA_DIR;
    else process.env.WEB_AI_MEDIA_DIR = previous;
  }
});

test("rejects symlinked media directories and symlink path components", async (t) => {
  const directory = await fixture(t);
  const linkPath = `${directory}-link`;
  await symlink(directory, linkPath);
  t.after(() => rm(linkPath, { force: true }));
  await rejectsCode(validateMediaDirectory(linkPath), "download_configuration_error");
  await rejectsCode(validateMediaDirectory(join(linkPath, "child")), "download_configuration_error");
});

test("rejects a directory below a group/world-writable ancestor", async (t) => {
  const directory = await fixture(t);
  const writable = join(directory, "writable");
  const target = join(writable, "target");
  await mkdir(target, { recursive: true });
  await chmod(writable, 0o777);
  await rejectsCode(validateMediaDirectory(target), "download_configuration_error");
});

test("rejects untrusted hosts, sensitive query fields, redirects, MIME mismatches and invalid magic", async (t) => {
  const directory = await fixture(t);
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return response(png, "image/png"); };
  await rejectsCode(downloadMediaFile("https://attacker.invalid/image.png", "image", undefined, { directory, fetch: request }), "invalid_response");
  await rejectsCode(downloadMediaFile("https://p5-flow-imagex-sign.byteimg.com/a.png?sessionid=private", "image", undefined,
    { directory, fetch: request }), "invalid_response");
  assert.equal(calls, 0);

  await rejectsCode(downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: async (_url, init) => {
    assert.equal(init?.redirect, "error");
    return response(png, "image/png", 302, { location: "https://attacker.invalid/redirect" });
  } }), "download_error");
  await rejectsCode(downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: async () => response(png, "image/jpeg") }),
    "invalid_response");
  await rejectsCode(downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: async () => response(Buffer.from("not an image"), "image/png") }),
    "invalid_response");
  await rejectsCode(downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: async () => response(png.subarray(0, png.length - 12), "image/png") }),
    "invalid_response");
  await rejectsCode(downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: async () => response(Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xd9]), "image/jpeg") }),
    "invalid_response");
  const onlyFtyp = mp4Box("ftyp", Buffer.from("isom\0\0\0\0", "binary"));
  await rejectsCode(downloadMediaFile(videoUrl, "video", undefined, { directory, fetch: async () => response(onlyFtyp, "video/mp4") }),
    "invalid_response");
  assert.deepEqual(await readdir(directory), []);
});

test("rejects a truncated image when the response omits Content-Length", async (t) => {
  const directory = await fixture(t);
  const truncated = png.subarray(0, png.length - 12);
  await rejectsCode(downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: async () => new Response(truncated, {
    headers: { "content-type": "image/png" },
  }) }), "invalid_response");
  assert.deepEqual(await readdir(directory), []);
});

test("enforces image and video size limits from both headers and streamed bytes", async (t) => {
  const directory = await fixture(t);
  const neverRead = () => new ReadableStream<Uint8Array>({ pull() { throw new Error("oversized response should not be read"); } });
  await rejectsCode(downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: async () => new Response(neverRead(), {
    headers: { "content-type": "image/png", "content-length": String(20 * 1024 * 1024 + 1) },
  }) }), "invalid_response");
  await rejectsCode(downloadMediaFile(videoUrl, "video", undefined, { directory, fetch: async () => new Response(neverRead(), {
    headers: { "content-type": "video/mp4", "content-length": String(200 * 1024 * 1024 + 1) },
  }) }), "invalid_response");

  const tooLarge = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(20 * 1024 * 1024 + 1).fill(1));
  } });
  await rejectsCode(downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: async () => new Response(tooLarge, {
    headers: { "content-type": "image/png" },
  }) }), "invalid_response");
  assert.deepEqual(await readdir(directory), []);
});

test("cleans its partial file after a stream failure and never exposes the upstream URL", async (t) => {
  const directory = await fixture(t);
  const broken = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(png.subarray(0, 8));
    controller.error(new Error("secret URL: " + imageUrl));
  } });
  await assert.rejects(downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: async () => new Response(broken, {
    headers: { "content-type": "image/png" },
  }) }), error => error instanceof ProviderError && error.code === "download_error" && !error.message.includes(imageUrl));
  await assert.rejects(downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: async () => {
    throw new ProviderError("upstream diagnostic with URL " + imageUrl, "download_error");
  } }), error => error instanceof ProviderError && error.code === "download_error" && !error.message.includes(imageUrl));
  assert.deepEqual(await readdir(directory), []);
});

test("cancels an in-flight stream and removes its temporary file", { timeout: 2000 }, async (t) => {
  const directory = await fixture(t);
  const controller = new AbortController();
  let canceled = false;
  let onRead!: () => void;
  const startedReading = new Promise<void>(resolve => { onRead = resolve; });
  const pendingReader = {
    read: () => { onRead(); return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}); },
    cancel: () => { canceled = true; return new Promise<void>(() => {}); },
    releaseLock() {},
  };
  const responseBody = { getReader: () => pendingReader } as unknown as ReadableStream<Uint8Array>;
  const fakeResponse = { ok: true, body: responseBody, headers: new Headers({ "content-type": "image/png" }) } as Response;
  const pending = downloadMediaFile(imageUrl, "image", controller.signal, { directory, fetch: async () => fakeResponse });
  await startedReading;
  controller.abort();
  const completed = await Promise.race([
    rejectsCode(pending, "cancelled").then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250)),
  ]);
  assert.equal(completed, true, "a hanging stream cancellation must not hold the download open");
  assert.equal(canceled, true);
  assert.deepEqual(await readdir(directory), []);
});

test("uses unique names and does not overwrite pre-existing files", async (t) => {
  const directory = await fixture(t);
  const sentinelPath = join(directory, "keep.png");
  await writeFile(sentinelPath, "preserve");
  const request: typeof fetch = async () => response(jpeg, "image/jpeg");
  const first = await downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: request });
  const second = await downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: request });
  assert.notEqual(first.localPath, second.localPath);
  assert.match(first.localPath, /\.jpg$/);
  assert.deepEqual(await readFile(first.localPath), jpeg);
  assert.deepEqual(await readFile(second.localPath), jpeg);
  assert.equal(await readFile(sentinelPath, "utf8"), "preserve");
});

test("refuses a destination filename collision without replacing the existing file", async (t) => {
  const directory = await fixture(t);
  let collisionPath = "";
  await rejectsCode(downloadMediaFile(imageUrl, "image", undefined, { directory, fetch: async () => {
    const temporary = (await readdir(directory)).find(name => /^\.[0-9a-f-]+\.part$/.test(name));
    assert.ok(temporary);
    const id = temporary.slice(1, -".part".length);
    collisionPath = join(directory, `${id}.png`);
    await writeFile(collisionPath, "keep existing content", { flag: "wx" });
    return response(png, "image/png");
  } }), "download_error");
  assert.equal(await readFile(collisionPath, "utf8"), "keep existing content");
  assert.deepEqual(await readdir(directory), [basename(collisionPath)]);
});
