import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseSSE } from "../src/providers/deepseek/sse.js";

function stream(text: string, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
    controller.close();
  } });
}
const data = (value: unknown) => "data: " + JSON.stringify(value) + "\r\n\r\n";

test("SSE preserves UTF-8 and separates thinking across APPEND/BATCH fragment transitions", async () => {
  const text = ": heartbeat\r\n\r\nevent: ready\r\n" + data({ response_message_id: 12 }) +
    data({ v: { response: { fragments: [{ type: "THINKING", content: "思" }] } } }) +
    data({ p: "response/fragments/-1/content", o: "APPEND", v: "考" }) + data({ v: "中" }) +
    data({ p: "response", o: "BATCH", v: [
      { p: "fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "答" }] },
      { p: "accumulated_token_usage", v: 8 }
    ] }) + data({ p: "response/fragments/-1/content", o: "APPEND", v: "案" }) +
    data({ p: "response/status", o: "SET", v: "FINISHED" });
  assert.deepEqual(await parseSSE(stream(text), new AbortController().signal), {
    content: "答案", reasoning: "思考中", messageId: 12, totalTokens: 8
  });
});

test("SSE accepts legacy website fields, multiline data and final event without newline", async () => {
  const text = 'data:{"v":\n' + 'data:{"response":{"message_id":4,"content":"Hello"}}}\n\n' +
    data({ p: "response/content", o: "APPEND", v: " world" }) + "data:[DONE]";
  const reply = await parseSSE(stream(text, 7), new AbortController().signal);
  assert.equal(reply.content, "Hello world");
  assert.equal(reply.messageId, 4);
});

test("current website THINK fragments and elapsed-time patches retain reasoning", async () => {
  // Structural fixture from authorized website smoke; all IDs/text are synthetic.
  const text = "event: ready\n" + data({ response_message_id: 2 }) +
    data({ v: { response: { fragments: [{ type: "THINK", content: "calculation" }] } } }) +
    data({ p: "response/fragments/-1/content", o: "APPEND", v: " step" }) +
    data({ p: "response/fragments/-1/elapsed_secs", o: "SET", v: 1 }) +
    data({ p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "918" }] }) +
    data({ p: "response", o: "BATCH", v: [{ p: "accumulated_token_usage", v: 12 }, { p: "quasi_status", v: "COMPLETE" }] }) +
    data({ p: "response/status", o: "SET", v: "FINISHED" });
  const result = await parseSSE(stream(text), new AbortController().signal);
  assert.equal(result.content, "918");
  assert.equal(result.reasoning, "calculation step");
});

test("website inherits APPEND independently of path changes after thinking", async () => {
  const text = data({ v: { response: { fragments: [{ type: "THINK", content: "thought" }] } } }) +
    data({ p: "response/fragments/-1/content", o: "APPEND", v: " complete" }) +
    data({ p: "response/fragments/-1/elapsed_secs", o: "SET", v: 2 }) +
    data({ p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "镜头" }] }) +
    data({ p: "response/fragments/-1/content", v: "设计" }) + data({ v: "完整" }) + data({ v: "。" }) +
    data({ p: "response/status", o: "SET", v: "FINISHED" });
  const result = await parseSSE(stream(text), new AbortController().signal);
  assert.equal(result.content, "镜头设计完整。");
  assert.equal(result.reasoning, "thought complete");
});

test("SSE rejects malformed, truncated, error and prototype-changing responses", async () => {
  for (const text of [
    "data: not json\n\n",
    data({ v: { response: { content: "partial" } } }),
    "event: error\n" + data({ message: "secret must not be echoed" }),
    data({ p: "__proto__/polluted", v: "yes" }) + "data: [DONE]\n\n",
    data({ v: { response: { fragments: [{ type: "UNKNOWN", content: "x" }], status: "FINISHED" } } })
  ]) {
    await assert.rejects(parseSSE(stream(text), new AbortController().signal), (error: any) => {
      assert.ok(error.sessionUncertain);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  }
  assert.equal(({} as any).polluted, undefined);
});

test("SSE cancellation interrupts a stalled body and releases it", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const reply = parseSSE(body, controller.signal);
  controller.abort();
  await assert.rejects(reply);
  assert.equal(cancelled, true);
});
