import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const framed = value => { const json = JSON.stringify(value); return (json.length + 2) + "\n" + json + "\n"; };
function stream(turn, content, complete = true) {
  const prefix = ")]}'\n\n" + framed([["wrb.fr", null, JSON.stringify([
    null, ["c_fixtureconversation", "r_fixturereply" + turn], null, null,
    [["rc_fixturecandidate" + turn, [content]]],
  ])]]);
  if (!complete) return prefix;
  const beforeAccounting = prefix + framed([["di", 1], ["af.httprm", 1, "fixture", 1]]);
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const raw = beforeAccounting + framed([["e", 4, null, null, total]]);
    const length = Buffer.byteLength(raw);
    if (length === total) return raw;
    total = length;
  }
  throw new Error("Invalid fixture accounting");
}
let writes = 0;
let failure;
let stage = "initialization";
const website = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.cookie, "__Secure-1PSID=fixture; __Secure-1PSIDTS=fixture");
    assert.equal(req.headers["user-agent"], "fixture-agent");
    if (req.method === "GET" && req.url === "/app") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<script>window.WIZ_global_data={"SNlM0e":"fixture-request-token","cfb2h":"fixture-build","FdrFJe":"fixture-page-session","oPEP7c":"fixture@example.invalid"};</script>');
      return;
    }
    assert.equal(req.method, "POST");
    assert.equal(new URL(req.url, "http://localhost").pathname, "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate");
    let body = ""; for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    assert.equal(form.get("at"), "fixture-request-token");
    const payload = JSON.parse(JSON.parse(form.get("f.req"))[1]);
    writes++;
    if (writes === 1) assert.deepEqual(payload[2].slice(0, 3), ["", "", ""]);
    else assert.deepEqual(payload[2].slice(0, 3), ["c_fixtureconversation", "r_fixturereply" + (writes - 1), "rc_fixturecandidate" + (writes - 1)]);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    if (payload[0][0] === "incomplete") {
      res.end(stream(writes, "partial useful text", false));
    } else res.end(stream(writes, "fixture answer " + writes + " 蓝色雨伞"));
  } catch (error) {
    failure = error;
    if (!res.headersSent) res.writeHead(500);
    res.end("fixture failure");
  }
});
let client, transport, directory;
try {
  await new Promise(resolve => website.listen(0, "127.0.0.1", resolve));
  directory = await mkdtemp(resolve(".validation-gemini-smoke-"));
  const env = {
    DEEPSEEK_USER_TOKEN: "", DOUBAO_COOKIE: "", GEMINI_COOKIE: "__Secure-1PSID=fixture; __Secure-1PSIDTS=fixture",
    GEMINI_USER_AGENT: "fixture-agent", GEMINI_WEB_BASE_URL: `http://127.0.0.1:${website.address().port}`,
    GEMINI_TIMEOUT: "5000", WEB_AI_SESSION_STORE_PATH: join(directory, "sessions.json"), WEB_AI_SESSION_TTL_MINUTES: "0",
  };
  const connect = async () => {
    client = new Client({ name: "gemini-fixture", version: "0" });
    transport = new StdioClientTransport({ command: process.env.WEB_AI_SMOKE_COMMAND || process.execPath,
      args: process.env.WEB_AI_SMOKE_ARGS ? JSON.parse(process.env.WEB_AI_SMOKE_ARGS) : [resolve("dist/index.js")],
      cwd: process.env.WEB_AI_SMOKE_CWD, env, stderr: "pipe" });
    transport.stderr?.on("data", () => {});
    await client.connect(transport);
  };
  const call = async (name, args = {}) => {
    stage = name;
    const result = await client.callTool({ name, arguments: args });
    return { result, error: Boolean(result.isError), text: result.content.filter(i => i.type === "text").map(i => i.text).join("\n") };
  };
  await connect();
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ["gemini_accounts", "gemini_chat", "gemini_download_media", "gemini_generate_image", "gemini_generate_video", "gemini_media_status", "gemini_session_close", "gemini_sessions_list", "webai_job_cancel", "webai_job_status", "webai_providers", "webai_usage"]);
  const providers = JSON.parse((await call("webai_providers")).text);
  assert.equal(providers.active.length, 1); assert.equal(providers.active[0].id, "gemini");
  assert.equal(providers.active[0].capabilities.thinking, false); assert.equal(providers.active[0].capabilities.files, false);
  const first = await call("gemini_chat", { message: "first-canary", conversation_name: "fixture", make_default: true });
  assert.equal(first.error, false);
  const key = first.text.match(/session_key: ([a-f0-9-]{36})/)?.[1]; assert.ok(key);
  assert.ok(!first.text.includes("c_fixtureconversation"));
  await client.close(); await transport.close(); await connect();
  const ack = await call("gemini_chat", { message: "follow-canary", background: true, request_id: randomUUID() });
  const job = ack.result._meta?.web_ai_job?.job_id; assert.ok(job);
  let completed;
  for (let i = 0; i < 100; i++) {
    completed = await call("webai_job_status", { job_id: job });
    if (completed.result._meta.web_ai_job.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(completed.result._meta.web_ai_job.status, "completed");
  assert.equal(completed.error, false); assert.ok(completed.text.includes(key)); assert.equal(writes, 2);
  const disk = await readFile(env.WEB_AI_SESSION_STORE_PATH, "utf8");
  for (const text of ["first-canary", "follow-canary", "__Secure-1PSID", "fixture-request-token", "fixture@example.invalid"]) assert.ok(!disk.includes(text));
  assert.equal((await call("gemini_chat", { message: "x", session_key: randomUUID() })).error, true);
  assert.equal((await call("gemini_chat", { message: "x", session_key: key, model: "Pro" })).error, true);
  assert.equal(writes, 2);
  assert.equal((await call("gemini_chat", { message: "incomplete", session_key: key })).error, true);
  assert.equal((await call("gemini_chat", { message: "never-send", session_key: key })).error, true); assert.equal(writes, 3);
  await client.close(); await transport.close(); await connect();
  assert.equal((await call("gemini_chat", { message: "never-replay", conversation_name: "fixture" })).error, true); assert.equal(writes, 3);
  assert.equal((await call("gemini_session_close", { session_key: key })).error, false);
  assert.equal((await call("gemini_chat", { message: "closed", session_key: key })).error, true); assert.equal(writes, 3);
  if (failure) throw failure;
  console.log(JSON.stringify({ mode: "Gemini local HTTP/stdio fixture; no website credentials", passed: ["Gemini-only twelve tools", "default chat", "background follow-up after process restart", "private secret-free lineage", "unsupported/unknown/closed selectors rejected before write", "incomplete streams remain blocked after restart"] }, null, 2));
} catch {
  console.error(`[gemini smoke] failed at ${stage}; private details suppressed`); process.exitCode = 1;
} finally {
  await client?.close(); await transport?.close();
  if (website.listening) await new Promise(resolve => website.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
}
