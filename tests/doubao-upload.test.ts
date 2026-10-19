import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { FileInput } from "../src/core/provider.js";
import { DoubaoUploader } from "../src/providers/doubao/upload.js";

const cookie = "sessionid=synthetic; passport_csrf_token=synthetic-csrf; s_v_web_id=synthetic-fp";
const chatUrl = new URL("http://127.0.0.1:8787/chat/completion?aid=497858&device_id=111&web_id=222&fp=synthetic-fp");
const officialChatUrl = new URL("https://www.doubao.com/chat/completion?aid=497858&device_id=111&web_id=222&fp=synthetic-fp");
const userAgent = "synthetic-test-agent";
const now = new Date("2026-10-14T00:00:00.000Z");
const token = { access_key: "test-access", secret_key: "test-secret", session_token: "test-session-token" };
const storeUri = "fixture/path/upload.txt";
const file: FileInput = { name: "fixture.txt", buffer: Buffer.from("Doubao upload fixture\n", "utf8") };

type Stage = "prepare" | "apply" | "storage" | "commit";
type Overrides = Partial<Record<Stage, () => Response>>;
interface Call { url: URL; init: RequestInit; headers: Headers }

// Fixed fixture vectors checked independently with Python's hashlib/hmac and zlib.
const expectedCrc = "8a954bf7";

function prepareResponse(): Response {
  return Response.json({ code: 0, msg: "", data: { service_id: "service-test", upload_host: "imagex.bytedanceapi.com",
    upload_auth_token: token } });
}

function applyResponse(host = "upload-1.vodupload.com", uri = storeUri): Response {
  return Response.json({ ResponseMetadata: { Action: "ApplyImageUpload", Version: "2018-08-01" }, Result: {
    UploadAddress: { StoreInfos: [{ StoreUri: uri, Auth: "store-auth" }], UploadHosts: [host], SessionKey: "session-key" }
  } });
}

function storageResponse(dataCrc = expectedCrc, code = 2000): Response {
  return Response.json({ code, data: { crc32: dataCrc }, message: "" });
}

function commitResponse(uri = storeUri, uriStatus: number | string = 2000): Response {
  return Response.json({ ResponseMetadata: { Action: "CommitImageUpload", Version: "2018-08-01" },
    Result: { Results: [{ Uri: uri, UriStatus: uriStatus }] } });
}

function harness(overrides: Overrides = {}, uploadHost = "127.0.0.1", baseChatUrl = chatUrl) {
  const calls: Call[] = [];
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(input instanceof URL ? input.href : String(input));
    const call = { url, init, headers: new Headers(init.headers) };
    calls.push(call);
    const action = url.searchParams.get("Action");
    let stage: Stage;
    if (url.pathname === "/alice/resource/prepare_upload") stage = "prepare";
    else if (action === "ApplyImageUpload") stage = "apply";
    else if (action === "CommitImageUpload") stage = "commit";
    else if (url.pathname.startsWith("/upload/v1/")) stage = "storage";
    else throw new Error("Unexpected URL in deterministic upload fixture");
    if (overrides[stage]) return overrides[stage]!();
    if (stage === "prepare") return prepareResponse();
    if (stage === "apply") return applyResponse(uploadHost);
    if (stage === "storage") return storageResponse();
    return commitResponse();
  };
  const uploader = new DoubaoUploader(cookie, { chatUrl: baseChatUrl, userAgent, fetch: request, now: () => now, nonce: () => "fixture-nonce" });
  return { uploader, calls };
}


test("Doubao upload prepares, signs, uploads bytes without Cookie, verifies CRC and commits URI", async () => {
  const { uploader, calls } = harness({}, "upload-1.vodupload.com", officialChatUrl);
  const attachment = await uploader.upload(file, new AbortController().signal);

  assert.deepEqual(calls.map(({ url }) => url.pathname), [
    "/alice/resource/prepare_upload", "/top/v1", "/upload/v1/fixture/path/upload.txt", "/top/v1"
  ]);
  const prepare = calls[0]!;
  assert.equal(prepare.url.origin, officialChatUrl.origin);
  assert.deepEqual([...prepare.url.searchParams], [...officialChatUrl.searchParams]);
  assert.equal(prepare.headers.get("cookie"), cookie);
  assert.deepEqual(JSON.parse(String(prepare.init.body)), { tenant_id: "5", scene_id: "5", resource_type: 1 });

  const apply = calls[1]!;
  assert.equal(apply.url.origin, officialChatUrl.origin);
  assert.equal(apply.url.searchParams.get("Action"), "ApplyImageUpload");
  assert.equal(apply.url.searchParams.get("Version"), "2018-08-01");
  assert.equal(apply.url.searchParams.get("ServiceId"), "service-test");
  assert.equal(apply.url.searchParams.get("NeedFallback"), "true");
  assert.equal(apply.url.searchParams.get("FileSize"), String(file.buffer.length));
  assert.equal(apply.url.searchParams.get("FileExtension"), ".txt");
  assert.equal(apply.headers.get("x-amz-date"), "20261014T000000Z");
  assert.equal(apply.headers.get("x-amz-security-token"), token.session_token);
  assert.equal(apply.headers.get("authorization"), "AWS4-HMAC-SHA256 Credential=test-access/20261014/cn-north-1/imagex/aws4_request, SignedHeaders=x-amz-date;x-amz-security-token, Signature=c527c9d361967f39e3303b20eded8e7864cc083ab956d36a624f2869d7cf4add");

  const storage = calls[2]!;
  assert.equal(storage.url.origin, "https://upload-1.vodupload.com");
  assert.equal(storage.headers.get("cookie"), null);
  assert.equal(storage.headers.get("content-crc32"), expectedCrc);
  assert.equal(storage.headers.get("authorization"), "store-auth");
  assert.deepEqual(Buffer.from(storage.init.body as Uint8Array), file.buffer);
  assert.equal(storage.init.redirect, "error");

  const commit = calls[3]!;
  const commitBody = String(commit.init.body);
  assert.deepEqual(JSON.parse(commitBody), { SessionKey: "session-key" });
  assert.equal(commit.headers.get("x-amz-content-sha256"), createHash("sha256").update(commitBody).digest("hex"));
  assert.equal(commit.headers.get("authorization"), "AWS4-HMAC-SHA256 Credential=test-access/20261014/cn-north-1/imagex/aws4_request, SignedHeaders=x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=9bfd5e7804366378d451e863e59f3ef9e696ad4cf09626cc3f786506137716b7");
  assert.equal(commit.headers.get("cookie"), cookie);
  assert.deepEqual(attachment, {
    type: 3,
    identifier: attachment.identifier,
    file: { uri: storeUri, url: "", file_type: 0, name: file.name, size: file.buffer.length },
    parse_state: 1,
    review_state: 1,
    upload_status: 1,
    progress: 100,
    src: ""
  });
  assert.match(attachment.identifier, /^[0-9a-f-]{36}$/i);
});

test("Doubao permits only a same-origin loopback storage fixture and never follows redirects", async () => {
  const sameOrigin = harness({}, "127.0.0.1");
  await sameOrigin.uploader.upload(file, new AbortController().signal);
  assert.equal(sameOrigin.calls[2]!.url.origin, chatUrl.origin);
  assert.equal(sameOrigin.calls[2]!.headers.get("cookie"), null);

  const denied = harness({}, "evil.example");
  await assert.rejects(denied.uploader.upload(file, new AbortController().signal),
    (error: any) => error.code === "invalid_response" && error.sessionUncertain === false);
  assert.equal(denied.calls.some(({ url }) => url.pathname.startsWith("/upload/v1/")), false);

  const redirected = harness({ prepare: () => new Response("redirect", { status: 302, headers: { Location: "https://evil.example/" } }) });
  await assert.rejects(redirected.uploader.upload(file, new AbortController().signal),
    (error: any) => error.code === "http_error" && error.sessionUncertain === false);
  assert.equal(redirected.calls.length, 1);
  assert.equal(redirected.calls[0]!.init.redirect, "error");
});

test("Doubao accepts official regional storage nodes and encodes non-ASCII filenames", async () => {
  const regional = harness({}, "tos-d-x-lf.snssdk.com", officialChatUrl);
  const name = "样本.txt";
  const attachment = await regional.uploader.upload({ name, buffer: file.buffer }, new AbortController().signal);
  assert.equal(attachment.file.name, name);
  assert.equal(regional.calls[2].url.hostname, "tos-d-x-lf.snssdk.com");
  assert.match(regional.calls[2].headers.get("content-disposition")!, /filename\*=UTF-8''%E6%A0%B7%E6%9C%AC\.txt/);
  const alternate = harness({}, "tos-d-x-lf.douyin.com", officialChatUrl);
  await alternate.uploader.upload(file, new AbortController().signal);
  assert.equal(alternate.calls[2].url.hostname, "tos-d-x-lf.douyin.com");
  assert.equal(alternate.calls[2].headers.get("cookie"), null);
  for (const host of ["tos-d-x-lf.snssdk.com.evil.test", "tos-d-x-lf.douyin.com.evil.test", "https://tos-d-x-lf.snssdk.com", "127.0.0.1"]) {
    const rejected = harness({}, host, officialChatUrl);
    await assert.rejects(rejected.uploader.upload(file, new AbortController().signal));
    assert.equal(rejected.calls.length, 2);
  }
});

test("Doubao fails closed on invalid allocation URI, unsafe filenames and non-text types", async () => {
  const badUri = harness({ apply: () => applyResponse("upload-1.vodupload.com", "../escape.txt") });
  await assert.rejects(badUri.uploader.upload(file, new AbortController().signal), (error: any) => error.code === "invalid_response");
  assert.equal(badUri.calls.some(({ url }) => url.pathname.startsWith("/upload/v1/")), false);

  const { uploader, calls } = harness();
  for (const name of ["../escape.txt", "folder/file.txt", "file.pdf", "bad\r\nname.txt"]) {
    await assert.rejects(uploader.upload({ name, buffer: Buffer.from("data") }, new AbortController().signal),
      (error: any) => error.code === "invalid_file" && error.sessionUncertain === false);
  }
  await assert.rejects(uploader.upload({ name: "empty.txt", buffer: Buffer.alloc(0) }, new AbortController().signal),
    (error: any) => error.code === "invalid_file");
  await assert.rejects(uploader.upload({ name: "large.txt", buffer: Buffer.alloc(10 * 1024 * 1024 + 1) }, new AbortController().signal),
    (error: any) => error.code === "invalid_file");
  assert.equal(calls.length, 0);
});

test("Doubao rejects business failures and verifies storage CRC and commit URI", async () => {
  for (const response of [Response.json({ code: 710022004, msg: "challenge" }), Response.json({ code: 123, msg: "private upstream details" })]) {
    const failed = harness({ prepare: () => response.clone() });
    await assert.rejects(failed.uploader.upload(file, new AbortController().signal), (error: any) =>
      ["captcha_required", "website_error"].includes(error.code) && error.sessionUncertain === false &&
      !error.message.includes("private upstream details"));
    assert.equal(failed.calls.length, 1);
  }

  const badCrc = harness({ storage: () => storageResponse("00000000") });
  await assert.rejects(badCrc.uploader.upload(file, new AbortController().signal),
    (error: any) => error.code === "upload_integrity_error" && error.sessionUncertain === false);
  assert.equal(badCrc.calls.length, 3);

  const badCommit = harness({ commit: () => commitResponse("wrong-uri") });
  await assert.rejects(badCommit.uploader.upload(file, new AbortController().signal),
    (error: any) => error.code === "upload_commit_error" && error.sessionUncertain === false);
  assert.equal(badCommit.calls.length, 4);
});

test("Doubao aborts oversized or stalled response reads without retry", async () => {
  const oversized = harness({ prepare: () => new Response(JSON.stringify({ code: 0, data: { huge: "x".repeat(300 * 1024) } })) });
  await assert.rejects(oversized.uploader.upload(file, new AbortController().signal),
    (error: any) => error.code === "invalid_response" && error.sessionUncertain === false);
  assert.equal(oversized.calls.length, 1);

  const controller = new AbortController();
  const stalled = harness({ prepare: () => new Response(new ReadableStream<Uint8Array>({ start() {} })) });
  const pending = stalled.uploader.upload(file, controller.signal);
  setTimeout(() => controller.abort(new Error("fixture timeout")), 10);
  await assert.rejects(pending, (error: any) => error.code === "cancelled" && error.sessionUncertain === false);
  assert.equal(stalled.calls.length, 1);
});
