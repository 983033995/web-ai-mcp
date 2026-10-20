import { test } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProviderError, type ChatRequest, type FileInput, type RemoteSession, type WebAIProvider } from "../src/core/provider.js";
import { SessionStore } from "../src/core/session-store.js";
import { registerGeminiTools } from "../src/tools/gemini.js";
import type { GeminiModelCatalog } from "../src/providers/gemini/selection.js";

const canary = "private-cookie-response-canary";
type CapturedChatRequest = ChatRequest & { model?: string; thinkingLevel?: string; files?: FileInput[] };
async function fixture(sessions = new SessionStore(), modelCatalog?: GeminiModelCatalog) {
  const calls: Array<{ request: CapturedChatRequest; previous?: RemoteSession }> = [];
  const modelCalls: Array<RemoteSession | undefined> = [];
  const baseProvider = {
    id: "gemini", displayName: "fixture", capabilities: { chat: true, thinking: true, files: true, webSearch: false, sessionResume: true },
    async initialize() {},
    async chat(request: ChatRequest, previous?: RemoteSession) {
      calls.push({ request: request as CapturedChatRequest, previous });
      if (request.message === "rejected") throw new ProviderError(canary, "authentication_error");
      if (request.message === "ambiguous") throw new ProviderError(canary, "network_error", true);
      if (request.message === "unknown-error") throw new Error(canary);
      if (request.message === "unknown-code") throw new ProviderError(canary, canary, true);
      if (request.message === "no-id") return { content: "useful answer", warning: "not resumable" };
      return { content: "answer", remoteSession: { conversationId: "c_fixture-hidden", replyId: "r_fixture-hidden",
        candidateId: "rc_fixture-hidden", accountHash: "hidden-account", turn: Number(previous?.turn ?? 0) + 1 } };
    },
  };
  const provider = { ...baseProvider, ...(modelCatalog ? { async getModels(previous?: RemoteSession) {
    modelCalls.push(previous);
    return modelCatalog;
  } } : {}) } as WebAIProvider;
  const server = new McpServer({ name: "fixture", version: "0" });
  registerGeminiTools(server, provider, sessions);
  const client = new Client({ name: "fixture", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: Boolean(result.isError), text: (result.content as Array<{ text?: string }>).map(i => i.text ?? "").join("\n") };
  };
  return { calls, modelCalls, call, sessions, client, server };
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
  for (const args of [{ message: "" }, { message: "x", thinking: true }, { message: "x", show_reasoning: true },
    { message: "x", file_paths: "secret.txt" }, { message: "x", account_id: "primary" }, { message: "x", ratio: "16:9" },
    { message: "x", session_key: randomUUID() }, { message: "x", session_key: id, conversation_name: "conflict" },
    { message: "x", session_key: id, conversation_id: randomUUID() }, { message: "x", make_default: "true" }]) {
    assert.equal((await f.call("gemini_chat", args)).error, true);
  }
  assert.equal(f.calls.length, count);
  assert.equal((await f.call("gemini_session_close", { session_key: id })).error, false);
  assert.equal((await f.call("gemini_chat", { message: "closed", session_key: id })).error, true);
  assert.equal(f.calls.length, count);
});

test("Gemini chat forwards account-validated selection and authorized file buffers without persisting file data", async t => {
  const root = await mkdtemp(join(tmpdir(), "gemini-tools-files-"));
  const allowed = join(root, "allowed");
  await mkdir(allowed);
  const inside = join(allowed, "notes.txt");
  const outside = join(root, "outside.txt");
  const fileText = "temporary fixture file content";
  await writeFile(inside, fileText, { mode: 0o600 });
  await writeFile(outside, "outside", { mode: 0o600 });
  const priorAllowed = process.env.WEB_AI_ALLOWED_ROOTS;
  process.env.WEB_AI_ALLOWED_ROOTS = allowed;
  t.after(async () => {
    if (priorAllowed === undefined) delete process.env.WEB_AI_ALLOWED_ROOTS;
    else process.env.WEB_AI_ALLOWED_ROOTS = priorAllowed;
    await rm(root, { recursive: true, force: true });
  });
  const f = await fixture(new SessionStore(0, Date.now, join(root, "sessions.json")));
  t.after(async () => { await f.client.close(); await f.server.close(); });

  const accepted = await f.call("gemini_chat", {
    message: "fixture question", model: "Gemini 3 Pro", thinking_level: "high", file_paths: [inside],
  });
  assert.equal(accepted.error, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].request.model, "Gemini 3 Pro");
  assert.equal(f.calls[0].request.thinkingLevel, "high");
  assert.equal(f.calls[0].request.thinking, false);
  assert.equal(f.calls[0].request.files?.length, 1);
  assert.equal(f.calls[0].request.files?.[0].name, "notes.txt");
  assert.equal(f.calls[0].request.files?.[0].buffer.toString("utf8"), fileText);

  const invalidSession = await f.call("gemini_chat", { message: "must not read", session_key: randomUUID(), file_paths: [outside] });
  assert.equal(invalidSession.error, true);
  assert.match(invalidSession.text, /session_missing/);
  assert.ok(!invalidSession.text.includes(outside));
  assert.equal(f.calls.length, 1, "a missing session is rejected before file access or website calls");

  const invalidFile = await f.call("gemini_chat", { message: "must not submit", conversation_name: "invalid-file", file_paths: [outside] });
  assert.equal(invalidFile.error, true);
  assert.match(invalidFile.text, /invalid_file/);
  assert.ok(!invalidFile.text.includes(outside));
  assert.equal(f.calls.length, 1);
  assert.equal(f.sessions.list().some(session => session.name === "invalid-file"), false);

  const disk = await readFile(join(root, "sessions.json"), "utf8");
  assert.ok(!disk.includes(fileText));
  assert.ok(!disk.includes("notes.txt"));
});

test("Gemini model discovery is local-session bound, read-only, and omits website model IDs", async t => {
  const modelId = "deadc0de00112233";
  const catalog: GeminiModelCatalog = { accountStatus: 1000, capacity: 3, capacityField: 12, models: [{
    modelId, modelName: "gemini-pro", displayName: "Gemini 3 Pro", description: "fixture description",
    capacity: 3, capacityField: 12, modelNumber: 7, available: true, selectable: true,
  }] };
  const f = await fixture(new SessionStore(), catalog); t.after(async () => { await f.client.close(); await f.server.close(); });
  assert.ok((await f.client.listTools()).tools.some(tool => tool.name === "gemini_models"));
  const listed = await f.call("gemini_models");
  assert.equal(listed.error, false);
  assert.ok(listed.text.includes("Gemini 3 Pro"));
  assert.ok(listed.text.includes("high"));
  assert.ok(!listed.text.includes(modelId));
  assert.deepEqual(f.modelCalls, [undefined]);

  const session = await f.call("gemini_chat", { message: "create fixture session" });
  const id = key(session.text);
  const bound = await f.call("gemini_models", { session_key: id });
  assert.equal(bound.error, false);
  assert.equal(f.modelCalls.length, 2);
  assert.equal(f.modelCalls[1]?.turn, 1);
  const invalid = await f.call("gemini_models", { session_key: randomUUID() });
  assert.equal(invalid.error, true);
  assert.equal(f.modelCalls.length, 2, "invalid local session must not query model discovery");
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
