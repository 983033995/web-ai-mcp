import { test } from "node:test";
import { strict as assert } from "node:assert";
import { DoubaoWebClient } from "../src/providers/doubao/web-client.js";
import { DoubaoWebProvider } from "../src/providers/doubao/index.js";

const cookie = "sessionid=synthetic; passport_csrf_token=synthetic-csrf; s_v_web_id=synthetic-fp";
const chatUrl = "https://www.doubao.com/chat/completion?aid=497858&device_id=111&web_id=222&tea_uuid=333&fp=synthetic-fp&pc_version=3.41.1&region=CN&sys_region=CN&web_tab_id=synthetic-tab";
const userAgent = "synthetic-test-agent";
const frame = (event: string, value: unknown) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
const reply = (metadata = true, conv = "conv", index = 2) => new Response(
  frame("SSE_ACK", { ack_client_meta: { conversation_id: conv, section_id: "sec" }, query_list: [{ question_id: "question" }] }) +
  frame("STREAM_MSG_NOTIFY", { ...(metadata ? { message_id: index === 2 ? "answer" : "answer-" + index, message_index: index } : {}), content: { content_block: [{ block_id: "b", block_type: 10000, content: { text_block: { text: "pong" } } }] } }) +
  frame("SSE_REPLY_END", { end_type: 3 }), { headers: { "Content-Type": "text/event-stream" } });
function fixture(response?: () => Response, timeout = 500) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = new DoubaoWebClient(cookie, { chatUrl, userAgent, timeout, fetch: async (url, init) => { calls.push({ url: String(url), init }); return response ? response() : reply(true, "conv", calls.length * 2); } });
  return { client, calls };
}

test("Doubao HTTP uses own complete URL/cookie, system prefix and validated persistent lineage", async () => {
  const { client, calls } = fixture();
  const provider = new DoubaoWebProvider(cookie, client);
  await provider.initialize();
  const first = await provider.chat({ message: "first", systemPrompt: "context", thinking: false });
  assert.equal(first.content, "pong");
  assert.equal(first.remoteSession?.lastMessageId, "answer");
  assert.equal(first.remoteSession?.lastMessageIndex, 2);
  await provider.chat({ message: "second", thinking: false }, first.remoteSession);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, chatUrl);
  const payloads = calls.map(c => JSON.parse(String(c.init?.body)));
  assert.equal(payloads[0].messages[0].content_block[0].content.text_block.text, "context\n\nfirst");
  assert.equal(payloads[0].option.need_create_conversation, true);
  assert.equal(payloads[1].option.need_create_conversation, false);
  assert.equal(payloads[1].client_meta.conversation_id, "conv");
  assert.equal(payloads[1].client_meta.last_section_id, "sec");
  assert.equal(payloads[1].client_meta.last_message_index, 2);
  assert.equal(payloads[1].client_meta.local_conversation_id, payloads[0].client_meta.local_conversation_id);
  assert.equal(new Headers(calls[0].init?.headers).get("cookie"), cookie);
  assert.equal(calls[0].init?.redirect, "error");
  assert.equal(provider.capabilities.thinking, true);
  assert.equal(provider.capabilities.files, true);
});

test("Doubao completed answer with missing lineage is nonresumable", async () => {
  const { client } = fixture(() => reply(false));
  const result = await new DoubaoWebProvider(cookie, client).chat({ message: "first", thinking: false });
  assert.equal(result.content, "pong");
  assert.equal(result.remoteSession, undefined);
  assert.ok(result.warning);
});

for (const [code, value] of [["authentication_error", { code: 710012001 }], ["captcha_required", { code: 710022004 }], ["website_error", { code: 123 }]] as const) {
  test(`Doubao HTTP200 JSON ${code} is explicit and safe`, async () => {
    const { client, calls } = fixture(() => Response.json({ ...value, message: "SECRET_CANARY" }));
    await assert.rejects(client.chat({ message: "ping", thinking: false }), (e: any) => e.code === code && !e.message.includes("SECRET_CANARY"));
    assert.equal(calls.length, 1);
  });
}

test("Doubao CAPTCHA stops subsequent website writes until the client is recreated", async () => {
  for (const response of [() => Response.json({ error_code: 710022004 }),
    () => new Response(frame("STREAM_ERROR", { error_code: 710022004, extra: { decision: "SECRET_CANARY" } }),
      { headers: { "Content-Type": "text/event-stream" } }),
    () => new Response(frame("SSE_ACK", { ack_client_meta: { conversation_id: "conv", section_id: "sec" } }) +
      frame("STREAM_ERROR", { error_code: 710022004 }), { headers: { "Content-Type": "text/event-stream" } })]) {
    const { client, calls } = fixture(response);
    await assert.rejects(client.chat({ message: "first", thinking: false }), (e: any) => e.code === "captcha_required");
    await assert.rejects(client.chat({ message: "another conversation", thinking: false }),
      (e: any) => e.code === "captcha_required" && !e.sessionUncertain && !e.message.includes("SECRET_CANARY"));
    assert.equal(calls.length, 1);
  }
});

for (const [status, code, uncertain] of [[401, "authentication_error", false], [403, "access_denied", false], [429, "rate_limit_error", false], [500, "http_error", true]] as const) {
  test(`Doubao HTTP${status} never retries or echoes body`, async () => {
    const { client, calls } = fixture(() => new Response("SECRET_CANARY", { status }));
    await assert.rejects(client.chat({ message: "ping", thinking: false }), (e: any) => e.code === code && e.sessionUncertain === uncertain && !e.message.includes("SECRET_CANARY"));
    assert.equal(calls.length, 1);
  });
}

test("Doubao fails closed on invalid credentials, URL, UA and timeout", () => {
  for (const raw of ["", "locale=zh", "sessionid=only", cookie + "\r\nInjected: x"]) assert.throws(() => new DoubaoWebClient(raw, { chatUrl, userAgent }));
  for (const url of ["bad", chatUrl.replace("www.doubao.com", "evil.test"), chatUrl.replace("/chat/completion", "/other"), chatUrl + "#hash", chatUrl.replace("fp=synthetic-fp", "fp=other"), chatUrl + "&aid=123", chatUrl + "&sessionid=secret"]) {
    assert.throws(() => new DoubaoWebClient(cookie, { chatUrl: url, userAgent }), (e: any) => e.code === "configuration_error" && !e.message.includes("secret"));
  }
  assert.throws(() => new DoubaoWebClient(cookie, { chatUrl, userAgent: "\r\n" }));
  assert.throws(() => new DoubaoWebClient(cookie, { chatUrl, userAgent, timeout: -1 }));
});

test("Doubao invalid remote state and empty messages fail before dispatch", async () => {
  const { client, calls } = fixture();
  for (const previous of [{}, { conversationId: "conv", sectionId: "sec", lastMessageId: "answer" }, { conversationId: true }]) {
    await assert.rejects(client.chat({ message: "ping", thinking: false }, previous), (e: any) => e.code === "session_state_error");
  }
  await assert.rejects(client.chat({ message: " ", thinking: false }));
  assert.equal(calls.length, 0);
});

test("Doubao expert mode sends observed model parameters and returns separated reasoning", async () => {
  const { client, calls } = fixture(() => new Response(
    frame("SSE_ACK", { ack_client_meta: { conversation_id: "conv", section_id: "sec" } }) +
    frame("STREAM_MSG_NOTIFY", { message_id: "answer", message_index: 2, content: { content_block: [
      { block_type: 10040, block_id: "think", content: { thinking_block: {} } },
      { block_type: 10000, block_id: "child", parent_id: "think", content: { text_block: { text: "thought" } } },
      { block_type: 10000, block_id: "final", content: { text_block: { text: "answer" } } }
    ] } }) + frame("SSE_REPLY_END", { end_type: 3 }), { headers: { "Content-Type": "text/event-stream" } }));
  const result = await new DoubaoWebProvider(cookie, client).chat({ message: "expert", thinking: true });
  assert.equal(result.content, "answer"); assert.equal(result.reasoning, "thought");
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.option.need_deep_think, 3);
  assert.equal(body.ext.use_deep_think, "3");
  assert.deepEqual(body.option.model_config, { model_item_key: "3", model_extra_params: {}, reasoning_effort: 4 });
});

test("Doubao rejects invalid file sets before upload and blocks chats after an upload CAPTCHA", async () => {
  let calls = 0;
  const client = new DoubaoWebClient(cookie, { chatUrl, userAgent, fetch: async () => { calls++; return Response.json({ code: 710022004 }); } });
  for (const files of [[], [{ name: "fixture.pdf", buffer: Buffer.from("data") }],
    [{ name: "fixture.txt", buffer: Buffer.alloc(0) }]]) {
    await assert.rejects(client.analyzeFiles(files, "read", false));
  }
  assert.equal(calls, 0);
  await assert.rejects(client.analyzeFiles([{ name: "fixture.txt", buffer: Buffer.from("fixture") }], "read", false),
    (e: any) => e.code === "captcha_required" && !e.sessionUncertain);
  await assert.rejects(client.chat({ message: "next", thinking: false }), (e: any) => e.code === "captcha_required" && !e.sessionUncertain);
  assert.equal(calls, 1);
});

test("Doubao upload timeout never sends a chat or invalidates website lineage", async () => {
  let calls = 0;
  const client = new DoubaoWebClient(cookie, { chatUrl, userAgent, timeout: 20,
    fetch: async () => { calls++; return new Response(new ReadableStream(), { headers: { "Content-Type": "application/json" } }); } });
  await assert.rejects(client.analyzeFiles([{ name: "fixture.txt", buffer: Buffer.from("fixture") }], "read", true),
    (e: any) => e.code === "timeout_error" && !e.sessionUncertain);
  assert.equal(calls, 1);
});

test("Doubao rejects conversation remapping after write", async () => {
  const { client } = fixture(() => reply(true, "new-conv"));
  await assert.rejects(client.chat({ message: "ping", thinking: false }, { conversationId: "conv", sectionId: "sec", lastMessageId: "old-answer", lastMessageIndex: 2, localConversationId: "local-old" }), (e: any) => e.sessionUncertain);
});

test("Doubao refuses repeated or regressed reply lineage after a continuation write", async () => {
  const previous = { conversationId: "conv", sectionId: "sec", lastMessageId: "answer", lastMessageIndex: 8, localConversationId: "local" };
  for (const response of [() => reply(true, "conv", 2), () => reply(true, "conv", 8),
    () => reply(true, "conv", 10).text().then(text => new Response(text.replace('"answer-10"', '"answer"'), { headers: { "Content-Type": "text/event-stream" } }))]) {
    const client = new DoubaoWebClient(cookie, { chatUrl, userAgent, fetch: async () => await response() });
    await assert.rejects(client.chat({ message: "continue", thinking: false }, previous),
      (e: any) => e.code === "session_state_error" && e.sessionUncertain);
  }
});

test("Doubao cancellation and network failure never retry", async () => {
  const { client, calls } = fixture();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.chat({ message: "ping", thinking: false, signal: controller.signal }), (e: any) => e.code === "cancelled" && !e.sessionUncertain);
  assert.equal(calls.length, 0);
  let count = 0;
  const failed = new DoubaoWebClient(cookie, { chatUrl, userAgent, fetch: async () => { count++; throw new Error("SECRET_CANARY"); } });
  await assert.rejects(failed.chat({ message: "ping", thinking: false }), (e: any) => e.code === "network_error" && e.sessionUncertain && !e.message.includes("SECRET_CANARY"));
  assert.equal(count, 1);
});

for (const contentType of ["text/event-stream", "application/json"]) {
  test(`Doubao timeout covers stalled ${contentType} body`, async () => {
    const { client } = fixture(() => new Response(new ReadableStream(), { headers: { "Content-Type": contentType } }), 20);
    await assert.rejects(client.chat({ message: "ping", thinking: false }), (e: any) => e.code === "timeout_error" && e.sessionUncertain);
  });
}

test("Doubao rejects unexpected, oversized and malformed JSON responses", async () => {
  for (const response of [() => new Response("html", { headers: { "Content-Type": "text/html" } }), () => new Response("invalid", { headers: { "Content-Type": "application/json" } }), () => Response.json({ huge: "x".repeat(70000) })]) {
    const { client } = fixture(response);
    await assert.rejects(client.chat({ message: "ping", thinking: false }), (e: any) => e.code === "invalid_response" && e.sessionUncertain);
  }
});
