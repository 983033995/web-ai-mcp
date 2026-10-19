import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseSSE } from "../src/providers/doubao/sse.js";

const frame = (event: string, value: unknown) => `event: ${event}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
const block = (text: string, type = 10000, key = "b1") => ({ block_type: type, block_id: key, content: { text_block: { text } } });
const ack = frame("SSE_ACK", { ack_client_meta: { conversation_id: "conv", section_id: "sec" }, query_list: [{ question_id: "question" }] });
const initial = frame("STREAM_MSG_NOTIFY", { message_id: "answer", message_index: 2, content: { content_block: [block("你")] } });
const end = frame("SSE_REPLY_END", { end_type: 3 });
function stream(text: string, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(c) {
    for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
    c.close();
  } });
}
const parse = (text: string) => parseSSE(stream(text), new AbortController().signal);
const patch = (text: string, type = 1) => frame("STREAM_CHUNK", { message_id: "answer", patch_op: [{ patch_object: 1, patch_type: type, patch_value: { content_block: [block(text)] } }] });

test("Doubao SSE handles UTF8, block snapshots and append/replace patches without echoing user message", async () => {
  const text = frame("SSE_HEARTBEAT", {}) + ack + frame("FULL_MSG_NOTIFY", { message: { content: "user echo" } }) + initial + patch("好") + patch("替换", 2) +
    frame("STREAM_CHUNK", { message_id: "answer", patch_op: [{ patch_object: 111, patch_type: 1, patch_value: { tts_content: "ignored" } }] }) +
    frame("STREAM_MSG_NOTIFY", { message_id: "answer", content: { content_block: [block("最终答案"), block("可见思考", 10040, "r1")] } }) + end;
  const reply = await parse(text);
  assert.equal(reply.content, "最终答案");
  assert.equal(reply.reasoning, "可见思考");
  assert.equal(reply.conversationId, "conv");
  assert.equal(reply.messageId, "answer");
  assert.equal(reply.messageIndex, 2);
});

test("Doubao SSE retains appended deltas and final message ID when initial metadata is absent", async () => {
  const text = ack + frame("STREAM_MSG_NOTIFY", { content: { content_block: [block("HE")] } }) +
    frame("STREAM_CHUNK", { message_id: "answer", patch_op: [{ patch_object: 1, patch_type: 1, patch_value: { content_block: [block("LLO")] } }] }) +
    frame("SSE_REPLY_END", { end_type: 1, msg_finish_attr: { msgid: "answer" } }) + end;
  const reply = await parse(text);
  assert.equal(reply.content, "HELLO");
  assert.equal(reply.messageId, "answer");
});

test("Doubao SSE reads real website nested reply metadata and text-free finish patch", async () => {
  const start = frame("STREAM_MSG_NOTIFY", { meta: { message_id: "answer", index_in_conv: 2, conversation_id: "conv", section_id: "sec" },
    content: { content_block: [block("OK")] } });
  const finish = frame("STREAM_CHUNK", { message_id: "answer", patch_op: [{ patch_object: 1, patch_type: 1,
    patch_value: { content_block: [{ block_type: 10000, block_id: "b1", content: { text_block: {} }, is_finish: true }] } }] });
  const result = await parse(ack + start + finish + end);
  assert.equal(result.content, "OK");
  assert.equal(result.messageId, "answer");
  assert.equal(result.messageIndex, 2);
  await assert.rejects(parse(ack + start.replace('"conversation_id":"conv"', '"conversation_id":"wrong"') + end));
});

test("Doubao CHUNK_DELTA inherits the last single content patch across TTS events", async () => {
  const tts = frame("STREAM_CHUNK", { message_id: "answer", patch_op: [{ patch_object: 111, patch_type: 1, patch_value: { tts_content: "ignored" } }] });
  const text = ack + initial + patch("好") + tts + frame("CHUNK_DELTA", { text: "，世界" }) + frame("CHUNK_DELTA", { text: "！" }) +
    frame("STREAM_CHUNK", { message_id: "answer", patch_op: [{ patch_object: 1, patch_type: 1,
      patch_value: { content_block: [{ block_type: 10000, block_id: "b1", content: { text_block: {} }, is_finish: true }] } }] }) + end;
  const reply = await parse(text);
  assert.equal(reply.content, "你好，世界！");
  assert.equal(reply.messageId, "answer");
  assert.equal(reply.messageIndex, 2);
});

test("Doubao CHUNK_DELTA follows content block changes and keeps reasoning separate", async () => {
  const thinking = frame("STREAM_CHUNK", { message_id: "answer", patch_op: [{ patch_object: 1, patch_type: 1,
    patch_value: { content_block: [block("推", 10040, "r1")] } }] });
  const reply = await parse(ack + initial + thinking + frame("CHUNK_DELTA", { text: "理" }) + patch("好") + frame("CHUNK_DELTA", { text: "！" }) + end);
  assert.equal(reply.content, "你好！");
  assert.equal(reply.reasoning, "推理");
});

test("Doubao CHUNK_DELTA rejects missing context and malformed text", async () => {
  for (const text of [ack + initial + frame("CHUNK_DELTA", { text: "orphan" }) + end,
    ack + initial + patch("好") + frame("CHUNK_DELTA", { text: {} }) + end]) {
    await assert.rejects(parse(text), (error: any) => error.code === "malformed_sse" && error.sessionUncertain);
  }
});

test("Doubao real thinking container children stay separate from the answer through deltas", async () => {
  const container = { block_type: 10040, block_id: "think", content: { thinking_block: { streaming_title: "Thinking" } }, is_finish: false };
  const child = { ...block("", 10000, "child"), parent_id: "think" };
  const start = frame("STREAM_MSG_NOTIFY", { message_id: "answer", message_index: 2, content: { content_block: [container] } });
  const chunk = (value: unknown) => frame("STREAM_CHUNK", { message_id: "answer", patch_op: [{ patch_object: 1, patch_type: 1, patch_value: { content_block: [value] } }] });
  const thought = chunk({ ...child, content: { text_block: { summary: "" } } }) + frame("CHUNK_DELTA", { text: "private reasoning" });
  const finish = chunk({ ...container, is_finish: true });
  const answer = chunk(block("answer only", 10000, "final")) + frame("CHUNK_DELTA", { text: "." });
  const reply = await parse(ack + start + thought + finish + answer + end);
  assert.equal(reply.reasoning, "private reasoning");
  assert.equal(reply.content, "answer only.");
});

test("Doubao file metadata and deletion patches remove loading blocks without dropping the answer", async () => {
  const loading = { block_type: 10101, block_id: "loading", content: { loading_block: {} } };
  const chunk = (value: unknown, type: number) => frame("STREAM_CHUNK", { message_id: "answer", patch_op: [{ patch_object: 1, patch_type: type, patch_value: { content_block: [value] } }] });
  const reply = await parse(ack + frame("DOWNSTREAM_VERBOSE_INFO", { verbose_type: "fixture", verbose_payload: "private metadata" }) +
    frame("STREAM_MSG_NOTIFY", { message_id: "answer", content: { content_block: [loading] } }) + chunk({ ...loading, content: {} }, 3) +
    chunk(block("file answer", 10000, "final"), 1) + end);
  assert.equal(reply.content, "file answer");
  assert.equal(reply.reasoning, undefined);
});

test("Doubao thinking refuses dangling, cyclic or reassigned parent IDs", async () => {
  const chunk = (values: unknown[]) => frame("STREAM_MSG_NOTIFY", { message_id: "answer", content: { content_block: values } });
  for (const values of [[{ ...block("hidden"), parent_id: "missing" }],
    [{ ...block("a", 10000, "a"), parent_id: "b" }, { ...block("b", 10000, "b"), parent_id: "a" }]]) {
    await assert.rejects(parse(ack + chunk(values) + end));
  }
  await assert.rejects(parse(ack + initial + chunk([{ ...block("hidden"), parent_id: "think" }]) + end));
});

test("Doubao SSE accepts multiline data and final event without newline", async () => {
  const ending = 'event: SSE_REPLY_END\ndata:{\ndata:"end_type":3}';
  assert.equal((await parse(ack + initial + ending)).content, "你");
});

for (const [name, text] of Object.entries({
  truncated: ack + initial,
  emptyError: ack + initial + frame("STREAM_ERROR", {}) + end,
  missingErrorBody: ack + initial + "event: STREAM_ERROR\n\n" + end,
  brokenJSON: ack + initial + "event: STREAM_CHUNK\ndata:invalid\n\n" + end,
  badBlock: ack + initial + frame("STREAM_CHUNK", { patch_op: [{ patch_object: 1, patch_type: 1, patch_value: { content_block: [null] } }] }) + end,
  badPatch: ack + initial + patch("bad", 999) + end,
  unknownEvent: ack + initial + frame("UNSUPPORTED_EVENT", {}) + end,
  wrongID: ack + initial + frame("STREAM_CHUNK", { message_id: "different", patch_op: [] }) + end,
  objectID: frame("SSE_ACK", { ack_client_meta: { conversation_id: {}, section_id: "sec" } }) + initial + end,
  reasoningOnly: ack + frame("STREAM_MSG_NOTIFY", { content: { content_block: [block("thought", 10040, "r")] } }) + end,
  doneMarkerOnly: ack + initial + "data:[DONE]\n\n"
})) {
  test(`Doubao SSE rejects ${name} instead of returning partial success`, async () => {
    await assert.rejects(parse(text));
  });
}

test("Doubao SSE identifies wrapped and numeric auth errors without exposing upstream content", async () => {
  for (const value of [{ code: 710012001, message: "secret" }, { code: "Internal", message: "ErrorX:code=710012000 secret" }]) {
    await assert.rejects(parse(frame("gateway-error", value)), (e: any) => e.code === "authentication_error" && !e.sessionUncertain && !e.message.includes("secret"));
  }
});

test("Doubao SSE identifies website error_code captcha envelope without echoing challenge data", async () => {
  await assert.rejects(parse(frame("STREAM_ERROR", { error_code: 710022004, error_msg: "SECRET_CANARY", extra: { decision: "private challenge" } })),
    (e: any) => e.code === "captcha_required" && !e.sessionUncertain && !e.message.includes("SECRET_CANARY"));
});

test("Doubao SSE errors after ACK remain uncertain, including authentication and captcha", async () => {
  for (const code of [710022004, 710012001, 999]) {
    await assert.rejects(parse(ack + initial + frame("STREAM_ERROR", { code, message: "SECRET_CANARY" })), (e: any) => e.sessionUncertain && !e.message.includes("SECRET_CANARY"));
  }
});

test("Doubao SSE refuses to remap a resumed conversation", async () => {
  await assert.rejects(parseSSE(stream(ack + initial + end), new AbortController().signal, "different"));
});

test("Doubao SSE never substitutes user question ID for assistant reply ID", async () => {
  const reply = await parse(ack + frame("STREAM_MSG_NOTIFY", { content: { content_block: [block("answer")] } }) + end);
  assert.equal(reply.messageId, undefined);
});

test("Doubao SSE cancellation interrupts stalled read and releases stream", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = parseSSE(body, controller.signal);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});
