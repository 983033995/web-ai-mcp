import { test } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SessionStore } from "../src/core/session-store.js";
import { ProviderError, type ChatRequest, type FileInput, type RemoteSession, type WebAIProvider } from "../src/core/provider.js";
import { registerDoubaoTools } from "../src/tools/doubao.js";

const canary = "single-sessionid-canary-not-the-entire-cookie";

async function fixture(sessions = new SessionStore()) {
  const calls: Array<{ request: ChatRequest; previous?: RemoteSession; files?: FileInput[] }> = [];
  const provider: WebAIProvider = {
    id: "doubao",
    displayName: "Doubao Web Fixture",
    capabilities: {
      chat: true,
      thinking: true,
      files: true,
      webSearch: false,
      sessionResume: true,
    },
    async initialize() {},
    async analyzeFiles(files, instruction, thinking, signal) {
      if (instruction === "upload-rejected") throw new ProviderError("SECRET_CANARY", "upload_error");
      const result = await provider.chat({ message: instruction, thinking, signal });
      calls.at(-1)!.files = files;
      return result;
    },
    async chat(request, previous) {
      calls.push({ request, previous });
      if (request.message === "ambiguous") {
        throw new ProviderError("transport failed", "network_error", true);
      }
      if (request.message === "rejected") {
        throw new ProviderError("HTTP 429", "rate_limit_error");
      }
      if (request.message === "expired-token") {
        throw new ProviderError("更新 DOUBAO_COOKIE", "authentication_error");
      }
      if (request.message === "unknown-error") throw new Error(canary);
      if (request.message === "unknown-value") throw canary;
      if (request.message === "upstream-error") {
        throw new ProviderError("sessionid=" + canary, "stream_error", true);
      }
      if (request.message === "upstream-rejection") {
        throw new ProviderError("sessionid=" + canary, "captcha_required");
      }
      if (request.message === "unknown-code") {
        throw new ProviderError(canary, canary);
      }
      if (request.message === "no-id") {
        return { content: "useful answer", warning: "not resumable" };
      }
      return {
        content: "doubao answer",
        reasoning: "doubao thought",
        remoteSession: {
          conversationId: "conv-remote-123",
          sectionId: "sec-remote-456",
          lastMessageId: Number(previous?.lastMessageId ?? 0) + 1,
        },
      };
    },
  };

  const server = new McpServer({ name: "fixture", version: "0" });
  registerDoubaoTools(server, provider, sessions);

  const client = new Client({ name: "fixture", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return {
      error: !!response.isError,
      text: (response.content as Array<{ type: string; text?: string }>)
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n"),
    };
  };

  const close = async () => {
    await client.close();
    await server.close();
  };
  return { call, calls, sessions, client, server, close };
}

const key = (text: string) => text.match(/session_key: ([a-f0-9-]+)/)![1];

const putSession = (sessions: SessionStore, providerId: string, name?: string) => sessions.put({
  providerId,
  remote: { conversationId: providerId + "-remote", lastMessageId: 7 },
  title: "Website conversation",
  name,
});

test("Doubao fixture exposes expert, file and session tools, preserving local lineage", async (t) => {
  const f = await fixture();
  t.after(f.close);

  const tools = (await f.client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "doubao_analyze_files",
    "doubao_chat",
    "doubao_reasoner",
    "doubao_session_close",
    "doubao_sessions_list",
  ]);
  const chat = tools.find((tool) => tool.name === "doubao_chat")!;
  assert.ok(Object.hasOwn(chat.inputSchema.properties!, "thinking"));
  assert.ok(Object.hasOwn(chat.inputSchema.properties!, "show_reasoning"));
  assert.equal(chat.inputSchema.additionalProperties, false);
  for (const unsupported of [{ mode: "unknown" }, { unknown_argument: true }]) {
    const result = await f.call("doubao_chat", { message: "unsupported", ...unsupported });
    assert.equal(result.error, true);
  }
  assert.equal(f.calls.length, 0);

  const first = await f.call("doubao_chat", { message: "hello", system_prompt: "local prefix" });
  assert.equal(first.error, false);
  assert.ok(first.text.includes("## Doubao answer"));
  assert.ok(!first.text.includes("doubao thought"));
  const session_key = key(first.text);
  assert.equal(f.calls[0].request.systemPrompt, "local prefix");
  assert.equal(f.calls[0].request.thinking, false);

  const second = await f.call("doubao_chat", { message: "follow up", conversation_id: session_key });
  assert.equal(second.error, false);
  assert.equal(key(second.text), session_key);
  assert.deepEqual(f.calls[1].previous, {
    conversationId: "conv-remote-123", sectionId: "sec-remote-456", lastMessageId: 1,
  });
  assert.equal(f.calls[1].request.thinking, false);

  const list = await f.call("doubao_sessions_list");
  assert.ok(list.text.includes(session_key));
  assert.ok(!list.text.includes("conv-remote-123"));
  assert.ok(!list.text.includes("sec-remote-456"));
  assert.equal((await f.call("doubao_session_close", { session_key })).error, false);
  assert.ok(!(await f.call("doubao_sessions_list")).text.includes(session_key));
});

test("Doubao mode and reasoner select expert thinking without leaking hidden reasoning", async (t) => {
  const f = await fixture(); t.after(f.close);
  const first = await f.call("doubao_chat", { message: "expert", mode: "expert" });
  assert.equal(first.error, false);
  assert.equal(f.calls[0].request.thinking, true);
  assert.ok(!first.text.includes("doubao thought"));
  const second = await f.call("doubao_reasoner", { message: "followup", session_key: key(first.text), show_reasoning: true });
  assert.equal(second.error, false);
  assert.equal(f.calls[1].request.thinking, true);
  assert.ok(second.text.includes("## Doubao thinking"));
  assert.ok(second.text.includes("doubao thought"));
  assert.equal(key(second.text), key(first.text));
  for (const options of [{ mode: "quick", thinking: true }, { mode: "expert", thinking: false }]) {
    assert.equal((await f.call("doubao_chat", { message: "conflicting", ...options })).error, true);
  }
  assert.equal(f.calls.length, 2);
});

test("Doubao files require allowed real paths and create a resumable conversation without storing file text", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-file-tools-"));
  const outside = mkdtempSync(join(tmpdir(), "doubao-outside-"));
  const oldRoots = process.env.WEB_AI_ALLOWED_ROOTS;
  const path = join(directory, "fixture.txt");
  writeFileSync(path, "synthetic-private-file-canary");
  writeFileSync(join(outside, "outside.txt"), "outside");
  symlinkSync(join(outside, "outside.txt"), join(directory, "escape.txt"));
  const f = await fixture();
  t.after(async () => { await f.close(); if (oldRoots === undefined) delete process.env.WEB_AI_ALLOWED_ROOTS;
    else process.env.WEB_AI_ALLOWED_ROOTS = oldRoots; rmSync(directory, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  delete process.env.WEB_AI_ALLOWED_ROOTS;
  assert.equal((await f.call("doubao_analyze_files", { file_paths: [path] })).error, true);
  process.env.WEB_AI_ALLOWED_ROOTS = directory;
  for (const bad of [join(outside, "outside.txt"), join(directory, "escape.txt"), "relative.txt"]) {
    assert.equal((await f.call("doubao_analyze_files", { file_paths: [bad] })).error, true);
  }
  assert.equal(f.calls.length, 0);
  const failed = await f.call("doubao_analyze_files", { file_paths: [path], instruction: "upload-rejected" });
  assert.equal(failed.error, true); assert.ok(!failed.text.includes("SECRET_CANARY")); assert.equal(f.sessions.list().length, 0);
  const first = await f.call("doubao_analyze_files", { file_paths: [path], instruction: "read fixture", mode: "expert", show_reasoning: true, make_default: true });
  assert.equal(first.error, false); assert.equal(f.calls[0].request.thinking, true);
  assert.equal(f.calls[0].files?.[0].buffer.toString(), "synthetic-private-file-canary");
  const sessionKey = key(first.text);
  assert.equal(f.sessions.defaultKey("doubao"), sessionKey);
  const second = await f.call("doubao_chat", { message: "file followup", session_key: sessionKey });
  assert.equal(second.error, false); assert.equal(key(second.text), sessionKey);
  assert.ok(!JSON.stringify(f.sessions.list()).includes("synthetic-private-file-canary"));
});

test("Doubao ignores another provider's default without altering its session or binding", async (t) => {
  let now = 100;
  const sessions = new SessionStore(10, () => now);
  const deepseek = putSession(sessions, "deepseek");
  sessions.selectDefault(deepseek.key, "deepseek");
  const f = await fixture(sessions);
  t.after(f.close);

  for (const uncertain of [false, true]) {
    if (uncertain) sessions.invalidate(deepseek.key);
    const result = await f.call("doubao_chat", { message: "hello" });
    assert.equal(result.error, false);
    assert.notEqual(key(result.text), deepseek.key);
    assert.equal(f.calls.at(-1)!.previous, undefined);
    assert.equal(sessions.defaultKey(), deepseek.key);
  }
  assert.equal(sessions.list().find((record) => record.key === deepseek.key)!.state, "uncertain");
  assert.ok(!(await f.call("doubao_sessions_list")).text.includes(deepseek.key));

  const explicit = await f.call("doubao_chat", { message: "wrong provider", session_key: deepseek.key });
  assert.equal(explicit.error, true);
  assert.ok(explicit.text.includes("another provider"));
  assert.equal(f.calls.length, 2);
  now += 10;
  const expiredDefault = await f.call("doubao_chat", { message: "ignore expired foreign default" });
  assert.equal(expiredDefault.error, false);
  assert.equal(f.calls[2].previous, undefined);
  assert.equal(sessions.defaultKey(), deepseek.key);
});

test("Doubao rejects uncertain and expired same-provider defaults without creating replacements", async (t) => {
  for (const state of ["uncertain", "expired"] as const) {
    let now = 100;
    const sessions = new SessionStore(10, () => now);
    const record = putSession(sessions, "doubao");
    sessions.selectDefault(record.key, "doubao");
    if (state === "uncertain") sessions.invalidate(record.key);
    else now += 10;
    const f = await fixture(sessions);
    t.after(f.close);
    const result = await f.call("doubao_chat", { message: "next" });
    assert.equal(result.error, true);
    assert.ok(result.text.includes(state === "uncertain" ? "invalidated" : "expired"));
    assert.equal(f.calls.length, 0);
    assert.equal(sessions.defaultKey(), record.key);
  }
});

test("Doubao close preserves DeepSeek and reports unknown keys and conflicting selectors", async (t) => {
  const sessions = new SessionStore();
  const deepseek = putSession(sessions, "deepseek");
  sessions.selectDefault(deepseek.key, "deepseek");
  const f = await fixture(sessions);
  t.after(f.close);

  const wrong = await f.call("doubao_session_close", { conversation_id: deepseek.key });
  assert.equal(wrong.error, true);
  assert.ok(wrong.text.includes("another provider"));
  assert.equal(sessions.require(deepseek.key, "deepseek"), deepseek);
  assert.equal(sessions.defaultKey(), deepseek.key);

  const unknown = randomUUID();
  assert.equal((await f.call("doubao_session_close", { session_key: unknown })).error, true);
  assert.equal((await f.call("doubao_chat", { message: "unknown", session_key: unknown })).error, true);
  assert.equal((await f.call("doubao_session_close")).error, true);
  assert.equal((await f.call("doubao_session_close", {
    session_key: unknown, conversation_id: deepseek.key,
  })).error, true);
  assert.equal((await f.call("doubao_chat", {
    message: "conflict", session_key: unknown, conversation_id: deepseek.key,
  })).error, true);
  assert.equal((await f.call("doubao_chat", {
    message: "conflict", session_key: unknown, conversation_name: "name",
  })).error, true);
  assert.equal(f.calls.length, 0);
});

test("Doubao retains uncertain conversations until explicit close, including their names and defaults", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const first = await f.call("doubao_chat", {
    message: "init", conversation_name: "blocked", make_default: true,
  });
  const session_key = key(first.text);
  const ambiguous = await f.call("doubao_chat", { message: "ambiguous", session_key });
  assert.equal(ambiguous.error, true);
  assert.ok(ambiguous.text.includes("[network_error]"));
  assert.ok(ambiguous.text.includes("invalidated"));
  assert.equal(f.sessions.list().find((record) => record.key === session_key)!.state, "uncertain");
  assert.equal(f.sessions.defaultKey(), session_key);
  for (const selector of [{ session_key }, { conversation_name: "blocked" }, {}]) {
    assert.equal((await f.call("doubao_chat", { message: "next", ...selector })).error, true);
  }
  assert.equal(f.calls.length, 2);
  assert.equal((await f.call("doubao_session_close", { session_key })).error, false);
  assert.equal(f.sessions.defaultKey(), undefined);
  const replacement = await f.call("doubao_chat", { message: "new", conversation_name: "blocked" });
  assert.equal(replacement.error, false);
  assert.notEqual(key(replacement.text), session_key);
});

test("Doubao close removes hidden expired own records but preserves expired DeepSeek records", async (t) => {
  let now = 100;
  const sessions = new SessionStore(10, () => now);
  const doubao = putSession(sessions, "doubao", "expired");
  sessions.selectDefault(doubao.key, "doubao");
  const deepseek = putSession(sessions, "deepseek");
  now += 10;
  const f = await fixture(sessions);
  t.after(f.close);
  assert.deepEqual(sessions.list(), []);
  const wrong = await f.call("doubao_session_close", { session_key: deepseek.key });
  assert.equal(wrong.error, true);
  assert.ok(wrong.text.includes("another provider"));
  assert.equal(sessions.defaultKey(), doubao.key);
  const closed = await f.call("doubao_session_close", { conversation_id: doubao.key });
  assert.equal(closed.error, false);
  assert.equal(sessions.defaultKey(), undefined);
  assert.equal((await f.call("doubao_chat", { message: "reuse", conversation_name: "expired" })).error, false);
  now = 100;
  assert.throws(() => sessions.require(doubao.key, "doubao"), /missing or expired/);
  assert.equal(sessions.require(deepseek.key, "deepseek"), deepseek);
});

test("Doubao named/default fixture lineage persists across a local store restart", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-tools-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "sessions.json");
  const sessions = new SessionStore(0, Date.now, path);
  const deepseek = putSession(sessions, "deepseek", "review");
  const f = await fixture(sessions);
  t.after(f.close);
  const first = await f.call("doubao_chat", {
    message: "first", conversation_name: " review ", make_default: true,
  });
  const session_key = key(first.text);
  const second = await f.call("doubao_chat", { message: "second", conversation_name: "review" });
  assert.equal(key(second.text), session_key);
  assert.equal(f.calls[1].previous!.lastMessageId, 1);

  const restarted = await fixture(new SessionStore(0, Date.now, path));
  t.after(restarted.close);
  const third = await restarted.call("doubao_chat", { message: "third" });
  assert.equal(third.error, false);
  assert.equal(key(third.text), session_key);
  assert.equal(restarted.calls[0].previous!.lastMessageId, 2);
  assert.equal(restarted.sessions.require(deepseek.key, "deepseek").name, "review");
  const disk = readFileSync(path, "utf8");
  assert.ok(!disk.includes("doubao answer"));
  assert.ok(!disk.includes("doubao thought"));
  assert.equal((await restarted.call("doubao_session_close", { conversation_id: session_key })).error, false);
  assert.equal(new SessionStore(0, Date.now, path).defaultKey(), undefined);
});

test("Doubao known rejections preserve existing lineage and do not retain a rejected new session", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const session_key = key((await f.call("doubao_chat", { message: "init" })).text);
  const before = { ...f.sessions.require(session_key, "doubao").remote };
  const rejected = await f.call("doubao_chat", { message: "rejected", session_key });
  assert.equal(rejected.error, true);
  assert.ok(rejected.text.includes("[rate_limit_error]"));
  assert.deepEqual(f.sessions.require(session_key, "doubao").remote, before);
  const expired = await f.call("doubao_chat", { message: "expired-token", conversation_name: "rejected" });
  assert.equal(expired.error, true);
  assert.ok(expired.text.includes("[authentication_error]"));
  assert.ok(expired.text.includes("DOUBAO_COOKIE"));
  assert.equal(f.sessions.named("rejected", "doubao"), undefined);
  const noId = await f.call("doubao_chat", { message: "no-id", conversation_name: "no-id" });
  assert.equal(noId.error, false);
  assert.ok(noId.text.includes("useful answer"));
  assert.ok(!noId.text.includes("session_key:"));
  assert.equal(f.sessions.list().find((record) => record.name === "no-id")!.state, "uncertain");
});

test("Doubao does not expose a single credential canary from unknown exceptions or upstream ProviderErrors", async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const message of ["unknown-error", "unknown-value", "upstream-error", "upstream-rejection", "unknown-code"]) {
    const result = await f.call("doubao_chat", { message, conversation_name: message });
    assert.equal(result.error, true);
    assert.ok(!result.text.includes(canary));
    assert.ok(!result.text.includes("sessionid="));
    if (["unknown-error", "unknown-value", "upstream-error"].includes(message)) {
      assert.ok(result.text.includes("invalidated"));
      assert.equal(f.sessions.list().find((record) => record.name === message)!.state, "uncertain");
    }
  }

  const broken = new SessionStore();
  broken.list = () => { throw new Error(canary); };
  const closeFixture = await fixture(broken);
  t.after(closeFixture.close);
  for (const [name, args] of [
    ["doubao_session_close", { session_key: randomUUID() }],
    ["doubao_sessions_list", {}],
  ] as const) {
    const result = await closeFixture.call(name, args);
    assert.equal(result.error, true);
    assert.ok(!result.text.includes(canary));
  }
  broken.exclusive = async () => { throw new Error(canary); };
  const chat = await closeFixture.call("doubao_chat", { message: "outer failure" });
  assert.equal(chat.error, true);
  assert.ok(!chat.text.includes(canary));
});
