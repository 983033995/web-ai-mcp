import { test } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProviderError, type ChatRequest, type RemoteSession, type WebAIProvider } from "../src/core/provider.js";
import { SessionStore } from "../src/core/session-store.js";
import { registerGeminiTools } from "../src/tools/gemini.js";

const canary = "private-cookie-response-canary";
async function fixture(sessions = new SessionStore()) {
  const calls: Array<{ request: ChatRequest; previous?: RemoteSession }> = [];
  const provider: WebAIProvider = {
    id: "gemini", displayName: "fixture", capabilities: { chat: true, thinking: false, files: false, webSearch: false, sessionResume: true },
    async initialize() {},
    async chat(request, previous) {
      calls.push({ request, previous });
      if (request.message === "rejected") throw new ProviderError(canary, "authentication_error");
      if (request.message === "ambiguous") throw new ProviderError(canary, "network_error", true);
      if (request.message === "unknown-error") throw new Error(canary);
      if (request.message === "unknown-code") throw new ProviderError(canary, canary, true);
      if (request.message === "no-id") return { content: "useful answer", warning: "not resumable" };
      return { content: "answer", remoteSession: { conversationId: "c_fixture-hidden", replyId: "r_fixture-hidden",
        candidateId: "rc_fixture-hidden", accountHash: "hidden-account", turn: Number(previous?.turn ?? 0) + 1 } };
    },
  };
  const server = new McpServer({ name: "fixture", version: "0" });
  registerGeminiTools(server, provider, sessions);
  const client = new Client({ name: "fixture", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: Boolean(result.isError), text: (result.content as Array<{ text?: string }>).map(i => i.text ?? "").join("\n") };
  };
  return { calls, call, sessions, client, server };
}
const key = (text: string) => text.match(/session_key: ([a-f0-9-]{36})/)![1];

test("Gemini default-model tools reject unsupported options and never expose private upstream state", async t => {
  const f = await fixture(); t.after(async () => { await f.client.close(); await f.server.close(); });
  assert.deepEqual((await f.client.listTools()).tools.map(t => t.name).sort(), ["gemini_chat", "gemini_session_close", "gemini_sessions_list"]);
  const first = await f.call("gemini_chat", { message: "first", system_prompt: "prefix" });
  const id = key(first.text);
  assert.equal(first.error, false); assert.ok(!first.text.includes("hidden"));
  assert.equal(f.calls[0].request.thinking, false); assert.equal(f.calls[0].request.systemPrompt, "prefix");
  assert.ok(f.calls[0].request.signal instanceof AbortSignal);
  assert.equal(key((await f.call("gemini_chat", { message: "follow", session_key: id })).text), id);
  assert.equal(f.calls[1].previous?.turn, 1);
  const list = await f.call("gemini_sessions_list");
  assert.ok(list.text.includes(id)); assert.ok(!list.text.includes("hidden")); assert.ok(!list.text.includes("accountHash"));
  const count = f.calls.length;
  for (const args of [{ message: "" }, { message: "x", thinking: true }, { message: "x", model: "Pro" },
    { message: "x", show_reasoning: true }, { message: "x", file_paths: ["secret.txt"] },
    { message: "x", session_key: randomUUID() }, { message: "x", session_key: id, conversation_name: "conflict" },
    { message: "x", session_key: id, conversation_id: randomUUID() }, { message: "x", make_default: "true" }]) {
    assert.equal((await f.call("gemini_chat", args)).error, true);
  }
  assert.equal(f.calls.length, count);
  assert.equal((await f.call("gemini_session_close", { session_key: id })).error, false);
  assert.equal((await f.call("gemini_chat", { message: "closed", session_key: id })).error, true);
  assert.equal(f.calls.length, count);
});

test("Gemini known rejection preserves lineage; uncertain and incomplete replies block keys and names", async t => {
  const f = await fixture(); t.after(async () => { await f.client.close(); await f.server.close(); });
  const id = key((await f.call("gemini_chat", { message: "first", conversation_name: "story", make_default: true })).text);
  const rejected = await f.call("gemini_chat", { message: "rejected", session_key: id });
  assert.equal(rejected.error, true); assert.ok(!rejected.text.includes(canary));
  assert.match(rejected.text, /authentication_error/); assert.equal(f.sessions.require(id, "gemini").remote.turn, 1);
  const uncertain = await f.call("gemini_chat", { message: "ambiguous", session_key: id });
  assert.equal(uncertain.error, true); assert.ok(!uncertain.text.includes(canary));
  assert.match(uncertain.text, /automatic_retry.*false/); assert.throws(() => f.sessions.require(id, "gemini"), /invalidated/);
  const count = f.calls.length;
  for (const selector of [{ session_key: id }, { conversation_name: "story" }, {}]) {
    assert.equal((await f.call("gemini_chat", { message: "again", ...selector })).error, true);
  }
  assert.equal(f.calls.length, count);
  await f.call("gemini_session_close", { session_key: id });
  const useful = await f.call("gemini_chat", { message: "no-id", conversation_name: "story" });
  assert.equal(useful.error, false); assert.match(useful.text, /useful answer/); assert.ok(!useful.text.includes("session_key:"));
  assert.equal((await f.call("gemini_chat", { message: "again", conversation_name: "story" })).error, true);
});

test("Gemini errors are fixed safe messages, including unknown exceptions and codes", async t => {
  const f = await fixture(); t.after(async () => { await f.client.close(); await f.server.close(); });
  for (const message of ["unknown-error", "unknown-code"]) {
    const result = await f.call("gemini_chat", { message });
    assert.equal(result.error, true); assert.ok(!result.text.includes(canary));
  }
  const prior = f.calls.length;
  assert.equal((await f.call("gemini_chat", { message: "rejected", conversation_name: "not-created" })).error, true);
  assert.equal(f.sessions.list().some(s => s.name === "not-created"), false);
  assert.equal(f.calls.length, prior + 1);
});

test("Gemini names/defaults survive restart without storing messages or leaking another provider", async t => {
  const root = await mkdtemp(resolve(".validation-gemini-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "sessions.json");
  const first = await fixture(new SessionStore(0, Date.now, path));
  const other = first.sessions.put({ providerId: "doubao", remote: { private: "other-hidden" } });
  first.sessions.selectDefault(other.key, "doubao");
  assert.equal((await first.call("gemini_chat", { message: "first-private-message", conversation_name: "story", make_default: true })).error, false);
  const id = first.sessions.defaultKey("gemini")!;
  await first.client.close(); await first.server.close();
  const second = await fixture(new SessionStore(0, Date.now, path));
  t.after(async () => { await second.client.close(); await second.server.close(); });
  const resumed = await second.call("gemini_chat", { message: "follow-private-message" });
  assert.equal(key(resumed.text), id); assert.equal(second.calls[0].previous?.turn, 1);
  assert.equal(key((await second.call("gemini_chat", { message: "named", conversation_name: "story" })).text), id);
  assert.equal((await second.call("gemini_session_close", { session_key: other.key })).error, true);
  assert.equal(second.sessions.require(other.key, "doubao").providerId, "doubao");
  const disk = await readFile(path, "utf8");
  assert.ok(!disk.includes("first-private-message")); assert.ok(!disk.includes("follow-private-message"));
  second.sessions.selectDefault(other.key, "doubao");
  const fresh = await second.call("gemini_chat", { message: "fresh" });
  assert.notEqual(key(fresh.text), id); assert.equal(second.calls.at(-1)?.previous, undefined);
  assert.equal(second.sessions.defaultKey("doubao"), other.key);
});
