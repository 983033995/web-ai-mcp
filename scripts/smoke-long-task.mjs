import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const delayMs = Number(process.env.WEB_AI_LONG_SMOKE_DELAY_MS || "65000");
assert.ok(Number.isSafeInteger(delayMs) && delayMs >= 1 && delayMs <= 90000);
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
let writes = 0;
let timer;
let client;
let transport;
let directory;
let stage = "setup";
const website = createServer(async (req, res) => {
  try {
    assert.equal(new URL(req.url, "http://localhost").pathname, "/chat/completion");
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.option.need_deep_think, 3);
    writes++;
    res.setHeader("content-type", "text/event-stream");
    res.write(frame("SSE_ACK", { ack_client_meta: { conversation_id: "fixture-conv", section_id: "fixture-sec" } }));
    timer = setTimeout(() => res.end(frame("STREAM_MSG_NOTIFY", { message_id: "fixture-reply", message_index: 2,
      content: { content_block: [{ block_type: 10000, block_id: "text", content: { text_block: { text: "long-task-fixture-result" } } }] } }) +
      frame("SSE_REPLY_END", { end_type: 3 })), delayMs);
  } catch { res.statusCode = 400; res.end("Local fixture rejected the request"); }
});
try {
  directory = await mkdtemp(resolve(".validation-long-smoke-"));
  website.listen(0, "127.0.0.1"); await once(website, "listening");
  const env = { DEEPSEEK_USER_TOKEN: "", DOUBAO_COOKIE: "sessionid=fixture; passport_csrf_token=fixture; s_v_web_id=fixture",
    DOUBAO_CHAT_URL: `http://127.0.0.1:${website.address().port}/chat/completion?aid=497858&device_id=1&web_id=2&tea_uuid=3&fp=fixture&pc_version=3.41.4&region=CN&sys_region=CN&web_tab_id=fixture`,
    DOUBAO_USER_AGENT: "fixture", DOUBAO_TIMEOUT: String(delayMs + 10000), WEB_AI_SESSION_STORE_PATH: join(directory, "sessions.json") };
  client = new Client({ name: "long-task-fixture", version: "0" });
  transport = new StdioClientTransport({ command: process.env.WEB_AI_SMOKE_COMMAND || process.execPath,
    args: process.env.WEB_AI_SMOKE_ARGS ? JSON.parse(process.env.WEB_AI_SMOKE_ARGS) : [resolve("dist/index.js")],
    cwd: process.env.WEB_AI_SMOKE_CWD, env, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  await client.connect(transport);
  const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 3000 });
  stage = "submit";
  const args = { message: "non-sensitive-long-task-fixture", conversation_name: "long-fixture", background: true, request_id: randomUUID() };
  const started = Date.now();
  const ack = await call("doubao_reasoner", args);
  assert.equal(ack.isError, undefined); assert.equal(ack._meta.web_ai_job.status, "running");
  const jobId = ack._meta.web_ai_job.job_id;
  console.log(JSON.stringify({ stage: "background acknowledged", elapsedMs: Date.now() - started, websiteDelayMs: delayMs }));
  const duplicate = await call("doubao_reasoner", args);
  assert.equal(duplicate._meta.web_ai_job.job_id, jobId);
  let result;
  stage = "read-only polling";
  do {
    result = await call("webai_job_status", { job_id: jobId });
    if (result._meta.web_ai_job.status !== "running") break;
    assert.ok(Date.now() - started < delayMs + 15000);
    await new Promise(resolve => setTimeout(resolve, Math.min(10000, delayMs)));
  } while (true);
  assert.equal(result._meta.web_ai_job.status, "completed"); assert.equal(result.isError, undefined);
  assert.ok(result.content.some(c => c.type === "text" && c.text.includes("long-task-fixture-result")));
  assert.equal(writes, 1);
  const disk = await readFile(env.WEB_AI_SESSION_STORE_PATH, "utf8");
  assert.ok(!disk.includes(args.message) && !disk.includes("long-task-fixture-result") && !disk.includes("sessionid="));
  assert.equal(JSON.parse(disk).sessions[0].state, "active");
  console.log(JSON.stringify({ mode: "local HTTP/stdio fixture; no website account", passed: true,
    websiteDelayMs: delayMs, clientCallTimeoutMs: 3000, writes, elapsedMs: Date.now() - started }));
} catch {
  console.error(JSON.stringify({ stage, passed: false, details: "Local long-task smoke failed; sensitive output suppressed" }));
  process.exitCode = 1;
} finally {
  if (timer) clearTimeout(timer);
  await client?.close(); await transport?.close();
  if (website.listening) await new Promise(resolve => website.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
}
