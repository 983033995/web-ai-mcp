import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const live = process.argv.includes("--live");
const files = !live || process.argv.includes("--files");
const marker = "mcp-" + randomUUID();
const token = live ? process.env.DEEPSEEK_USER_TOKEN : "local-fixture-token";
let stage = "configuration";
let failureReason = "check failed";
let directory;
let website;
let client;
let transport;
const evidence = [];
const expectedTools = ["deepseek_chat", "deepseek_reasoner", "deepseek_analyze_files",
  "deepseek_sessions_list", "deepseek_session_close", "webai_providers"].sort();

function localWebsite() {
  let nextId = 0;
  const sessions = new Map();
  const json = (response, data) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: data } }));
  };
  return createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer " + token);
      const url = new URL(request.url, "http://localhost");
      let body = "";
      for await (const chunk of request) body += chunk;
      if (url.pathname.endsWith("/chat_session/create")) {
        const id = "fixture-session-" + sessions.size;
        sessions.set(id, { parent: null });
        return json(response, { id });
      }
      if (url.pathname.endsWith("/chat/create_pow_challenge")) {
        return json(response, { challenge: {
          algorithm: "DeepSeekHashV1",
          challenge: "00b5e095165887351002858453f394a138129d26509aa07eb41e1c289a39bb5d",
          salt: "fixture", expire_at: 1_900_000_000, difficulty: 1, signature: "fixture",
          target_path: JSON.parse(body).target_path
        } });
      }
      if (url.pathname.endsWith("/file/fetch_files")) {
        return json(response, { files: [{ id: "fixture-file", status: "SUCCESS" }] });
      }
      const proof = JSON.parse(Buffer.from(request.headers["x-ds-pow-response"], "base64").toString());
      assert.equal(proof.answer, 0);
      if (url.pathname.endsWith("/file/upload_file")) {
        assert.equal(proof.target_path, "/api/v0/file/upload_file");
        assert.match(request.headers["content-type"], /multipart\/form-data/);
        assert.ok(body.includes("web-ai-mcp non-sensitive smoke fixture"));
        return json(response, { id: "fixture-file" });
      }
      assert.equal(url.pathname, "/api/v0/chat/completion");
      assert.equal(proof.target_path, "/api/v0/chat/completion");
      const payload = JSON.parse(body);
      const session = sessions.get(payload.chat_session_id);
      assert.ok(session);
      assert.equal(payload.parent_message_id, session.parent);
      assert.equal(payload.search_enabled, false);
      if (payload.ref_file_ids.length) assert.deepEqual(payload.ref_file_ids, ["fixture-file"]);
      session.parent = ++nextId;
      const content = payload.thinking_enabled ? "918" : payload.ref_file_ids.length ? "file fixture reviewed" : marker;
      const fragments = payload.thinking_enabled
        ? [{ type: "THINKING", content: "27 * 34 = 918" }, { type: "RESPONSE", content }]
        : [{ type: "RESPONSE", content }];
      response.setHeader("Content-Type", "text/event-stream");
      response.end("event: ready\ndata: " + JSON.stringify({ response_message_id: session.parent }) +
        "\n\ndata: " + JSON.stringify({ v: { response: { fragments, status: "FINISHED" } } }) + "\n\n");
    } catch {
      response.statusCode = 400;
      response.end("Local website fixture validation failed");
    }
  });
}

try {
  assert.ok(token?.trim());
  directory = await mkdtemp(resolve(".validation-smoke-"));
  const env = { DEEPSEEK_USER_TOKEN: token, DEEPSEEK_TIMEOUT: process.env.DEEPSEEK_TIMEOUT || "120000",
    WEB_AI_PROJECT_ROOT: directory, WEB_AI_SESSION_TTL_MINUTES: "0" };
  if (!live) {
    website = localWebsite();
    website.listen(0, "127.0.0.1");
    await once(website, "listening");
    env.DEEPSEEK_WEB_BASE_URL = `http://127.0.0.1:${website.address().port}/api/v0`;
  }
  if (files) {
    await writeFile(join(directory, "fixture.txt"), "web-ai-mcp non-sensitive smoke fixture\n");
    env.WEB_AI_ALLOWED_ROOTS = directory;
  }
  client = new Client({ name: "web-ai-mcp-smoke", version: "0.1.0" });
  transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/index.js")], env, stderr: "pipe" });
  // Consume stderr without printing credentials, upstream IDs or response bodies.
  transport.stderr?.on("data", () => {});
  stage = "stdio initialize";
  await client.connect(transport);
  const call = async (name, args = {}) => {
    stage = name;
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: Number(env.DEEPSEEK_TIMEOUT) + 5000
    });
    const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    return { error: !!result.isError, text };
  };
  const successful = async (name, args) => {
    const result = await call(name, args);
    if (result.error) {
      const code = result.text.match(/\[(authentication_error|access_denied|rate_limit_error|http_error|website_error|invalid_response|malformed_sse|stream_error|timeout_error|network_error|cancelled|pow_challenge_error|pow_solve_error|file_parse_error|file_parse_timeout)\]/)?.[1];
      failureReason = code || "MCP tool returned an error";
    }
    assert.equal(result.error, false);
    assert.ok(result.text.trim());
    return result.text;
  };
  const getKey = (text) => {
    const key = text.match(/session_key: ([a-f0-9-]{36})/)?.[1];
    assert.ok(key);
    return key;
  };
  stage = "tools/list";
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), expectedTools);
  evidence.push("six MCP tools discovered");
  const providers = JSON.parse(await successful("webai_providers"));
  assert.deepEqual(providers.active.map((provider) => provider.id), ["deepseek"]);
  assert.equal(providers.active[0].capabilities.webSearch, false);
  assert.equal(providers.planned[0].status, "not_implemented");
  evidence.push("DeepSeek active; Doubao not implemented; search disabled");

  const first = await successful("deepseek_chat", { message: `请记住测试标记 ${marker}。只回答 OK。`,
    conversation_name: "smoke-project", make_default: true });
  const session_key = getKey(first);
  const follow = await successful("deepseek_chat", { message: "刚才的测试标记是什么？只返回标记。", session_key });
  assert.equal(getKey(follow), session_key);
  assert.ok(follow.includes(marker));
  evidence.push("chat and same-session follow-up");
  await client.close();
  await transport.close();
  stage = "stdio restart and persisted conversation";
  client = new Client({ name: "web-ai-mcp-smoke-restart", version: "0.1.0" });
  transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/index.js")], env, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  await client.connect(transport);
  const persisted = await successful("deepseek_chat", { message: "刚才的测试标记是什么？只返回标记。" });
  assert.equal(getKey(persisted), session_key);
  assert.ok(persisted.includes(marker));
  evidence.push("project default and lineage resume after MCP process restart");
  const thinking = await successful("deepseek_reasoner", { message: "请计算 27 × 34，最终答案只给数字。", show_reasoning: true });
  failureReason = "thinking answer missing expected numeric result";
  const thinkingAnswer = thinking.split("## DeepSeek answer\n\n")[1]?.split("\n\n---\n\n")[0];
  assert.ok(thinkingAnswer?.includes("918"));
  failureReason = "website thinking text absent from result";
  assert.ok(thinking.includes("## DeepSeek thinking"));
  getKey(thinking);
  evidence.push("thinking and answer separation");

  if (files) {
    const analysis = await successful("deepseek_analyze_files", {
      file_paths: [join(directory, "fixture.txt")], instruction: "简述这个非敏感连通性测试文件的内容。"
    });
    const fileKey = getKey(analysis);
    const follow = await successful("deepseek_chat", { message: "用一句话概括刚才的文件。", session_key: fileKey });
    assert.equal(getKey(follow), fileKey);
    evidence.push("allowlisted fixture upload and follow-up");
  }
  const list = JSON.parse(await successful("deepseek_sessions_list"));
  assert.ok(list.some((entry) => entry.key === session_key));
  assert.ok(list.every((entry) => !("remote" in entry)));
  await successful("deepseek_session_close", { session_key });
  assert.equal((await call("deepseek_chat", { message: "x", session_key })).error, true);
  assert.equal((await call("deepseek_chat", { message: "x", session_key: randomUUID() })).error, true);
  evidence.push("session listing, close and unknown-key rejection");
  console.log(JSON.stringify({ mode: live ? "live website" : "local website fixture (not live)", passed: evidence, filesTested: files }, null, 2));
} catch {
  console.error(`[smoke] ${live ? "live" : "local"} validation failed at ${stage}: ${failureReason}; sensitive output suppressed`);
  console.log(JSON.stringify({ mode: live ? "live website" : "local website fixture (not live)", passed: evidence, failedAt: stage }, null, 2));
  if (!token) console.error("Set DEEPSEEK_USER_TOKEN securely before running smoke:live");
  process.exitCode = 1;
} finally {
  await client?.close();
  await transport?.close();
  if (website) await new Promise((resolve) => website.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
}
