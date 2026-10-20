import { createHash } from "node:crypto";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { RemoteSession } from "../src/core/provider.js";
import { GeminiWebProvider } from "../src/providers/gemini/index.js";
import { GeminiWebClient } from "../src/providers/gemini/web-client.js";

const cookie = "__Secure-1PSID=fixture-session; other=value";
const userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36";
const email = "fixture@example.test";
const accountHash = createHash("sha256").update(email).digest("hex");
const html = (identity = email) => `<script>window.context={"SNlM0e":"request-token","cfb2h":"build-fixture","FdrFJe":"12345","oPEP7c":"${identity}"};</script>`;

function stream(content: string, ids: { conversationId?: string; replyId?: string; candidateId?: string } = {}): Response {
  const record: unknown[] = Array(26).fill(null);
  if (ids.conversationId || ids.replyId) record[1] = [ids.conversationId ?? null, ids.replyId ?? null];
  record[4] = [[ids.candidateId ?? null, [content]]];
  const json = JSON.stringify([["wrb.fr", null, JSON.stringify(record)]]);
  return new Response(`)]}'\n${Buffer.byteLength(json)}\n${json}\ndi\n`, { headers: { "Content-Type": "application/json; charset=UTF-8" } });
}

function fixture(reply: () => Response = () => stream("你好", { conversationId: "c_one", replyId: "r_one", candidateId: "rc_one" }), timeout = 500) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, timeout, fetch: async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/app") return new Response(html(), { headers: { "Content-Type": "text/html" } });
    return reply();
  } });
  return { client, calls };
}

function requestPayload(init?: RequestInit): { payload: unknown[]; at: string } {
  const form = new URLSearchParams(String(init?.body));
  const request = JSON.parse(form.get("f.req")!);
  return { at: form.get("at")!, payload: JSON.parse(request[1]) };
}

test("Gemini provider sends default-model chat and resumes a second turn with fresh lineage", async () => {
  const responses = [
    () => stream("第一轮回答。", { conversationId: "c_fixture", replyId: "r_1", candidateId: "rc_1" }),
    () => stream("第二轮回答。", { conversationId: "c_fixture", replyId: "r_2", candidateId: "rc_2" })
  ];
  const { client, calls } = fixture(() => responses.shift()!());
  const provider = new GeminiWebProvider(cookie, client);
  await provider.initialize();
  const first = await provider.chat({ message: "请讲一个短故事。", thinking: false });
  assert.equal(first.content, "第一轮回答。");
  assert.deepEqual(first.remoteSession, { conversationId: "c_fixture", replyId: "r_1", candidateId: "rc_1", accountHash });
  const second = await provider.chat({ message: "接着说。", thinking: false }, first.remoteSession);
  assert.equal(second.content, "第二轮回答。");
  assert.equal(second.remoteSession?.replyId, "r_2");
  assert.equal(calls.filter((call) => call.url.pathname === "/app").length, 2);
  const writes = calls.filter((call) => call.url.pathname.endsWith("/StreamGenerate"));
  assert.equal(writes.length, 2);
  assert.equal(writes[0].init?.method, "POST");
  assert.equal(writes[0].init?.redirect, "manual");
  assert.equal(writes[0].init?.headers && new Headers(writes[0].init.headers).get("cookie"), cookie);
  assert.equal(writes[0].init?.headers && new Headers(writes[0].init.headers).get("user-agent"), userAgent);
  const firstPayload = requestPayload(writes[0].init);
  const secondPayload = requestPayload(writes[1].init);
  assert.equal(firstPayload.at, "request-token");
  assert.equal(firstPayload.payload[0][0], "请讲一个短故事。");
  assert.deepEqual(firstPayload.payload[2], ["", "", "", null, null, null, null, null, null, ""]);
  assert.deepEqual(secondPayload.payload[2], ["c_fixture", "r_1", "rc_1", null, null, null, null, null, null, ""]);
  assert.deepEqual(provider.capabilities, { chat: true, thinking: false, files: false, webSearch: false, sessionResume: true });
});

test("missing reply lineage returns content without a resumable session", async () => {
  const { client } = fixture(() => stream("answer without IDs"));
  const result = await new GeminiWebProvider(cookie, client).chat({ message: "hello", thinking: false });
  assert.equal(result.content, "answer without IDs");
  assert.equal(result.remoteSession, undefined);
  assert.match(result.warning!, /cannot be resumed/);
});

test("cookie and User-Agent are required, and initialization is offline", async () => {
  assert.throws(() => new GeminiWebClient("other=value", { userAgent }));
  assert.throws(() => new GeminiWebClient(cookie));
  assert.throws(() => new GeminiWebClient(cookie, { userAgent, baseUrl: "https://example.com" }));
  assert.throws(() => new GeminiWebClient(cookie, { userAgent, timeout: 600001 }));
  let calls = 0;
  const client = new GeminiWebClient(cookie, { userAgent, fetch: async () => { calls++; throw new Error("unexpected network"); } });
  await client.initialize();
  assert.equal(calls, 0);
});

test("invalid session fields and thinking requests fail before network access", async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.chat({ message: "continue", thinking: false }, { conversationId: "c", replyId: "r" }),
    (error: any) => error.code === "session_state_error");
  await assert.rejects(client.chat({ message: "continue", thinking: false }, {
    conversationId: "c_bad space", replyId: "r_previous", candidateId: "rc_previous", accountHash
  }), (error: any) => error.code === "session_state_error");
  await assert.rejects(client.chat({ message: "hello", thinking: true }), (error: any) => error.code === "unsupported_capability");
  assert.equal(calls.length, 0);
});

test("an already-aborted request sends no initialization or chat request", async () => {
  const { client, calls } = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.chat({ message: "hello", thinking: false, signal: controller.signal }),
    (error: any) => error.code === "cancelled" && !error.sessionUncertain);
  assert.equal(calls.length, 0);
});

test("anonymous or expired initialization fails before posting a message", async () => {
  for (const page of ["<html><title>Sign in to continue</title></html>", html("")]) {
    let posts = 0;
    const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent,
      fetch: async (_input, init) => {
        if (init?.method === "POST") { posts++; return stream("unexpected"); }
        return new Response(page, { headers: { "Content-Type": "text/html" } });
      } });
    await assert.rejects(client.chat({ message: "hello", thinking: false }), (error: any) => error.code === "authentication_error" && !error.sessionUncertain);
    assert.equal(posts, 0);
  }
});

for (const status of [401, 403, 429, 500]) {
  test(`Gemini HTTP ${status} is redacted and never retried`, async () => {
    let writes = 0;
    const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async (_input, init) => {
      if (init?.method !== "POST") return new Response(html(), { headers: { "Content-Type": "text/html" } });
      writes++;
      return new Response("cookie=secret upstream-private", { status });
    } });
    await assert.rejects(client.chat({ message: "hello", thinking: false }), (error: any) => {
      assert.equal(error.sessionUncertain, status === 500);
      assert.ok(!error.message.includes("secret"));
      assert.ok(!error.message.includes("upstream-private"));
      return true;
    });
    assert.equal(writes, 1);
  });
}

test("changed Google account rejects continuation before the website write", async () => {
  let posts = 0;
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async (_input, init) => {
    if (init?.method === "POST") { posts++; return stream("unexpected"); }
    return new Response(html("someone-else@example.test"), { headers: { "Content-Type": "text/html" } });
  } });
  const prior: RemoteSession = { conversationId: "c_previous", replyId: "r_previous", candidateId: "rc_previous", accountHash };
  await assert.rejects(client.chat({ message: "continue", thinking: false }, prior), (error: any) => error.code === "authentication_error");
  assert.equal(posts, 0);
});

test("conversation remapping or stale reply/candidate IDs fail closed after one write", async () => {
  const prior: RemoteSession = { conversationId: "c_one", replyId: "r_one", candidateId: "rc_one", accountHash };
  for (const reply of [
    () => stream("answer", { conversationId: "c_other", replyId: "r_two", candidateId: "rc_two" }),
    () => stream("answer", { conversationId: "c_one", replyId: "r_one", candidateId: "rc_two" }),
    () => stream("answer", { conversationId: "c_one", replyId: "r_two", candidateId: "rc_one" })
  ]) {
    const { client, calls } = fixture(reply);
    await assert.rejects(client.chat({ message: "continue", thinking: false }, prior),
      (error: any) => error.code === "session_state_error" && error.sessionUncertain);
    assert.equal(calls.filter((call) => call.init?.method === "POST").length, 1);
  }
});

test("redirects are not followed and credentials are never forwarded", async () => {
  const urls: string[] = [];
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async (input, init) => {
    urls.push(String(input));
    if (init?.method === "POST") return new Response(null, { status: 302, headers: { Location: "https://accounts.example.test/" } });
    return new Response(html(), { headers: { "Content-Type": "text/html" } });
  } });
  await assert.rejects(client.chat({ message: "hello", thinking: false }), (error: any) =>
    error.code === "redirect_blocked" && error.sessionUncertain);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => new URL(url).hostname === "127.0.0.1"));
});

test("HTTP error returns promptly when discarded-body cancellation stalls", async () => {
  const body = new ReadableStream<Uint8Array>({ start() {}, cancel() { return new Promise<void>(() => {}); } });
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async (_input, init) => {
    if (init?.method !== "POST") return new Response(html(), { headers: { "Content-Type": "text/html" } });
    return new Response(body, { status: 500, headers: { "Content-Type": "application/json" } });
  } });
  const check = assert.rejects(client.chat({ message: "hello", thinking: false }), (error: any) =>
    error.code === "http_error" && error.sessionUncertain);
  await Promise.race([check, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("discarded-body cleanup hung")), 100))]);
});

test("CAPTCHA blocks subsequent writes until a new client is created", async () => {
  let calls = 0;
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async () => {
    calls++;
    return new Response("<html>Verify you are human</html>", { headers: { "Content-Type": "text/html" } });
  } });
  await assert.rejects(client.chat({ message: "hello", thinking: false }), (error: any) => error.code === "captcha_required");
  await assert.rejects(client.chat({ message: "hello again", thinking: false }), (error: any) => error.code === "captcha_required");
  assert.equal(calls, 1);
});

test("a CAPTCHA denial on a chat response blocks later writes", async () => {
  let writes = 0;
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async (_input, init) => {
    if (init?.method !== "POST") return new Response(html(), { headers: { "Content-Type": "text/html" } });
    writes++;
    return new Response("<html>Verify you are human</html>", { status: 403, headers: { "Content-Type": "text/html" } });
  } });
  await assert.rejects(client.chat({ message: "hello", thinking: false }), (error: any) => error.code === "captcha_required" && error.sessionUncertain);
  await assert.rejects(client.chat({ message: "hello again", thinking: false }), (error: any) => error.code === "captcha_required" && !error.sessionUncertain);
  assert.equal(writes, 1);
});

test("malformed chat HTML is marked uncertain because the write was already sent", async () => {
  const { client } = fixture(() => new Response("<html>unexpected page</html>", { headers: { "Content-Type": "text/html" } }));
  await assert.rejects(client.chat({ message: "hello", thinking: false }), (error: any) => error.code === "invalid_response" && error.sessionUncertain);
});

test("timeout covers stalled initialization headers and HTML body", async () => {
  for (const mode of ["headers", "body"] as const) {
    const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, timeout: 20, fetch: async (_input, init) => {
      if (mode === "headers") return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { "Content-Type": "text/html" } });
    } });
    await assert.rejects(client.chat({ message: "hello", thinking: false }), (error: any) => error.code === "timeout_error" && !error.sessionUncertain);
  }
});

test("timeout and cancellation cover POST headers and the full streamed body", async () => {
  for (const mode of ["headers", "body", "cancel-body"] as const) {
    const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent,
      timeout: mode === "cancel-body" ? 1000 : 20,
      fetch: async (_input, init) => {
        if (init?.method !== "POST") return new Response(html(), { headers: { "Content-Type": "text/html" } });
        if (mode === "headers") return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { "Content-Type": "application/json" } });
      } });
    const controller = new AbortController();
    const pending = client.chat({ message: "hello", thinking: false, signal: mode === "cancel-body" ? controller.signal : undefined });
    if (mode === "cancel-body") setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error: any) => error.code === (mode === "cancel-body" ? "cancelled" : "timeout_error") && error.sessionUncertain);
  }
});

test("oversized initialization and generation bodies fail closed", async () => {
  const bigHtml = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent,
    fetch: async () => new Response("x".repeat(4 * 1024 * 1024 + 1), { headers: { "Content-Type": "text/html" } }) });
  await assert.rejects(bigHtml.chat({ message: "hello", thinking: false }), (error: any) => error.code === "invalid_response");
  const bigStream = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async (_input, init) =>
    init?.method === "POST" ? new Response("x".repeat(2 * 1024 * 1024 + 1), { headers: { "Content-Type": "application/json" } })
      : new Response(html(), { headers: { "Content-Type": "text/html" } }) });
  await assert.rejects(bigStream.chat({ message: "hello", thinking: false }), (error: any) => error.code === "invalid_response" && error.sessionUncertain);
});

test("initialization returns promptly when oversized HTML cancellation cleanup stalls", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
    cancel() { return new Promise<void>(() => {}); }
  });
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent,
    fetch: async () => new Response(body, { headers: { "Content-Type": "text/html" } }) });
  const check = assert.rejects(client.chat({ message: "hello", thinking: false }), (error: any) =>
    error.code === "invalid_response" && !error.sessionUncertain);
  await Promise.race([check, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("HTML cleanup hung")), 100))]);
});

test("a missing session cookie value is rejected without exposing its value", async () => {
  assert.throws(() => new GeminiWebClient("__Secure-1PSID=", { userAgent }), (error: any) =>
    error.code === "configuration_error" && !error.message.includes("fixture"));
});
