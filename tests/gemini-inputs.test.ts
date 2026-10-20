import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaGenerationRequest } from "../src/core/provider.js";
import { GeminiAccountProvider, GeminiCooldownStore } from "../src/providers/gemini/cooldown.js";
import { GeminiWebProvider } from "../src/providers/gemini/index.js";
import { GeminiWebClient } from "../src/providers/gemini/web-client.js";
import type { GeminiAccountConfig } from "../src/providers/gemini/accounts.js";
import { applyGeminiMediaControls } from "../src/providers/gemini/media.js";

const userAgent = "Fixture browser/1.0";
const html = `<script>window.context={"SNlM0e":"request-token","cfb2h":"build-fixture","FdrFJe":"session-fixture","oPEP7c":"fixture@example.test"};</script>`;
const modelId = "a1b2c3d4e5f60718";

function account(id: string): GeminiAccountConfig {
  return { id, cookie: `__Secure-1PSID=${id}-own-account`, userAgent };
}

function modelBody(status: number | null = null, displayName = "3.8 Flash", modelNumber = 2, tierFlags = [8, 0, 38]): unknown[] {
  const model: unknown[] = [];
  model[0] = modelId;
  model[1] = "Flash";
  model[2] = "Fixture model description";
  model[9] = modelNumber;
  model[10] = "Flash";
  model[11] = displayName;
  model[12] = "Fixture model description";
  model[17] = modelNumber;
  const body: unknown[] = [];
  body[14] = status;
  body[15] = [model];
  body[16] = tierFlags;
  body[17] = [];
  return body;
}

function framedResponse(value: unknown, terminal: unknown = ["di", 1]): Response {
  const rpc = JSON.stringify([value]);
  const end = JSON.stringify([terminal]);
  const frame = (json: string) => `${json.length + 2}\n${json}\n`;
  return new Response(`)]}'\n${frame(rpc)}${frame(end)}`, { headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function modelResponse(status: number | null = null, displayName = "3.8 Flash", modelNumber = 2, tierFlags = [8, 0, 38]): Response {
  return framedResponse(["wrb.fr", "otAQ7b", JSON.stringify(modelBody(status, displayName, modelNumber, tierFlags)), null, null, null]);
}

function successStream(options: { conversationId?: string; replyId?: string; candidateId?: string; text?: string } = {}): Response {
  const candidate: unknown[] = Array(13).fill(null);
  candidate[0] = options.candidateId ?? "rc_answer";
  candidate[1] = [options.text ?? "fixture answer"];
  candidate[8] = [2];
  const record: unknown[] = Array(26).fill(null);
  record[1] = [options.conversationId ?? "c_conversation", options.replyId ?? "r_reply"];
  record[4] = [candidate];
  return framedResponse(["wrb.fr", null, JSON.stringify(record)]);
}

function quotaStream(): Response {
  const empty = JSON.stringify(Array(26).fill(null));
  const part = ["wrb.fr", null, empty, null, null, [null, null, [[null, [1037]]]]];
  return new Response(`)]}'\n${JSON.stringify([part])}\ndi`, { headers: { "Content-Type": "application/json" } });
}

function quotaResponse(): Response {
  return framedResponse(["wrb.fr", "aPya6c", JSON.stringify([false, 0, null]), null, null, null]);
}

function formPayload(init?: RequestInit): { payload: unknown[]; at: string } {
  const form = new URLSearchParams(String(init?.body));
  const request = JSON.parse(form.get("f.req")!);
  return { at: form.get("at")!, payload: JSON.parse(request[1]) };
}

function pngFile() {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(2, 16);
  buffer.writeUInt32BE(3, 20);
  return { name: "reference.png", buffer };
}

function mp4File() {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32BE(16, 0);
  buffer.write("ftyp", 4, "ascii");
  buffer.write("isom", 8, "ascii");
  return { name: "clip.mp4", buffer };
}

function fakeFetch(options: {
  modelStatus?: number | null;
  modelDisplayName?: string;
  modelNumber?: number;
  tierFlags?: number[];
  stream?: () => Response;
  upload?: (accountId: string, input: RequestInfo | URL, init?: RequestInit) => Response;
  accountId?: string;
  onCall?: (path: string, input: RequestInfo | URL, init?: RequestInit) => void;
} = {}) {
  const accountId = options.accountId ?? "default";
  let uploadIndex = 0;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    options.onCall?.(url.pathname, input, init);
    if (url.pathname === "/app") return new Response(html, { headers: { "Content-Type": "text/html" } });
    if (url.pathname.endsWith("/batchexecute") && url.searchParams.get("rpcids") === "otAQ7b") {
      assert.equal(url.searchParams.get("rpcids"), "otAQ7b");
      assert.equal(url.searchParams.get("source-path"), "/app");
      assert.equal(new Headers(init?.headers).get("cookie"), `__Secure-1PSID=${accountId}-own-account`);
      const request = JSON.parse(new URLSearchParams(String(init?.body)).get("f.req")!);
      assert.deepEqual(request[0][0], ["otAQ7b", "[]", null, "generic"]);
      return modelResponse(options.modelStatus ?? null, options.modelDisplayName, options.modelNumber, options.tierFlags);
    }
    if (url.pathname.endsWith("/batchexecute") && url.searchParams.get("rpcids") === "aPya6c") return quotaResponse();
    if (url.hostname === "content-push.googleapis.com") {
      assert.equal(init?.method, "POST");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).get("cookie"), null);
      return options.upload?.(accountId, input, init) ?? new Response(`/contrib_service/drive/${accountId}-upload-${++uploadIndex}`);
    }
    if (url.pathname.endsWith("/StreamGenerate")) return options.stream?.() ?? successStream();
    if (url.pathname.endsWith("/batchexecute") && url.searchParams.get("rpcids") === "aPya6c") return quotaResponse();
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  };
}

function makeProvider(options: Parameters<typeof fakeFetch>[0] = {}) {
  const cookie = `__Secure-1PSID=${options.accountId ?? "default"}-own-account`;
  return new GeminiWebProvider(cookie, new GeminiWebClient(cookie, {
    baseUrl: "http://127.0.0.1", userAgent, fetch: fakeFetch(options), timeout: 500,
  }));
}

test("model discovery is an account-authenticated read-only RPC and does not generate", async () => {
  const calls: string[] = [];
  const provider = makeProvider({ onCall: path => calls.push(path) });
  const catalog = await provider.getModels();
  assert.equal(catalog.accountStatus, null);
  assert.deepEqual(catalog.models.map(model => model.displayName), ["3.8 Flash"]);
  assert.deepEqual(calls, ["/app", "/_/BardChatUi/data/batchexecute"]);
});

test("unknown, unavailable and invalid thinking inputs fail before upload or StreamGenerate", async () => {
  for (const [name, modelOptions, request] of [
    ["unknown model", {}, { message: "hello", thinking: false, model: "not-in-account-list", files: [pngFile()] }],
    ["unobserved-capacity model", { tierFlags: [21] }, { message: "hello", thinking: false, model: "3.8 Flash", files: [pngFile()] }],
    ["invalid level", {}, { message: "hello", thinking: false, thinkingLevel: "Ultra", files: [pngFile()] }],
  ] as const) {
    const calls: string[] = [];
    const provider = makeProvider({ ...modelOptions, onCall: path => calls.push(path) });
    await assert.rejects(provider.chat(request), (error: any) => error.code === "invalid_request" || error.code === "unsupported_capability", name);
    assert.equal(calls.includes("/StreamGenerate"), false, name);
    assert.equal(calls.includes("/upload"), false, name);
  }
});

test("model and thinking values map independently to slot 79, slot 80 and header fields without collapsing levels", async () => {
  for (const [level, expected] of [["low", 1], ["medium", 4], ["high", 2]] as const) {
    let captured: RequestInit | undefined;
    let discoverCalls = 0;
    const provider = makeProvider({ onCall: (path, _input, init) => {
      if (path.endsWith("/batchexecute")) discoverCalls++;
      if (path.endsWith("/StreamGenerate")) captured = init;
    } });
    const result = await provider.chat({ message: "select account model", thinking: false, model: "3.8 Flash", thinkingLevel: level });
    assert.equal(result.remoteSession?.model, modelId);
    assert.equal(result.remoteSession?.thinkingLevel, level);
    assert.equal(discoverCalls, 1);
    const body = formPayload(captured);
    assert.equal(body.payload[79], 2);
    assert.equal(body.payload[80], expected);
    const headers = new Headers(captured?.headers);
    const modelHeader = JSON.parse(headers.get("x-goog-ext-525001261-jspb")!);
    assert.equal(modelHeader[4], modelId);
    assert.equal(modelHeader[11], 2);
    assert.equal(modelHeader[14], 2);
    assert.equal(modelHeader[15], expected);
  }
});

test("continuation inherits omitted model and thinking selection and preserves prior c/r/rc lineage", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  let streamTurn = 0;
  const fixtureErrors: string[] = [];
  const rawFetch = fakeFetch({
    accountId: "inherit",
    onCall: (path, input, init) => requests.push({ url: new URL(String(input)), init }),
    stream: () => successStream(streamTurn++ === 0
      ? { conversationId: "c_conversation", replyId: "r_reply", candidateId: "rc_answer" }
      : { conversationId: "c_conversation", replyId: "r_next", candidateId: "rc_next" }),
  });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    try { return await rawFetch(input, init); }
    catch (error) { fixtureErrors.push(String(error)); throw error; }
  };
  const cookie = "__Secure-1PSID=inherit-own-account";
  const provider = new GeminiWebProvider(cookie, new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch, timeout: 500 }));
  let first;
  try { first = await provider.chat({ message: "first", thinking: false, model: "3.8 Flash", thinkingLevel: "medium" }); }
  catch (error) { assert.fail(`${String(error)} fixture=${fixtureErrors.join(";")} calls=${requests.map(item => `${item.url.pathname}?${item.url.searchParams.get("rpcids") ?? ""}`).join(",")}`); }
  let second;
  try { second = await provider.chat({ message: "continue", thinking: false }, first.remoteSession); }
  catch (error) { assert.fail(`${String(error)} calls=${requests.map(item => `${item.url.pathname}?${item.url.searchParams.get("rpcids") ?? ""}`).join(",")}`); }
  const writes = requests.filter(item => item.url.pathname.endsWith("/StreamGenerate"));
  assert.equal(writes.length, 2);
  const previousPayload = formPayload(writes[1].init).payload;
  assert.deepEqual(previousPayload[2].slice(0, 3), ["c_conversation", "r_reply", "rc_answer"]);
  assert.equal(previousPayload[79], 2);
  assert.equal(previousPayload[80], 4);
  assert.equal(second.remoteSession?.model, modelId);
  assert.equal(second.remoteSession?.thinkingLevel, "medium");
});

test("file upload tuples use ephemeral IDs in message slot and never send Gemini cookies to content-push", async () => {
  const observed: Array<{ path: string; input: RequestInfo | URL; init?: RequestInit }> = [];
  const provider = makeProvider({ onCall: (path, input, init) => observed.push({ path, input, init }) });
  const result = await provider.generateMedia({ kind: "video", prompt: "A quiet mountain lake.", model: "3.8 Flash",
    thinkingLevel: "high", ratio: "16:9", referenceImages: [pngFile()], referenceVideos: [mp4File()] });
  const uploadCalls = observed.filter(call => new URL(String(call.input)).hostname === "content-push.googleapis.com");
  assert.equal(uploadCalls.length, 2);
  for (const call of uploadCalls) {
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("cookie"), null);
    assert.equal(call.init?.credentials, "omit");
  }
  const write = observed.find(call => call.path.endsWith("/StreamGenerate"))!;
  const payload = formPayload(write.init).payload;
  assert.equal(payload[49], 11);
  assert.equal(payload[0][9][6][0][3], 1);
  assert.match(payload[0][0], /Requested output aspect ratio: 16:9/);
  assert.match(payload[0][0], /Use the attached files as visual references/);
  assert.deepEqual(payload[0][3], [
    [["/contrib_service/drive/default-upload-1"], "reference.png"],
    [["/contrib_service/drive/default-upload-2"], "clip.mp4"],
  ]);
  assert.equal(result.remoteSession?.model, modelId);
  assert.equal(result.remoteSession?.thinkingLevel, "high");
  const remoteJSON = JSON.stringify(result.remoteSession);
  assert.ok(!remoteJSON.includes("reference.png"));
  assert.ok(!remoteJSON.includes("clip.mp4"));
  assert.ok(!remoteJSON.includes("upload"));
});

test("native ratio controls match the captured image picker and landscape/portrait video drafts", () => {
  for (const [ratio, wire] of [["9:16", 59], ["3:4", 60], ["1:1", 61], ["4:3", 62], ["16:9", 63]] as const) {
    const payload: unknown[] = [["a paper crane"]];
    applyGeminiMediaControls(payload, "image", ratio);
    assert.equal(payload[49], 14);
    assert.deepEqual(payload[55], [[wire]]);
  }
  for (const [ratio, wire] of [["16:9", 1], ["9:16", 2]] as const) {
    const payload: any[] = [["a drifting leaf"]];
    applyGeminiMediaControls(payload, "video", ratio);
    assert.equal(payload[49], 11);
    assert.deepEqual(payload[17], [[1]]);
    assert.equal(payload[0][9][6][0][3], wire);
  }
  for (const [kind, ratio] of [["image", "3:2"], ["image", "2:3"], ["video", "1:1"], ["video", "3:4"]] as const) {
    const payload: unknown[] = [["private content"]];
    assert.throws(() => applyGeminiMediaControls(payload, kind, ratio), (e: any) => e.code === "invalid_request" && !e.sessionUncertain);
    assert.equal(payload[49], undefined);
  }
});

test("file upload or model discovery failure is definite and sends no StreamGenerate", async () => {
  let uploads = 0;
  let writes = 0;
  const uploadFailure = makeProvider({
    upload: () => { uploads++; return new Response("failure", { status: 500 }); },
    onCall: path => { if (path.endsWith("/StreamGenerate")) writes++; },
  });
  await assert.rejects(uploadFailure.chat({ message: "analyze fixture", thinking: false, files: [pngFile()] }),
    (error: any) => !error.sessionUncertain && error.code === "file_upload_error");
  assert.equal(uploads, 1);
  assert.equal(writes, 0);

  const invalidModelProvider = new GeminiWebProvider("__Secure-1PSID=default-own-account", new GeminiWebClient("__Secure-1PSID=default-own-account", {
    baseUrl: "http://127.0.0.1", userAgent, timeout: 500,
    fetch: async input => {
      const path = new URL(String(input)).pathname;
      if (path === "/app") return new Response(html, { headers: { "Content-Type": "text/html" } });
      return new Response("not an RPC fixture", { headers: { "Content-Type": "application/json" } });
    },
  }));
  await assert.rejects(invalidModelProvider.chat({ message: "x", thinking: false, model: "3.8 Flash", files: [pngFile()] }),
    (error: any) => !error.sessionUncertain && error.code === "invalid_response");
  assert.equal(writes, 0);
});

test("quota failover uploads the reference again using the next configured account", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gemini-inputs-failover-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const calls: Array<{ account: string; path: string; host: string; init?: RequestInit }> = [];
  const accounts = [account("first"), account("second")];
  const provider = new GeminiAccountProvider(accounts, config => {
    const stream = config.id === "first" ? quotaStream() : successStream({
      conversationId: "c_second", replyId: "r_second", candidateId: "rc_second", text: "video created",
    });
    const client = new GeminiWebClient(config.cookie, { baseUrl: "http://127.0.0.1", userAgent: config.userAgent, timeout: 500,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        calls.push({ account: config.id, path: url.pathname, host: url.hostname, init });
        if (url.pathname === "/app") return new Response(html, { headers: { "Content-Type": "text/html" } });
        if (url.hostname === "content-push.googleapis.com") {
          assert.equal(new Headers(init?.headers).get("cookie"), null);
          return new Response(`/contrib_service/drive/${config.id}-upload`);
        }
        if (url.pathname.endsWith("/StreamGenerate")) return stream;
        if (url.pathname.endsWith("/batchexecute")) return quotaResponse();
        throw new Error("unexpected request path");
      } });
    return new GeminiWebProvider(config.cookie, client);
  }, new GeminiCooldownStore(join(directory, "cooldowns.json")));
  const result = await provider.generateMedia({ kind: "video", prompt: "A turning windmill.", referenceImages: [pngFile()] });
  assert.equal(result.remoteSession?.accountId, "second");
  const uploadCalls = calls.filter(call => call.host === "content-push.googleapis.com");
  assert.equal(calls.filter(call => call.account === "first" && call.init?.body instanceof FormData).length, 1);
  assert.equal(calls.filter(call => call.account === "second" && call.init?.body instanceof FormData).length, 1);
  assert.equal(calls.filter(call => call.account === "first" && call.path.endsWith("/StreamGenerate")).length, 1);
  assert.equal(calls.filter(call => call.account === "second" && call.path.endsWith("/StreamGenerate")).length, 1);
  assert.equal(result.remoteSession?.conversationId, "c_second");
  assert.equal(uploadCalls.length, 2);
});
