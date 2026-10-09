import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, symlink, truncate, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SessionStore } from "../src/core/session-store.js";
import { ProviderError, type WebAIProvider } from "../src/core/provider.js";
import { registerDeepSeekTools } from "../src/tools/deepseek.js";

async function fixture(sessions = new SessionStore()) {
  const calls: Array<{ request: any; previous: any }> = [];
  const uploads: any[] = [];
  const provider: WebAIProvider = {
    id: "deepseek", displayName: "fixture", capabilities: { chat: true, thinking: true, files: true, webSearch: false, sessionResume: true },
    async initialize() {},
    async chat(request, previous) {
      calls.push({ request, previous });
      if (request.message === "ambiguous") throw new ProviderError("transport failed", "network_error", true);
      if (request.message === "rejected") throw new ProviderError("HTTP 429", "rate_limit_error");
      if (request.message === "expired-token") throw new ProviderError("更新 DEEPSEEK_USER_TOKEN，然后重启 MCP 服务", "authentication_error");
      if (request.message === "no-id") return { content: "useful answer", warning: "not resumable" };
      return { content: "answer", reasoning: "thought", remoteSession: { sessionId: "hidden-id", lastMessageId: Number(previous?.lastMessageId ?? 0) + 1 } };
    },
    async analyzeFiles(files, instruction, thinking, signal) {
      uploads.push({ files, instruction, thinking, signal });
      return { content: "file answer", remoteSession: { sessionId: "file-hidden-id", lastMessageId: 10 } };
    }
  };
  const server = new McpServer({ name: "fixture", version: "0" });
  registerDeepSeekTools(server, provider, sessions);
  const client = new Client({ name: "fixture", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return { error: !!response.isError, text: (response.content as any[]).filter((item) => item.type === "text").map((item) => item.text).join("\n") };
  };
  return { call, calls, uploads, sessions, client, server };
}
const key = (text: string) => text.match(/session_key: ([a-f0-9-]+)/)![1];

test("MCP validates tools, preserves lineage, separates reasoning and hides remote IDs", async (t) => {
  const f = await fixture();
  t.after(async () => { await f.client.close(); await f.server.close(); });
  assert.equal((await f.client.listTools()).tools.length, 5);
  const first = await f.call("deepseek_chat", { message: "first" });
  assert.equal(first.error, false);
  assert.ok(!first.text.includes("thought"));
  const session_key = key(first.text);
  const second = await f.call("deepseek_reasoner", { message: "second", session_key, show_reasoning: true });
  assert.match(second.text, /thought/);
  assert.equal(key(second.text), session_key);
  assert.equal(f.calls[1].previous.lastMessageId, 1);
  assert.equal(f.calls[1].request.thinking, true);
  assert.ok(f.calls[1].request.signal instanceof AbortSignal);
  const list = await f.call("deepseek_sessions_list");
  assert.ok(!list.text.includes("hidden-id"));
  assert.ok(!list.text.includes("lastMessageId"));
  const unknown = await f.call("deepseek_chat", { message: "x", session_key: randomUUID() });
  assert.equal(unknown.error, true);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.call("deepseek_session_close", { session_key })).error, false);
  assert.equal((await f.call("deepseek_chat", { message: "x", session_key })).error, true);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.call("deepseek_chat", { message: "" })).error, true);
});

test("ambiguous continuation invalidates key; known rejection preserves it; no-ID retains answer", async (t) => {
  const f = await fixture();
  t.after(async () => { await f.client.close(); await f.server.close(); });
  const session_key = key((await f.call("deepseek_chat", { message: "first" })).text);
  const rejection = await f.call("deepseek_chat", { message: "rejected", session_key });
  assert.equal(rejection.error, true);
  assert.equal(f.sessions.require(session_key, "deepseek").remote.lastMessageId, 1);
  const ambiguous = await f.call("deepseek_chat", { message: "ambiguous", session_key });
  assert.equal(ambiguous.error, true);
  assert.match(ambiguous.text, /invalidated/);
  assert.throws(() => f.sessions.require(session_key, "deepseek"), /invalidated/);
  const next = key((await f.call("deepseek_chat", { message: "first" })).text);
  const noId = await f.call("deepseek_chat", { message: "no-id", session_key: next });
  assert.equal(noId.error, false);
  assert.match(noId.text, /useful answer/);
  assert.ok(!noId.text.includes("session_key:"));
  assert.throws(() => f.sessions.require(next, "deepseek"), /invalidated/);
});

test("MCP file analysis fails closed, enforces real paths and quotas, and allows follow-up", async (t) => {
  const f = await fixture();
  const root = await mkdtemp(resolve(".validation-files-"));
  const outside = await mkdtemp(resolve(".validation-outside-"));
  const original = process.env.WEB_AI_ALLOWED_ROOTS;
  t.after(async () => {
    if (original === undefined) delete process.env.WEB_AI_ALLOWED_ROOTS; else process.env.WEB_AI_ALLOWED_ROOTS = original;
    await f.client.close(); await f.server.close();
    await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
  });
  const file = join(root, "fixture.txt");
  await writeFile(file, "non-sensitive fixture");
  delete process.env.WEB_AI_ALLOWED_ROOTS;
  assert.equal((await f.call("deepseek_analyze_files", { file_paths: [file] })).error, true);
  process.env.WEB_AI_ALLOWED_ROOTS = root;
  const forbidden = join(outside, "outside.txt");
  await writeFile(forbidden, "not allowed");
  const link = join(root, "escape.txt"); await symlink(forbidden, link);
  for (const path of ["relative.txt", root, forbidden, link]) {
    assert.equal((await f.call("deepseek_analyze_files", { file_paths: [path] })).error, true);
  }
  await truncate(file, 10 * 1024 * 1024 + 1);
  assert.equal((await f.call("deepseek_analyze_files", { file_paths: [file] })).error, true);
  await truncate(file, 8 * 1024 * 1024);
  assert.equal((await f.call("deepseek_analyze_files", { file_paths: [file, file, file] })).error, true);
  assert.equal(f.uploads.length, 0);
  await writeFile(file, "non-sensitive fixture");
  const answer = await f.call("deepseek_analyze_files", { file_paths: [file], instruction: "summarize" });
  assert.equal(answer.error, false);
  assert.equal(f.uploads[0].files[0].buffer.toString(), "non-sensitive fixture");
  const follow = await f.call("deepseek_chat", { message: "follow", session_key: key(answer.text) });
  assert.equal(follow.error, false);
  assert.equal(f.calls[0].previous.lastMessageId, 10);
});

test("named project conversation, explicit ID and default selection resume after restart", async (t) => {
  const root = await mkdtemp(resolve(".validation-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "sessions.json");
  const first = await fixture(new SessionStore(0, Date.now, path));
  const answer = await first.call("deepseek_chat", { message: "first", conversation_name: "wuxia", make_default: true });
  const id = key(answer.text);
  assert.match(answer.text, new RegExp("conversation_id: " + id));
  await first.client.close(); await first.server.close();
  const second = await fixture(new SessionStore(0, Date.now, path));
  t.after(async () => { await second.client.close(); await second.server.close(); });
  assert.equal(key((await second.call("deepseek_reasoner", { message: "follow" })).text), id);
  assert.equal(second.calls[0].previous.lastMessageId, 1);
  await second.call("deepseek_chat", { message: "next", conversation_id: id });
  await second.call("deepseek_chat", { message: "named", conversation_name: "wuxia" });
  assert.equal(second.calls.at(-1)?.previous.lastMessageId, 3);
  assert.equal((await second.call("deepseek_chat", { message: "bad", conversation_id: id, session_key: randomUUID() })).error, true);
  const expired = await second.call("deepseek_chat", { message: "expired-token", conversation_id: id });
  assert.equal(expired.error, true);
  assert.match(expired.text, /DEEPSEEK_USER_TOKEN/);
  assert.equal(second.sessions.require(id, "deepseek").remote.lastMessageId, 4);
  await second.call("deepseek_chat", { message: "ambiguous", conversation_name: "wuxia" });
  const rejected = await second.call("deepseek_chat", { message: "again", conversation_name: "wuxia" });
  assert.equal(rejected.error, true);
  assert.match(rejected.text, /invalidated/);
  const before = second.calls.length;
  assert.equal((await second.call("deepseek_chat", { message: "again" })).error, true);
  assert.equal(second.calls.length, before);
  await second.call("deepseek_session_close", { conversation_id: id });
  assert.equal(second.sessions.defaultKey(), undefined);
});
