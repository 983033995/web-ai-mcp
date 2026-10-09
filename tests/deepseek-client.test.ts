import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { DeepSeekWebClient } from "../src/providers/deepseek/web-client.js";
import { DeepSeekWebProvider } from "../src/providers/deepseek/index.js";
import { solvePow, type PowChallenge } from "../src/providers/deepseek/pow.js";

const json = (biz_data: unknown, biz_code = 0) => Response.json({ code: 0, data: { biz_code, biz_data } });
const challenge: PowChallenge = { algorithm: "DeepSeekHashV1", challenge: "00".repeat(32), salt: "fixture",
  difficulty: 1, expire_at: 1_900_000_000, signature: "fixture", target_path: "/api/v0/chat/completion" };
const reply = (id: number | undefined = 9) => new Response(
  'event: ready\ndata: ' + JSON.stringify({ response_message_id: id }) + '\n\n' +
  'data: ' + JSON.stringify({ v: { response: { fragments: [
    { type: "THINKING", content: "thought" }, { type: "RESPONSE", content: "answer" }
  ], status: "FINISHED" } } }) + '\n\n', { headers: { "Content-Type": "text/event-stream" } });

function fixture(completion: () => Response = () => reply(), timeout = 500) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new DeepSeekWebClient("fixture-token", { timeout, solve: async () => 0,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, init });
      if (path.endsWith("/chat_session/create")) return json({ id: "remote-session" });
      if (path.endsWith("/chat/create_pow_challenge")) {
        const target_path = JSON.parse(String(init?.body)).target_path;
        return json({ challenge: { ...challenge, target_path } });
      }
      if (path.endsWith("/file/upload_file")) return json({ id: "file-fixture" });
      if (path.endsWith("/file/fetch_files")) return json({ files: [{ id: "file-fixture", status: "SUCCESS" }] });
      return completion();
    }
  });
  return { client, calls };
}

test("website chat uses real parent lineage, thinking toggle, no search, and no write retry", async () => {
  const { client, calls } = fixture();
  const provider = new DeepSeekWebProvider("fixture-token", client);
  await provider.initialize();
  const first = await provider.chat({ message: "first", thinking: false });
  const second = await provider.chat({ message: "follow up", systemPrompt: "context", thinking: true }, first.remoteSession);
  assert.equal(second.content, "answer");
  assert.equal(second.reasoning, "thought");
  const completions = calls.filter((call) => call.path.endsWith("/chat/completion"));
  assert.equal(completions.length, 2);
  assert.equal(calls.filter((call) => call.path.endsWith("/chat_session/create")).length, 1);
  assert.deepEqual(JSON.parse(String(completions[1].init?.body)), {
    chat_session_id: "remote-session", parent_message_id: 9, prompt: "context\n\nfollow up",
    ref_file_ids: [], thinking_enabled: true, search_enabled: false
  });
  assert.equal(completions[1].init?.redirect, "error");
});

test("file analysis uploads multipart, waits for parsing, and exposes resumable provider state", async () => {
  const { client, calls } = fixture();
  const provider = new DeepSeekWebProvider("fixture-token", client);
  const result = await provider.analyzeFiles([{ name: "fixture.txt", buffer: Buffer.from("non-sensitive test") }], "analyze", false);
  assert.equal(result.remoteSession?.lastMessageId, 9);
  const upload = calls.find((call) => call.path.endsWith("/file/upload_file"))!;
  assert.ok(upload.init?.body instanceof FormData);
  assert.equal((upload.init?.body as FormData).get("file") instanceof Blob, true);
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)).ref_file_ids, ["file-fixture"]);
  assert.ok(calls.some((call) => call.path.endsWith("/file/fetch_files")));
});

test("missing message ID retains useful answer but never advertises resumability", async () => {
  const noId = new DeepSeekWebClient("fixture-token", { solve: async () => 0, fetch: async (input) =>
    String(input).endsWith("/chat_session/create") ? json({ id: "s" }) :
    String(input).endsWith("/chat/create_pow_challenge") ? json({ challenge }) :
    new Response('data: {"v":{"response":{"content":"answer","status":"FINISHED"}}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } }) });
  const result = await new DeepSeekWebProvider("fixture-token", noId).chat({ message: "x", thinking: false });
  assert.equal(result.content, "answer");
  assert.equal(result.remoteSession, undefined);
  assert.match(result.warning!, /not resumable/);
});

for (const status of [401, 403, 429, 500]) {
  test(`HTTP ${status} is explicit, redacted and never retried`, async () => {
    const { client, calls } = fixture(() => new Response("fixture-token and private upstream IDs", { status }));
    await assert.rejects(client.chat({ message: "x", thinking: false }), (error: any) => {
      assert.match(error.message, status === 401 ? /DEEPSEEK_USER_TOKEN/ : new RegExp(String(status)));
      assert.ok(!error.message.includes("fixture-token"));
      assert.equal(error.sessionUncertain, status === 500);
      return true;
    });
    assert.equal(calls.filter((call) => call.path.endsWith("/chat/completion")).length, 1);
  });
}

test("business errors and missing data are rejected before completion", async () => {
  for (const response of [json({ id: "x" }, 100), json({}), new Response("bad JSON")]) {
    const client = new DeepSeekWebClient("fixture-token", { fetch: async () => response, solve: async () => 0 });
    await assert.rejects(client.chat({ message: "x", thinking: false }));
  }
});

test("HTTP 200 auth business code requests token refresh without leaking upstream text", async () => {
  for (const envelope of [{ code: 40003, msg: "fixture-token" }, { code: 0, data: { biz_code: 40003, biz_msg: "fixture-token" } }]) {
    const client = new DeepSeekWebClient("fixture-token", { fetch: async () => Response.json(envelope), solve: async () => 0 });
    await assert.rejects(client.chat({ message: "x", thinking: false }), (error: any) => {
      assert.equal(error.code, "authentication_error");
      assert.match(error.message, /更新.*DEEPSEEK_USER_TOKEN/);
      assert.match(error.message, /重启 MCP/);
      assert.ok(!error.message.includes("fixture-token"));
      assert.equal(error.sessionUncertain, false);
      return true;
    });
  }
});

test("all JSON endpoints reject HTTP failures and file parse failures stop completion", async () => {
  for (const failingPath of ["/chat_session/create", "/chat/create_pow_challenge", "/file/upload_file", "/file/fetch_files"]) {
    let completions = 0;
    const client = new DeepSeekWebClient("fixture-token", { solve: async () => 0, fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith(failingPath)) return new Response("private fixture-token", { status: 403 });
      if (path.endsWith("/chat_session/create")) return json({ id: "s" });
      if (path.endsWith("/chat/create_pow_challenge")) return json({ challenge: {
        ...challenge, target_path: JSON.parse(String(init?.body)).target_path
      } });
      if (path.endsWith("/file/upload_file")) return json({ id: "f" });
      completions++; return reply();
    } });
    await assert.rejects(client.analyzeFiles([{ name: "fixture.txt", buffer: Buffer.from("x") }], "analyze", false),
      (error: any) => error.code === "access_denied" && !error.message.includes("fixture-token"));
    assert.equal(completions, 0);
  }
  const client = new DeepSeekWebClient("fixture-token", { solve: async () => 0, fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/chat_session/create")) return json({ id: "s" });
    if (path.endsWith("/chat/create_pow_challenge")) return json({ challenge: {
      ...challenge, target_path: JSON.parse(String(init?.body)).target_path
    } });
    if (path.endsWith("/file/upload_file")) return json({ id: "f" });
    return json({ files: [{ id: "f", status: "FAILED" }] });
  } });
  await assert.rejects(client.analyzeFiles([{ name: "fixture.txt", buffer: Buffer.from("x") }], "analyze", false),
    (error: any) => error.code === "file_parse_error");
});

test("timeout remains active after SSE headers and marks ambiguous writes", async () => {
  const { client } = fixture(() => new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } }), 25);
  await assert.rejects(client.chat({ message: "x", thinking: false }), (error: any) => {
    assert.equal(error.code, "timeout_error");
    assert.equal(error.sessionUncertain, true);
    return true;
  });
});

test("cancellation reaches transport before writes and during stream consumption", async () => {
  const { client, calls } = fixture(() => new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } }));
  const early = new AbortController(); early.abort();
  await assert.rejects(client.chat({ message: "x", thinking: false, signal: early.signal }), (error: any) => error.code === "cancelled" && !error.sessionUncertain);
  assert.equal(calls.length, 0);
  const controller = new AbortController();
  const pending = client.chat({ message: "x", thinking: false, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, (error: any) => error.code === "cancelled" && error.sessionUncertain);
  assert.equal(calls.at(-1)?.init?.signal?.aborted, true);
});

test("token/timeout/base URL and remote lineage fail closed", async () => {
  assert.throws(() => new DeepSeekWebClient(""), /Missing/);
  assert.throws(() => new DeepSeekWebClient("fixture-token", { timeout: NaN }), /TIMEOUT/);
  assert.throws(() => new DeepSeekWebClient("fixture-token", { baseUrl: "https://example.com" }), /base URL/);
  const { client, calls } = fixture();
  await assert.rejects(client.chat({ message: "x", thinking: false }, { sessionId: "s", lastMessageId: NaN }), /lineage/);
  assert.equal(calls.length, 0);
});

test("pinned WASM initializes; an unsolved fixture fails without random fallback", async () => {
  await new DeepSeekWebClient("fixture-token").initialize();
  const bytes = await readFile(new URL("../src/providers/deepseek/upstream/sha3_wasm_bg.wasm", import.meta.url));
  const module = await WebAssembly.compile(new Uint8Array(bytes));
  // wasm_deepseek_hash_v1("fixture_1900000000_0"); nonce 0 is a known valid solution.
  const valid = { ...challenge, challenge: "00b5e095165887351002858453f394a138129d26509aa07eb41e1c289a39bb5d" };
  assert.equal(await solvePow(module, valid, new AbortController().signal), 0);
  await assert.rejects(solvePow(module, challenge, new AbortController().signal), /solver failed/);
  const controller = new AbortController();
  const pending = solvePow(module, { ...challenge, difficulty: 1_000_000_000 }, controller.signal);
  controller.abort(new Error("fixture cancellation"));
  await assert.rejects(pending, /fixture cancellation/);
});
