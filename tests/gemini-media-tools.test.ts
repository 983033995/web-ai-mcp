import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SessionStore } from "../src/core/session-store.js";
import { JobManager } from "../src/core/jobs.js";
import { ProviderError, type WebAIProvider, type RemoteSession } from "../src/core/provider.js";
import { GeminiAccountProvider, GeminiCooldownStore, GeminiQuotaError } from "../src/providers/gemini/cooldown.js";
import { registerGeminiTools } from "../src/tools/gemini.js";
import { registerCommonTools } from "../src/tools/common.js";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const text = (result: any) => result.content.map((c: any) => c.text ?? "").join("\n");
const key = (result: any) => text(result).match(/session_key: ([a-f0-9-]{36})/)![1];

test("Gemini media tools route quota-only, report cooldowns, pin accounts and query without generation", async t => {
  const directory = await mkdtemp(resolve(".validation-gemini-media-tools-"));
  let now = 100000;
  let allExhausted = false;
  let failure: string | undefined;
  const writes: Array<{ account: string; kind: string; previous?: RemoteSession }> = [];
  const reads: string[] = [];
  const accounts = ["one", "two"].map(id => ({ id, cookie: "__Secure-1PSID=fixture-" + id, userAgent: "fixture-agent", cooldownMinutes: { image: 1, video: 2 } }));
  const make = (account: typeof accounts[number]): WebAIProvider => {
    const remote = () => ({ conversationId: "c_" + account.id, replyId: "r_1", candidateId: "rc_1", accountHash: digest(account.id) });
    const result = (kind: "image" | "video") => ({ content: "fixture media", remoteSession: remote(),
      media: [{ id: digest(account.id + kind), type: kind, status: "completed" as const,
        url: "https://contribution.usercontent.google.com/download?c=fixture&filename=" + kind }] });
    return { id: "gemini", displayName: "fixture", capabilities: { chat: true, thinking: false, files: false, webSearch: false, sessionResume: true, imageGeneration: true, videoGeneration: true },
      async initialize() {}, async chat() { return { content: "chat", remoteSession: remote() }; },
      async generateMedia(request, previous) {
        writes.push({ account: account.id, kind: request.kind, previous });
        if (failure) throw new ProviderError("private-upstream-cookie", failure, true);
        if (allExhausted || (account.id === "one" && request.kind === "image")) throw new GeminiQuotaError(request.kind, now + 60000);
        return result(request.kind);
      },
      async getMedia(previous) { reads.push(account.id); return result(previous.mediaKind === "video" ? "video" : "image"); },
    };
  };
  const provider = new GeminiAccountProvider(accounts, make, new GeminiCooldownStore(join(directory, "cooldowns.json"), () => now));
  const sessions = new SessionStore(0, Date.now, join(directory, "sessions.json"));
  const server = new McpServer({ name: "fixture", version: "0" }); const jobs = new JobManager({ pollAfterSeconds: 1 });
  registerCommonTools(server, jobs); registerGeminiTools(server, provider, sessions, jobs);
  const client = new Client({ name: "fixture", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(["gemini_generate_image", "gemini_generate_video", "gemini_media_status", "gemini_download_media", "gemini_accounts"].every(n => tools.includes(n)));
  const first = await call("gemini_generate_image", { prompt: "non-sensitive fixture", conversation_name: "media" });
  assert.equal(first.isError, undefined); assert.match(text(first), /account_id: two/);
  assert.deepEqual(writes.map(w => w.account), ["one", "two"]);
  const id = key(first); assert.equal(sessions.require(id, "gemini").remote.accountId, "two");
  const state = JSON.parse(text(await call("gemini_accounts")));
  assert.equal(state.accounts[0].cooldowns.image.cooling_down, true);
  assert.equal(state.accounts[0].cooldowns.video.cooling_down, false);
  assert.equal(state.accounts[0].cooldowns.image.source, "website");
  assert.ok(!JSON.stringify(state).includes("__Secure")); assert.ok(!JSON.stringify(state).includes("userAgent"));
  await call("gemini_media_status", { session_key: id }); await call("gemini_media_status", { session_key: id });
  assert.deepEqual(reads, ["two", "two"]); assert.equal(writes.length, 2);
  assert.equal((await call("gemini_media_status", { session_key: randomUUID() })).isError, true); assert.equal(reads.length, 2);
  await call("gemini_generate_video", { prompt: "fixture video" });
  assert.equal(writes.at(-1)?.account, "one");
  const count = writes.length;
  for (const args of [{ prompt: "x", account_id: "one" }, { prompt: "x", model: "Pro" },
    { prompt: "x", ratio: "16:9" }, { prompt: "x", session_key: id, conversation_name: "conflict" }]) {
    assert.equal((await call("gemini_generate_image", args)).isError, true);
  }
  assert.equal(writes.length, count);
  now += 60001;
  await call("gemini_accounts"); assert.equal(writes.length, count, "expiry/status must not generate");
  allExhausted = true;
  const exhausted = await call("gemini_generate_image", { prompt: "exhausted fixture", conversation_name: "exhausted" });
  assert.equal(exhausted.isError, true); assert.match(text(exhausted), /quota_exhausted/);
  assert.ok(!sessions.list().some(s => s.name === "exhausted"));
  const afterExhaustion = writes.length;
  await call("gemini_generate_image", { prompt: "cooldown fixture" });
  assert.equal(writes.length, afterExhaustion);
  const pinned = await call("gemini_generate_image", { prompt: "pinned fixture", session_key: id });
  assert.equal(pinned.isError, true); assert.equal(writes.length, afterExhaustion);
  now += 60001; allExhausted = false; failure = "captcha_required";
  const captcha = await call("gemini_generate_image", { prompt: "captcha fixture" });
  assert.equal(captcha.isError, true); assert.equal(writes.length, afterExhaustion + 1);
  assert.ok(!text(captcha).includes("private-upstream-cookie"));
  const disk = await readFile(join(directory, "sessions.json"), "utf8");
  assert.ok(!disk.includes("non-sensitive fixture")); assert.ok(!disk.includes("usercontent.google.com"));
  assert.ok(!disk.includes("__Secure-1PSID"));
});
