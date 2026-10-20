import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SessionStore } from "../src/core/session-store.js";
import { JobManager } from "../src/core/jobs.js";
import { ProviderError, type FileInput, type MediaGenerationRequest, type WebAIProvider, type RemoteSession } from "../src/core/provider.js";
import { GeminiAccountProvider, GeminiCooldownStore, GeminiQuotaError } from "../src/providers/gemini/cooldown.js";
import { registerGeminiTools } from "../src/tools/gemini.js";
import { registerCommonTools } from "../src/tools/common.js";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const text = (result: any) => result.content.map((c: any) => c.text ?? "").join("\n");
const key = (result: any) => text(result).match(/session_key: ([a-f0-9-]{36})/)![1];
type CapturedMediaRequest = MediaGenerationRequest & { thinkingLevel?: string; referenceVideos?: FileInput[] };

function pngFixture(): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii"); buffer.writeUInt32BE(2, 16); buffer.writeUInt32BE(3, 20);
  return buffer;
}

function mp4Fixture(): Buffer {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32BE(16, 0); buffer.write("ftyp", 4, "ascii"); buffer.write("isom", 8, "ascii");
  return buffer;
}

test("Gemini media tools route quota-only, report cooldowns, pin accounts and query without generation", async t => {
  const directory = await mkdtemp(resolve(".validation-gemini-media-tools-"));
  const imagePath = join(directory, "reference.png");
  const videoPath = join(directory, "reference.mp4");
  await writeFile(imagePath, pngFixture(), { mode: 0o600 });
  await writeFile(videoPath, mp4Fixture(), { mode: 0o600 });
  const previousAllowedRoots = process.env.WEB_AI_ALLOWED_ROOTS;
  process.env.WEB_AI_ALLOWED_ROOTS = directory;
  t.after(() => {
    if (previousAllowedRoots === undefined) delete process.env.WEB_AI_ALLOWED_ROOTS;
    else process.env.WEB_AI_ALLOWED_ROOTS = previousAllowedRoots;
  });
  let now = 100000;
  let allExhausted = false;
  let failure: string | undefined;
  const writes: Array<{ account: string; kind: string; previous?: RemoteSession; request: CapturedMediaRequest }> = [];
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
        writes.push({ account: account.id, kind: request.kind, previous, request: request as CapturedMediaRequest });
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
  const referenced = await call("gemini_generate_video", { prompt: "fixture reference video", model: "Gemini Video Model", thinking_level: "high",
    ratio: "16:9", reference_image_paths: [imagePath], reference_video_paths: [videoPath] });
  assert.equal(referenced.isError, undefined);
  const mediaRequest = writes.at(-1)!.request;
  assert.equal(mediaRequest.model, "Gemini Video Model"); assert.equal(mediaRequest.thinkingLevel, "high"); assert.equal(mediaRequest.ratio, "16:9");
  assert.equal(mediaRequest.referenceImages?.[0].name, "reference.png");
  assert.deepEqual(mediaRequest.referenceVideos?.map(file => file.name), ["reference.mp4"]);
  assert.deepEqual(mediaRequest.referenceVideos?.[0].buffer, mp4Fixture());
  const beforeInvalidReferences = writes.length;
  assert.equal((await call("gemini_generate_image", { prompt: "invalid video ref", reference_video_paths: [videoPath] })).isError, true);
  const tooMany = await call("gemini_generate_video", { prompt: "too many refs", reference_image_paths: [imagePath, imagePath, imagePath],
    reference_video_paths: [videoPath, videoPath, videoPath] });
  assert.equal(tooMany.isError, true); assert.ok(text(tooMany).includes("invalid_file"));
  assert.ok(!text(tooMany).includes(imagePath)); assert.equal(writes.length, beforeInvalidReferences);

  await call("gemini_generate_video", { prompt: "fixture video" });
  assert.equal(writes.at(-1)?.account, "one");
  const count = writes.length;
  for (const args of [{ prompt: "x", account_id: "one" }, { prompt: "x", ratio: "4:5" }, { prompt: "x", thinking_level: "extreme" },
    { prompt: "x", session_key: id, conversation_name: "conflict" }]) {
    assert.equal((await call("gemini_generate_image", args)).isError, true);
  }
  assert.equal(writes.length, count);

  const requestId = randomUUID();
  const backgroundArgs = { prompt: "background fixture", model: "Gemini Video Model", thinking_level: "medium", ratio: "3:4",
    background: true, request_id: requestId };
  const beforeBackground = writes.length;
  const backgroundAck = await call("gemini_generate_image", backgroundArgs);
  const jobId = (backgroundAck._meta as any).web_ai_job.job_id;
  const duplicate = await call("gemini_generate_image", backgroundArgs);
  assert.equal((duplicate._meta as any).web_ai_job.job_id, jobId);
  assert.equal((await call("gemini_generate_image", { ...backgroundArgs, ratio: "9:16" })).isError, true);
  let jobStatus = duplicate;
  for (let i = 0; i < 100 && (jobStatus._meta as any).web_ai_job.status === "running"; i++) {
    jobStatus = await call("webai_job_status", { job_id: jobId });
    if ((jobStatus._meta as any).web_ai_job.status === "running") await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal((jobStatus._meta as any).web_ai_job.status, "completed");
  assert.equal(writes.length, beforeBackground + 1);
  assert.equal(writes.at(-1)?.request.model, "Gemini Video Model");
  assert.equal(writes.at(-1)?.request.thinkingLevel, "medium");
  assert.equal(writes.at(-1)?.request.ratio, "3:4");

  now += 60001;
  const beforeStatus = writes.length;
  await call("gemini_accounts"); assert.equal(writes.length, beforeStatus, "expiry/status must not generate");
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
