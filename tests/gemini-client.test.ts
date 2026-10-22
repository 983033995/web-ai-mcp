import { createHash } from "node:crypto";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { RemoteSession } from "../src/core/provider.js";
import { GeminiWebProvider } from "../src/providers/gemini/index.js";
import { GeminiWebClient } from "../src/providers/gemini/web-client.js";
import { GeminiQuotaError } from "../src/providers/gemini/cooldown.js";

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

function generatedStream(kind: "image" | "video", status = 2): Response {
  const candidate: unknown[] = Array(13).fill(null);
  candidate[0] = "rc_generated";
  candidate[8] = [status];
  const rich: unknown[] = [];
  if (kind === "image") {
    const image: unknown[] = [];
    image[0] = [null, null, null, [null, null, "alt", "https://lh3.googleusercontent.com/gg/preview?alr=1"]];
    image[1] = ["image-id"];
    image[3] = [];
    image[3][22] = [];
    image[3][22][7] = ["thumbnail", "https://contribution.usercontent.google.com/download?c=img&filename=image.png&opi=1"];
    rich[7] = [[image]];
  } else {
    const videoInfo: unknown[] = [];
    videoInfo[0] = [];
    videoInfo[0][7] = ["https://lh3.googleusercontent.com/gg/preview?alr=1", "https://contribution.usercontent.google.com/download?c=vid&filename=video.mp4&opi=1"];
    rich[59] = [[[videoInfo]]];
    rich[7] = [["companion preview"]];
  }
  candidate[12] = rich;
  const record: unknown[] = Array(26).fill(null);
  record[1] = ["c_generated", "r_generated"];
  record[4] = [candidate];
  const json = JSON.stringify([["wrb.fr", null, JSON.stringify(record)]]);
  const final = JSON.stringify([["di", 3810], ["af.httprm", 3809, "fixture", 2]]);
  const framed = (line: string) => `${line.length + 2}\n${line}\n`;
  const prefix = `)]}'\n\n${framed(json)}${framed(final)}`;
  let total = 0;
  let body = "";
  for (let i = 0; i < 4; i++) {
    body = prefix + framed(JSON.stringify([["e", 4, null, null, total]]));
    total = Buffer.byteLength(body);
  }
  body = prefix + framed(JSON.stringify([["e", 4, null, null, total]]));
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function historyStream(kind: "image" | "video", completionStatus = 2, includeMedia = true): Response {
  const candidate: unknown[] = Array(13).fill(null);
  candidate[0] = "rc_generated";
  candidate[8] = [completionStatus];
  const rich: unknown[] = [];
  if (kind === "video" && includeMedia) {
    const videoInfo: unknown[] = [];
    videoInfo[0] = [];
    videoInfo[0][7] = ["https://lh3.googleusercontent.com/gg/preview?alr=1", "https://contribution.usercontent.google.com/download?c=vid&filename=video.mp4&opi=1"];
    rich[59] = [[[videoInfo]]];
    rich[7] = [["companion preview"]];
  }
  candidate[12] = rich;
  const turn: unknown[] = [];
  turn[0] = [null, "r_generated"];
  turn[3] = [[candidate]];
  const record = JSON.stringify([[turn]]);
  const framed = (json: string) => `${json.length + 2}\n${json}\n`;
  const prefix = `)]}'\n${framed(JSON.stringify([["wrb.fr", "hNvQHb", record, null, null, null]]))}${framed(JSON.stringify([["di", 5], ["af.httprm", 4, "fixture", 2]]))}`;
  let total = 0;
  let body = "";
  for (let i = 0; i < 4; i++) {
    body = prefix + framed(JSON.stringify([["e", 4, null, null, total]]));
    total = Buffer.byteLength(body);
  }
  body = prefix + framed(JSON.stringify([["e", 4, null, null, total]]));
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function quotaFailureStream(): Response {
  const empty = JSON.stringify(Array(26).fill(null));
  const part = ["wrb.fr", null, empty, null, null, [null, null, [[null, [1037]]]]];
  return new Response(`)]}'\n${JSON.stringify([part])}\ndi`, { headers: { "Content-Type": "application/json" } });
}

function quotaRPCResponse(payload: unknown): Response {
  const frame = JSON.stringify([["wrb.fr", "aPya6c", JSON.stringify(payload), null, null, null]]);
  return new Response(`)]}'\n${frame.length + 2}\n${frame}\ndi\n`, { headers: { "Content-Type": "application/json; charset=utf-8" } });
}

test("read-only in-progress history without a resource URL remains pending", async () => {
  let reads = 0;
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === "/app") return new Response(html(), { headers: { "Content-Type": "text/html" } });
    assert.equal(url.pathname, "/_/BardChatUi/data/batchexecute");
    reads++;
    return historyStream("video", 1, false);
  } });
  const result = await client.getMedia({ conversationId: "c_generated", replyId: "r_generated", candidateId: "rc_generated", accountHash, mediaKind: "video" });
  assert.equal(result.media?.[0].status, "pending");
  assert.equal(result.media?.[0].url, undefined);
  assert.equal(reads, 1);
});

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
  assert.deepEqual(provider.capabilities, { chat: true, thinking: true, files: true, webSearch: false, sessionResume: true,
    imageGeneration: true, videoGeneration: true });
});

test("missing reply lineage returns content without a resumable session", async () => {
  const { client } = fixture(() => stream("answer without IDs"));
  const result = await new GeminiWebProvider(cookie, client).chat({ message: "hello", thinking: false });
  assert.equal(result.content, "answer without IDs");
  assert.equal(result.remoteSession, undefined);
  assert.match(result.warning!, /cannot be resumed/);
});

test("a complete HTTP website failure notice is an error rather than a successful answer, with no replay", async () => {
  const notice = "Sorry, something went wrong. Please try your request again.";
  const { client, calls } = fixture(() => stream(notice, { conversationId: "c_one", replyId: "r_one", candidateId: "rc_one" }));
  await assert.rejects(client.chat({ message: "ordinary product question", thinking: false }),
    (e: any) => e.code === "website_error" && e.sessionUncertain);
  assert.equal(calls.filter(call => call.init?.method === "POST").length, 1);
  const quoted = fixture(() => stream(`The website displayed: ${notice}`, { conversationId: "c_one", replyId: "r_one", candidateId: "rc_one" }));
  assert.match((await quoted.client.chat({ message: "explain", thinking: false })).content, /^The website displayed/);
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

test("same-site response cookies update subsequent requests without replay, and unrelated scopes are ignored", async () => {
  const sent: string[] = [];
  let writes = 0;
  const client = new GeminiWebClient(cookie + "; remove=old", { baseUrl: "http://127.0.0.1", userAgent,
    fetch: async (input, init) => {
      sent.push(new Headers(init?.headers).get("Cookie")!);
      if (new URL(String(input)).pathname === "/app") {
        const headers = new Headers({ "Content-Type": "text/html" });
        for (const value of ["fresh=new=value; Path=/; HttpOnly", "remove=; Path=/; Max-Age=0", "hostile=secret; Domain=example.test; Path=/",
          "publicsuffix=secret; Domain=com; Path=/", "scoped=secret; Path=/other", "secure=secret; Secure; Path=/"]) headers.append("Set-Cookie", value);
        return new Response(html(), { headers });
      }
      writes++;
      return stream("answer", { conversationId: "c_one", replyId: "r_one", candidateId: "rc_one" });
    } });
  assert.equal((await client.chat({ message: "hello", thinking: false })).content, "answer");
  assert.equal(writes, 1);
  assert.match(sent[1], /fresh=new=value/);
  assert.ok(!/remove=|hostile=|scoped=|secure=|publicsuffix=/.test(sent[1]));
  assert.ok(sent[1].includes("__Secure-1PSID=fixture-session"));
});

test("secure Google response cookies remain scoped to the website and are used on the next operation", async () => {
  const sent: string[] = [];
  const client = new GeminiWebClient(cookie, { userAgent, fetch: async (_input, init) => {
    sent.push(new Headers(init?.headers).get("Cookie")!);
    const headers = new Headers({ "Content-Type": "text/html" });
    headers.append("Set-Cookie", "__Secure-1PSIDCC=fresh; Domain=.google.com; Secure; Path=/");
    headers.append("Set-Cookie", "__Host-invalid=secret; Domain=.google.com; Secure; Path=/");
    headers.append("Set-Cookie", "unrelated=secret; Domain=usercontent.google.com; Secure; Path=/");
    headers.append("Set-Cookie", "expired=old; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/");
    return new Response("Sign in to continue", { headers });
  } });
  for (let i = 0; i < 2; i++) await assert.rejects(client.getModels(), (e: any) => e.code === "authentication_error");
  assert.ok(sent[1].includes("__Secure-1PSIDCC=fresh"));
  assert.ok(!/invalid=|unrelated=|expired=/.test(sent[1]));
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

test("an email account ID verifies the owner before a new conversation or model lookup", async () => {
  for (const operation of ["chat", "models"] as const) {
    let posts = 0;
    const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, accountId: email,
      fetch: async (_input, init) => {
        if (init?.method === "POST") posts++;
        return new Response(html("someone-else@example.test"));
      } });
    await assert.rejects(operation === "chat" ? client.chat({ message: "hello", thinking: false }) : client.getModels(),
      (e: any) => e.code === "authentication_error" && !e.sessionUncertain);
    assert.equal(posts, 0);
  }
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

test("Gemini media generation uses one ordinary prompt and only reports verified MIME results", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (url.pathname === "/app") return new Response(html(), { headers: { "Content-Type": "text/html" } });
    if (url.pathname.endsWith("/StreamGenerate")) return generatedStream("image");
    if (url.hostname === "lh3.googleusercontent.com" && url.pathname.startsWith("/gg/")) {
      assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).get("cookie"), null);
      return new Response(null, { status: 302, headers: { Location: "https://lh3.google.com/rd-gg/full-size" } });
    }
    if (url.hostname === "lh3.google.com") {
      assert.equal(url.pathname, "/rd-gg/full-size");
      assert.equal(new Headers(init?.headers).get("cookie"), cookie);
      return new Response(null, { status: 302, headers: { Location: "https://lh3.googleusercontent.com/rd-gg/final-image" } });
    }
    if (url.hostname === "lh3.googleusercontent.com" && url.pathname.startsWith("/rd-gg/")) {
      assert.equal(new Headers(init?.headers).get("cookie"), null);
      return new Response(null, { status: 200, headers: { "Content-Type": "image/jpeg" } });
    }
    throw new Error("unexpected fixture URL");
  } });
  const provider = new GeminiWebProvider(cookie, client);
  const result = await provider.generateMedia({ kind: "image", prompt: "A paper boat on a quiet pond." });
  assert.equal(result.media?.length, 1);
  assert.equal(result.media?.[0].status, "completed");
  assert.equal(result.media?.[0].url, "https://lh3.googleusercontent.com/rd-gg/final-image");
  assert.equal("probeUrl" in (result.media?.[0] ?? {}), false);
  assert.equal(result.remoteSession?.mediaKind, "image");
  assert.ok(!JSON.stringify(result.remoteSession).includes("download"));
  assert.ok(!JSON.stringify(result.remoteSession).includes("A paper boat"));
  const write = calls.find(call => call.init?.method === "POST")!;
  const payload = requestPayload(write.init).payload;
  assert.match(String(payload[0] && (payload[0] as unknown[])[0]), /^Generate an image based on this description: A paper boat/);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/StreamGenerate")).length, 1);

  const beforeInvalid = calls.length;
  await assert.rejects(provider.generateMedia({ kind: "video", prompt: "clip", style: "named" }),
    (error: any) => error.code === "unsupported_capability");
  await assert.rejects(provider.generateMedia({ kind: "video", prompt: "clip", durationSeconds: 5 }),
    (error: any) => error.code === "unsupported_capability");
  assert.equal(calls.length, beforeInvalid);
});

test("Gemini video status is read from hNvQHb history and never repeats generation", async () => {
  let writes = 0;
  let videoGets = 0;
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (url.pathname === "/app") return new Response(html(), { headers: { "Content-Type": "text/html" } });
    if (url.pathname.endsWith("/StreamGenerate")) { writes++; return generatedStream("video", 1); }
    if (url.pathname.endsWith("/batchexecute")) {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(url.searchParams.get("rpcids"), "hNvQHb");
      const body = JSON.parse(form.get("f.req")!);
      assert.equal(body[0][0][0], "hNvQHb");
      assert.deepEqual(JSON.parse(body[0][0][1]).slice(0, 2), ["c_generated", 10]);
      return historyStream("video");
    }
    if (url.hostname === "contribution.usercontent.google.com") {
      videoGets++;
      assert.equal(new Headers(init?.headers).get("cookie"), cookie);
      return videoGets === 1
        ? new Response(null, { status: 404, headers: { "Content-Type": "text/html" } })
        : new Response(null, { status: 200, headers: { "Content-Type": "video/mp4" } });
    }
    throw new Error("unexpected fixture URL");
  } });
  const provider = new GeminiWebProvider(cookie, client);
  const first = await provider.generateMedia({ kind: "video", prompt: "A slow camera move over a snowy village." });
  assert.equal(first.media?.length, 1);
  assert.equal(first.media?.[0].type, "video");
  assert.equal(first.media?.[0].status, "pending");
  assert.equal(first.media?.[0].url, undefined);
  const second = await provider.getMedia(first.remoteSession!);
  assert.equal(second.media?.[0].status, "completed");
  assert.match(second.media?.[0].url ?? "", /contribution\.usercontent\.google\.com\/download/);
  assert.equal(writes, 1);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/batchexecute")).length, 1);
});

test("Gemini media quota code is typed only for generation and never for ordinary chat", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (url.pathname === "/app") return new Response(html(), { headers: { "Content-Type": "text/html" } });
    if (url.pathname.endsWith("/batchexecute")) return quotaRPCResponse([false, 0, null]);
    const empty = JSON.stringify(Array(26).fill(null));
    const part = ["wrb.fr", null, empty, null, null, [null, null, [[null, [1037]]]]];
    return new Response(`)]}'\n${JSON.stringify([part])}\ndi`, { headers: { "Content-Type": "application/json" } });
  } });
  await assert.rejects(client.generateMedia({ kind: "image", prompt: "A blue paper kite." }),
    (error: any) => error instanceof GeminiQuotaError && error.kind === "image" && !error.sessionUncertain);
  await assert.rejects(client.chat({ message: "ordinary question", thinking: false }),
    (error: any) => error.code === "stream_error" && !(error instanceof GeminiQuotaError));
  assert.equal(calls.filter(call => call.init?.method === "POST").length, 3);
});

test("definitive media quota reads the authoritative reset once and validates its scope", async () => {
  for (const [name, payload, expectedReset] of [
    ["future blocked reset", [true, 1, [Math.ceil((Date.now() + 60_000) / 1000)]], true],
    ["not blocked", [false, 0, [Math.ceil((Date.now() + 60_000) / 1000)]], false],
    ["missing reset", [true, 1, null], false],
    ["expired reset", [true, 1, [1]], false],
  ] as const) {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async (input, init) => {
      const url = new URL(String(input)); calls.push({ url, init });
      if (url.pathname === "/app") return new Response(html(), { headers: { "Content-Type": "text/html" } });
      if (url.pathname.endsWith("/StreamGenerate")) return quotaFailureStream();
      assert.equal(url.pathname, "/_/BardChatUi/data/batchexecute");
      assert.equal(url.searchParams.get("rpcids"), "aPya6c");
      assert.equal(url.searchParams.get("source-path"), "/app");
      const request = JSON.parse(new URLSearchParams(String(init?.body)).get("f.req")!);
      assert.deepEqual(request[0][0], ["aPya6c", "[]", null, "generic"]);
      return quotaRPCResponse(payload);
    } });
    await assert.rejects(client.generateMedia({ kind: "image", prompt: `quota ${name}` }), (error: any) => {
      assert.ok(error instanceof GeminiQuotaError);
      assert.equal(error.kind, "image");
      assert.equal(error.sessionUncertain, false);
      assert.equal(Boolean(error.resetAtMs), expectedReset);
      return true;
    });
    assert.equal(calls.filter(call => call.url.pathname.endsWith("/StreamGenerate")).length, 1);
    assert.equal(calls.filter(call => call.url.pathname.endsWith("/batchexecute")).length, 1);
  }
});

test("malformed quota read stops without returning typed quota or a retry signal", async () => {
  let posts = 0;
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/app") return new Response(html(), { headers: { "Content-Type": "text/html" } });
    posts++;
    if (url.pathname.endsWith("/StreamGenerate")) return quotaFailureStream();
    return quotaRPCResponse(["unexpected-shape"]);
  } });
  await assert.rejects(client.generateMedia({ kind: "video", prompt: "one video" }), (error: any) =>
    error.code === "invalid_response" && !(error instanceof GeminiQuotaError) && !error.sessionUncertain);
  assert.equal(posts, 2);
});

test("truncated quota RPC cannot provide a reset or authorize account fallback", async () => {
  let writes = 0;
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === "/app") return new Response(html(), { headers: { "Content-Type": "text/html" } });
    if (url.pathname.endsWith("/StreamGenerate")) { writes++; return quotaFailureStream(); }
    return new Response(")]}'\n" + JSON.stringify([["wrb.fr", "aPya6c", JSON.stringify([true, 1, [Math.ceil((Date.now() + 60000) / 1000)]])]]),
      { headers: { "Content-Type": "application/json" } });
  } });
  await assert.rejects(client.generateMedia({ kind: "video", prompt: "A drifting leaf." }), (error: any) =>
    error.code === "invalid_response" && !(error instanceof GeminiQuotaError));
  assert.equal(writes, 1);
});

test("quota read HTTP 429 is not reclassified as quota exhaustion or a media failover signal", async () => {
  let streamCalls = 0;
  let quotaCalls = 0;
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/app") return new Response(html(), { headers: { "Content-Type": "text/html" } });
    if (url.pathname.endsWith("/StreamGenerate")) { streamCalls++; return quotaFailureStream(); }
    quotaCalls++;
    return new Response("not quota data", { status: 429 });
  } });
  await assert.rejects(client.generateMedia({ kind: "video", prompt: "one video" }), (error: any) =>
    error.code === "rate_limit_error" && !(error instanceof GeminiQuotaError));
  assert.equal(streamCalls, 1);
  assert.equal(quotaCalls, 1);
});

test("authenticated media fetch restricts redirects and never forwards cookies to another host", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent, fetch: async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (url.hostname === "contribution.usercontent.google.com") {
      return new Response(null, { status: 302, headers: { Location: "https://accounts.google.com/ServiceLogin" } });
    }
    throw new Error("redirect was followed");
  } });
  const response = await client.fetchMedia("https://contribution.usercontent.google.com/download?c=vid&filename=video.mp4&opi=1");
  assert.equal(response.status, 302);
  assert.equal(calls.length, 1);
  assert.equal(new Headers(calls[0].init?.headers).get("cookie"), cookie);
  assert.equal(calls[0].init?.redirect, "manual");
});
