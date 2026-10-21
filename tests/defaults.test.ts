import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProviderError, type ChatRequest, type MediaGenerationRequest, type RemoteSession, type WebAIProvider } from "../src/core/provider.js";
import { SessionStore } from "../src/core/session-store.js";
import { deepseekDefaults, doubaoDefaults, geminiDefaults } from "../src/tools/defaults.js";
import { registerDeepSeekTools } from "../src/tools/deepseek.js";
import { registerDoubaoTools } from "../src/tools/doubao.js";
import { registerGeminiTools } from "../src/tools/gemini.js";

function environment(t: TestContext, values: Record<string, string>) {
  const old = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [name, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
}

test("unset or blank defaults preserve built-in selections; invalid defaults never echo values", () => {
  assert.deepEqual(deepseekDefaults({}), { thinking: false });
  assert.deepEqual(doubaoDefaults({}), { mode: "quick", imageModel: "Seedream 5.0 Flash", videoModel: "Seedance 2.0 Fast" });
  assert.deepEqual(geminiDefaults({}), { model: undefined, imageModel: undefined, videoModel: undefined, thinkingLevel: undefined });
  assert.equal(deepseekDefaults({ DEEPSEEK_DEFAULT_THINKING: " true " }).thinking, true);
  assert.equal(doubaoDefaults({ DOUBAO_DEFAULT_VIDEO_MODEL: " " }).videoModel, "Seedance 2.0 Fast");
  const bad: Array<[typeof deepseekDefaults | typeof doubaoDefaults | typeof geminiDefaults, string, string]> = [
    [deepseekDefaults, "DEEPSEEK_DEFAULT_THINKING", "secret-canary"],
    [doubaoDefaults, "DOUBAO_DEFAULT_MODE", "secret-canary"],
    [doubaoDefaults, "DOUBAO_DEFAULT_IMAGE_MODEL", "secret-canary"],
    [doubaoDefaults, "DOUBAO_DEFAULT_VIDEO_MODEL", "secret-canary"],
    [geminiDefaults, "GEMINI_DEFAULT_THINKING_LEVEL", "secret-canary"],
    [geminiDefaults, "GEMINI_DEFAULT_MODEL", "secret-canary\nmodel"],
    [geminiDefaults, "GEMINI_DEFAULT_IMAGE_MODEL", "secret-canary".repeat(20)],
  ];
  for (const [load, name, value] of bad) assert.throws(() => load({ [name]: value }),
    (e: any) => e instanceof ProviderError && e.code === "configuration_error" && e.message.includes(name) && !e.message.includes("secret-canary"));
});

async function fixture(t: TestContext, id: "deepseek" | "doubao" | "gemini", sessions = new SessionStore()) {
  const calls: Array<{ request: ChatRequest | MediaGenerationRequest; previous?: RemoteSession }> = [];
  const provider: WebAIProvider = {
    id, displayName: "fixture", capabilities: { chat: true, thinking: true, files: true, webSearch: false, sessionResume: true,
      imageGeneration: true, videoGeneration: true },
    async initialize() {},
    async chat(request, previous) {
      calls.push({ request, previous });
      return { content: "fixture", remoteSession: { conversationId: "fixture", turn: Number(previous?.turn ?? 0) + 1,
        ...(request.model ? { model: request.model } : typeof previous?.model === "string" ? { model: previous.model } : {}),
        ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : typeof previous?.thinkingLevel === "string" ? { thinkingLevel: previous.thinkingLevel } : {}) } };
    },
    async analyzeFiles(_files, instruction, thinking, signal) { return this.chat({ message: instruction, thinking, signal }); },
    async generateMedia(request, previous) {
      calls.push({ request, previous });
      return { content: "fixture media", remoteSession: { conversationId: "fixture", model: request.model ?? previous?.model,
        thinkingLevel: request.thinkingLevel ?? previous?.thinkingLevel }, media: [] };
    },
  };
  const server = new McpServer({ name: "fixture", version: "0" });
  ({ deepseek: registerDeepSeekTools, doubao: registerDoubaoTools, gemini: registerGeminiTools })[id](server, provider, sessions);
  const client = new Client({ name: "fixture", version: "0" }); const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); t.after(async () => { await client.close(); await server.close(); });
  return { calls, sessions, client, call: async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, JSON.stringify(r));
    return (r.content as Array<{ text: string }>).map(c => c.text).join("\n");
  } };
}

const sessionKey = (text: string) => text.match(/session_key: ([a-f0-9-]{36})/)![1];

test("DeepSeek configured thinking can be explicitly disabled and never disables the reasoner tool", async t => {
  environment(t, { DEEPSEEK_DEFAULT_THINKING: "true" }); const f = await fixture(t, "deepseek");
  await f.call("deepseek_chat", { message: "default" });
  await f.call("deepseek_chat", { message: "override", thinking: false });
  await f.call("deepseek_reasoner", { message: "reasoner" });
  assert.deepEqual(f.calls.map(c => (c.request as ChatRequest).thinking), [true, false, true]);
});

test("Doubao startup model defaults reach the provider and tool schema; per-call values override them", async t => {
  environment(t, { DOUBAO_DEFAULT_MODE: "expert", DOUBAO_DEFAULT_IMAGE_MODEL: "Seedream 4.5", DOUBAO_DEFAULT_VIDEO_MODEL: "Seedance 2.5" });
  const f = await fixture(t, "doubao");
  const tools = (await f.client.listTools()).tools;
  assert.equal((tools.find(x => x.name === "doubao_generate_image")!.inputSchema.properties!.model as any).default, "Seedream 4.5");
  assert.equal((tools.find(x => x.name === "doubao_generate_video")!.inputSchema.properties!.model as any).default, "Seedance 2.5");
  await f.call("doubao_chat", { message: "default" });
  await f.call("doubao_chat", { message: "override boolean", thinking: false });
  await f.call("doubao_chat", { message: "override mode", mode: "quick" });
  assert.deepEqual(f.calls.map(c => (c.request as ChatRequest).thinking), [true, false, false]);
  await f.call("doubao_generate_image", { prompt: "configured" });
  await f.call("doubao_generate_video", { prompt: "configured", duration_seconds: 20 });
  await f.call("doubao_generate_image", { prompt: "explicit", model: "Seedream 4.0" });
  await f.call("doubao_generate_video", { prompt: "explicit", model: "Seedance 2.0 Mini" });
  assert.deepEqual(f.calls.slice(3).map(c => c.request.model), ["Seedream 4.5", "Seedance 2.5", "Seedream 4.0", "Seedance 2.0 Mini"]);
  // A later edit to process.env does not mutate this registered MCP's defaults.
  process.env.DOUBAO_DEFAULT_VIDEO_MODEL = "Seedance 2.0";
  await f.call("doubao_generate_video", { prompt: "same instance" });
  assert.equal(f.calls.at(-1)!.request.model, "Seedance 2.5");
});

test("Gemini uses capability defaults for new sessions, preserves saved selections, and accepts explicit overrides", async t => {
  environment(t, { GEMINI_DEFAULT_MODEL: "Chat Model", GEMINI_DEFAULT_THINKING_LEVEL: "high",
    GEMINI_DEFAULT_IMAGE_MODEL: "Image Model", GEMINI_DEFAULT_VIDEO_MODEL: "Video Model" });
  const f = await fixture(t, "gemini");
  const key = sessionKey(await f.call("gemini_chat", { message: "configured" }));
  assert.equal(f.calls[0].request.model, "Chat Model"); assert.equal(f.calls[0].request.thinkingLevel, "high");
  await f.call("gemini_chat", { message: "override", session_key: key, model: "Explicit Model", thinking_level: "low" });
  await f.call("gemini_chat", { message: "inherit", session_key: key });
  assert.equal(f.calls[2].previous?.model, "Explicit Model"); assert.equal(f.calls[2].previous?.thinkingLevel, "low");
  assert.equal(f.calls[2].request.model, undefined); assert.equal(f.calls[2].request.thinkingLevel, undefined);
  await f.call("gemini_generate_image", { prompt: "configured" });
  await f.call("gemini_generate_video", { prompt: "configured" });
  await f.call("gemini_generate_video", { prompt: "explicit", model: "Other Video", thinking_level: "medium" });
  assert.deepEqual(f.calls.slice(3).map(c => [c.request.model, c.request.thinkingLevel]), [
    ["Image Model", "high"], ["Video Model", "high"], ["Other Video", "medium"],
  ]);
  // Different startup defaults cannot replace selections already saved to a conversation.
  process.env.GEMINI_DEFAULT_MODEL = "Changed Default"; process.env.GEMINI_DEFAULT_THINKING_LEVEL = "medium";
  const restarted = await fixture(t, "gemini", f.sessions);
  await restarted.call("gemini_chat", { message: "after restart", session_key: key });
  assert.equal(restarted.calls[0].previous?.model, "Explicit Model"); assert.equal(restarted.calls[0].request.model, undefined);
  const newKey = sessionKey(await restarted.call("gemini_chat", { message: "new" }));
  assert.notEqual(newKey, key); assert.equal(restarted.calls.at(-1)!.request.model, "Changed Default");
});

test("Gemini media defaults fall back to the general model without overriding a bound session", async t => {
  environment(t, { GEMINI_DEFAULT_MODEL: "General Model", GEMINI_DEFAULT_THINKING_LEVEL: "medium",
    GEMINI_DEFAULT_IMAGE_MODEL: "", GEMINI_DEFAULT_VIDEO_MODEL: "" });
  const f = await fixture(t, "gemini");
  const key = sessionKey(await f.call("gemini_generate_video", { prompt: "first", model: "Pinned Model", thinking_level: "low" }));
  await f.call("gemini_generate_video", { prompt: "inherit", session_key: key });
  assert.equal(f.calls[1].request.model, undefined); assert.equal(f.calls[1].previous?.model, "Pinned Model");
  assert.equal(f.calls[1].request.thinkingLevel, undefined); assert.equal(f.calls[1].previous?.thinkingLevel, "low");
  await f.call("gemini_generate_image", { prompt: "general default" });
  assert.equal(f.calls[2].request.model, "General Model"); assert.equal(f.calls[2].request.thinkingLevel, "medium");
});

test("stdio startup loads model defaults from --env-file, preserves env precedence and rejects invalid settings safely", async t => {
  const directory = await mkdtemp(resolve(".validation-default-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "defaults.env");
  await writeFile(file, "DOUBAO_DEFAULT_IMAGE_MODEL=Seedream 4.0\nDOUBAO_DEFAULT_VIDEO_MODEL=Seedance 2.5\n", { mode: 0o600 });
  const env = { DEEPSEEK_USER_TOKEN: "", GEMINI_ACCOUNTS_FILE: "", GEMINI_COOKIE: "", GEMINI_USER_AGENT: "",
    DOUBAO_COOKIE: "sessionid=fixture; passport_csrf_token=fixture; s_v_web_id=fixture",
    DOUBAO_CHAT_URL: "https://www.doubao.com/chat/completion?aid=497858&device_id=1&web_id=2&tea_uuid=3&fp=fixture&pc_version=3.41.4&region=CN&sys_region=CN&web_tab_id=fixture",
    DOUBAO_USER_AGENT: "Fixture Browser", DOUBAO_DEFAULT_MODE: "quick", DOUBAO_DEFAULT_IMAGE_MODEL: "Seedream 5.0 Pro",
    WEB_AI_PROJECT_ROOT: directory, WEB_AI_SESSION_STORE_PATH: join(directory, "sessions.json") };
  const args = ["--import", "tsx", resolve("src/index.ts"), "--env-file", file];
  // Discovery must work offline and must not contact the website to apply startup defaults.
  const noNetwork = "data:text/javascript," + encodeURIComponent("globalThis.fetch = () => { throw new Error('Website requests forbidden during discovery'); };");
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", noNetwork, ...args], env, stderr: "pipe" });
  let stderr = ""; transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  const client = new Client({ name: "config-startup-fixture", version: "0" });
  t.after(async () => { await client.close(); await transport.close(); });
  try { await client.connect(transport); } catch { assert.fail(stderr || "Fixture MCP startup failed"); }
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 13);
  assert.equal((tools.find(x => x.name === "doubao_generate_image")!.inputSchema.properties!.model as any).default, "Seedream 5.0 Pro");
  assert.equal((tools.find(x => x.name === "doubao_generate_video")!.inputSchema.properties!.model as any).default, "Seedance 2.5");
  const invalid = spawnSync(process.execPath, args, { env: { ...process.env, ...env, DOUBAO_DEFAULT_VIDEO_MODEL: "private-value-canary" },
    encoding: "utf8", timeout: 15000 });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Invalid DOUBAO_DEFAULT_VIDEO_MODEL/); assert.ok(!invalid.stderr.includes("private-value-canary"));
});
