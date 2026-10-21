import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { GeminiBrowserChatClient } from "../src/providers/gemini/browser-chat.js";
import { browserChat, type BrowserChatInput, type BrowserRuntime } from "../src/providers/gemini/browser-runtime.js";
import { GeminiWebError } from "../src/providers/gemini/errors.js";
import { parseGeminiTextHistory } from "../src/providers/gemini/history.js";
import { parseGeminiStream } from "../src/providers/gemini/stream.js";

const email = "owner@example.test", hash = createHash("sha256").update(email).digest("hex");
const signal = () => new AbortController().signal;
const prior = { conversationId: "c_one", replyId: "r_one", candidateId: "rc_one", accountHash: hash };
const reply = { content: "Three practical acceptance cases.", conversationId: "c_one", replyId: "r_two", candidateId: "rc_two", accountHash: hash };
function history(content = "answer", status = 2, candidateCount = 1): ReadableStream<Uint8Array> {
  const candidates = Array.from({ length: candidateCount }, (_, i) => {
    const candidate: unknown[] = [];
    candidate[0] = i ? "rc_other" : "rc_two"; candidate[1] = [content]; candidate[8] = [status];
    return candidate;
  });
  const turn: unknown[] = []; turn[0] = [null, "r_two"]; turn[3] = [candidates];
  const frame = JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify([[turn]]), null, null, null]]);
  return new Response(`)]}'\n${frame.length + 2}\n${frame}\ndi\n`).body!;
}

test("text history requires the exact completed reply and an unambiguous candidate", async () => {
  assert.deepEqual(await parseGeminiTextHistory(history(), signal(), "r_two"), { content: "answer", replyId: "r_two", candidateId: "rc_two" });
  await assert.rejects(parseGeminiTextHistory(history(), signal(), "r_other"), (e: any) => e.code === "history_not_found");
  await assert.rejects(parseGeminiTextHistory(history(), signal(), "r_two", "rc_missing"), (e: any) => e.code === "session_state_error");
  await assert.rejects(parseGeminiTextHistory(history("partial", 1), signal(), "r_two"), (e: any) => e.code === "history_not_found");
  await assert.rejects(parseGeminiTextHistory(history("answer", 2, 2), signal(), "r_two"), (e: any) => e.code === "session_state_error");
  assert.equal((await parseGeminiTextHistory(history("answer", 2, 2), signal(), "r_two", "rc_two")).candidateId, "rc_two");
});

test("a complete website error notice is a failure in both stream and history, never an answer", async () => {
  const content = "Sorry, something went wrong. Please try your request again.";
  const record: unknown[] = []; record[1] = ["c_one", "r_two"]; record[4] = [["rc_two", [content]]];
  const frame = JSON.stringify([["wrb.fr", null, JSON.stringify(record)]]);
  await assert.rejects(parseGeminiStream(new Response(`)]}'\n${frame.length + 2}\n${frame}\ndi\n`).body!, signal()),
    (e: any) => e.code === "website_error" && e.sessionUncertain);
  await assert.rejects(parseGeminiTextHistory(history(content), signal(), "r_two"), (e: any) => e.code === "website_error");
  assert.equal((await parseGeminiTextHistory(history(`The website displayed "${content}"`), signal(), "r_two")).content.startsWith("The website"), true);
});

test("explicit browser chat sends once, carries selections and pinned lineage, and cleans private upload copies", async () => {
  let captured: BrowserChatInput | undefined, calls = 0;
  const client = new GeminiBrowserChatClient("__Secure-1PSID=fixture", { spaceId: 15, email }, { userAgent: "fixture-browser",
    runBrowser: async input => {
      calls++; captured = input;
      assert.equal((await readFile(input.files[0], "utf8")), "ordinary brief");
      return reply;
    } });
  const result = await client.chat({ message: "review", systemPrompt: "context", thinking: false, model: "4 Argon", thinkingLevel: "high",
    files: [{ name: "brief.txt", buffer: Buffer.from("ordinary brief") }] }, prior);
  assert.deepEqual(result, reply);
  assert.equal(calls, 1);
  assert.equal(captured?.message, "context\n\nreview");
  assert.equal(captured?.model, "4 Argon"); assert.equal(captured?.thinkingLevel, "high");
  assert.deepEqual(captured?.previous, prior);
  await assert.rejects(access(captured!.files[0]));
});

test("browser errors and invalid result lineage never fall back to HTTP or replay", async () => {
  for (const result of [new GeminiWebError("browser_error", "stopped", true), { ...reply, conversationId: "c_elsewhere" },
    { ...reply, accountHash: "0".repeat(64) }, { ...reply, replyId: prior.replyId }, { ...reply, candidateId: prior.candidateId }]) {
    let calls = 0, http = 0;
    const client = new GeminiBrowserChatClient("__Secure-1PSID=fixture", { spaceId: 15, email }, { userAgent: "fixture-browser",
      fetch: async () => { http++; throw new Error("unexpected HTTP"); },
      runBrowser: async () => { calls++; if (result instanceof Error) throw result; return result; } });
    await assert.rejects(client.chat({ message: "review", thinking: false }, prior));
    assert.equal(calls, 1); assert.equal(http, 0);
  }
});

test("independent MCP clients sharing a browser space cannot send concurrently", async () => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const options = { userAgent: "fixture-browser", runBrowser: async () => { entered(); await pending; return reply; } };
  const one = new GeminiBrowserChatClient("__Secure-1PSID=fixture", { spaceId: 987654321, email }, options);
  const two = new GeminiBrowserChatClient("__Secure-1PSID=fixture", { spaceId: 987654321, email }, options);
  const first = one.chat({ message: "review", thinking: false }, prior);
  await started;
  try { await assert.rejects(two.chat({ message: "competing", thinking: false }, prior), /store is locked/); }
  finally { release(); }
  assert.deepEqual(await first, reply);
  assert.deepEqual(await two.chat({ message: "later", thinking: false }, prior), reply);
});

test("browser command protocol accepts ego's stderr result and never puts credentials in its script", { skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "browser-command-fixture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = join(directory, "ego-fixture");
  await writeFile(command, `#!${process.execPath}\nlet input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
if(input.includes('__Secure-1PSID')||input.includes('private-cookie-canary'))process.exit(2);
console.error('unrelated browser status');
console.error('WEB_AI_BROWSER_RESULT:'+JSON.stringify({result:${JSON.stringify(reply)}}));});\n`, { mode: 0o700 });
  const client = new GeminiBrowserChatClient("__Secure-1PSID=private-cookie-canary", { spaceId: 15, email, command }, { userAgent: "fixture-browser" });
  assert.deepEqual(await client.chat({ message: "ordinary product review", thinking: false }, prior), reply);
});

test("browser transport rejects cancelled, malformed, media-only, and unsupported input before invoking the browser", async () => {
  let calls = 0;
  const client = new GeminiBrowserChatClient("__Secure-1PSID=fixture", { spaceId: 15, email }, { userAgent: "fixture-browser",
    runBrowser: async () => { calls++; return reply; } });
  await assert.rejects(client.chat({ message: "", thinking: false }));
  await assert.rejects(client.chat({ message: "review", thinking: true }));
  await assert.rejects(client.chat({ message: "review", thinking: false, thinkingLevel: "unknown" }));
  await assert.rejects(client.chat({ message: "review", thinking: false }, { ...prior, mediaReadOnly: true }));
  await assert.rejects(client.chat({ message: "review", thinking: false }, { ...prior, replyId: "invalid" }));
  await assert.rejects(client.chat({ message: "review", thinking: false, signal: AbortSignal.abort() }));
  await assert.rejects(client.chat({ message: "review", thinking: false, files: [{ name: "../private.txt", buffer: Buffer.from("x") }] }));
  assert.equal(calls, 0);
});

test("native UI preflight rejects another owner, busy Pages, drafts, and externally advanced replies before sending", async () => {
  for (const state of [{ email: "other@example.test" }, { busy: true }, { draft: "human draft" }, { replyId: "r_elsewhere" }]) {
    let clicks = 0;
    const page = { label: "p1", url: async () => "https://gemini.google.com/app/one", goto: async () => {}, waitForSelector: async () => {}, waitForFunction: async () => {},
      evaluate: async (...args: unknown[]) => {
        assert.ok(args.length === 1 || args[1] !== undefined, "ego-browser does not accept an explicit undefined evaluate argument");
        return { email, path: "/app/one", replyId: "r_one", busy: false, draft: "", userTurns: 1, ...state };
      },
      click: async () => { clicks++; } };
    const runtime = { taskSpace: async () => ({ page: () => page }) } as unknown as BrowserRuntime;
    const input: BrowserChatInput = { spaceId: 15, email, message: "review", thinkingLevel: "high", previous: prior, files: [], timeoutMs: 10000 };
    await assert.rejects(browserChat(input, runtime), (e: any) => ["authentication_error", "session_state_error"].includes(e.code) && !e.sessionUncertain);
    assert.equal(clicks, 0);
  }
});
