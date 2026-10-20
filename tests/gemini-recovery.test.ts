import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GeminiWebClient } from "../src/providers/gemini/web-client.js";
import { GeminiWebProvider } from "../src/providers/gemini/index.js";
import { GeminiMediaQuotaError, GeminiMediaRecoveryError } from "../src/providers/gemini/errors.js";
import { parseGeminiStream } from "../src/providers/gemini/stream.js";
import { SessionStore } from "../src/core/session-store.js";
import { registerGeminiTools } from "../src/tools/gemini.js";

const cookie = "__Secure-1PSID=fixture";
const html = '<script>{"SNlM0e":"fixture-at","cfb2h":"fixture-build","FdrFJe":"fixture-page","oPEP7c":"fixture@example.test"}</script>';
const lineage = { conversationId: "c_0123456789abcdef", replyId: "r_fixture", candidateId: "rc_fixture" };
const videoURL = "https://contribution.usercontent.google.com/download?c=fixture&filename=clip.mp4&opi=1";
function candidate(status = 1): any[] {
  const c: any[] = Array(13).fill(null); c[0] = lineage.candidateId; c[8] = [status];
  c[12] = [{ "60": status === 1 ? [[[null, null, null, 1]]] : [[[[Object.assign(Array(25).fill(null), {
    7: ["https://lh3.googleusercontent.com/gg/fixture", videoURL], 17: [[10, 0], 720, 1280],
  })]]]] }];
  return c;
}
function stream(complete = false, conflict = false): Response {
  const record: any[] = Array(26).fill(null); record[1] = [lineage.conversationId, lineage.replyId]; record[4] = [candidate()];
  const frame = JSON.stringify([["wrb.fr", null, JSON.stringify(record)]]);
  const next = conflict ? "\n" + JSON.stringify([["wrb.fr", null, JSON.stringify([null, ["c_different", "r_other"]])]]) : "";
  return new Response(`)]}'\n${frame}\n${next}${complete ? "di\n" : ""}`, { headers: { "content-type": "application/json" } });
}
function history(status = 1): Response {
  const turn: any[] = []; turn[0] = [null, lineage.replyId]; turn[3] = [[candidate(status)]];
  const frame = JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify([[turn]]), null, null, null]]);
  return new Response(`)]}'\n${frame.length + 2}\n${frame}\ndi\n`, { headers: { "content-type": "application/json" } });
}
function fixture(historyFailure = false) {
  let writes = 0, reads = 0;
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent: "fixture-browser", fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/app") return new Response(html);
    if (url.pathname.endsWith("StreamGenerate")) { writes++; return stream(); }
    if (url.pathname.endsWith("batchexecute")) {
      reads++;
      assert.equal(url.searchParams.get("rpcids"), "hNvQHb");
      if (historyFailure) return new Response("private error", { status: 429 });
      return history();
    }
    throw new Error("unexpected fixture call");
  } });
  return { client, counts: () => ({ writes, reads }) };
}

test("an interrupted media stream exposes only validated recovery lineage, never conflicting IDs", async () => {
  await assert.rejects(parseGeminiStream(stream().body!, new AbortController().signal, { quotaKind: "video" }), (e: any) => {
    assert.ok(e instanceof GeminiMediaRecoveryError); assert.deepEqual(e.lineage, lineage); return e.sessionUncertain;
  });
  await assert.rejects(parseGeminiStream(stream(false, true).body!, new AbortController().signal, { quotaKind: "video" }),
    (e: any) => e.sessionUncertain && !(e instanceof GeminiMediaRecoveryError));
  await assert.rejects(parseGeminiStream(stream().body!, new AbortController().signal),
    (e: any) => e.sessionUncertain && !(e instanceof GeminiMediaRecoveryError));
});

test("one generation write followed by exact history confirmation returns a media-only key and never resubmits", async () => {
  const f = fixture(); const provider = new GeminiWebProvider(cookie, f.client);
  const result = await provider.generateMedia({ kind: "video", prompt: "A paper windmill turns." });
  assert.deepEqual(f.counts(), { writes: 1, reads: 1 });
  assert.equal(result.media?.[0].status, "pending"); assert.equal(result.remoteSession?.mediaReadOnly, true);
  assert.match(result.warning!, /read-only/);
  await assert.rejects(provider.chat({ message: "never send", thinking: false }, result.remoteSession), (e: any) => e.code === "session_state_error");
  await assert.rejects(provider.generateMedia({ kind: "video", prompt: "never regenerate" }, result.remoteSession), (e: any) => e.code === "session_state_error");
  const status = await provider.getMedia(result.remoteSession!);
  assert.equal(status.remoteSession?.mediaReadOnly, true);
  assert.deepEqual(f.counts(), { writes: 1, reads: 2 });
});

test("metadata-only video acknowledgement resolves its exact reply from history, including a candidate published later", async () => {
  let writes = 0, reads = 0;
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent: "fixture-browser", fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === "/app") return new Response(html);
    if (url.pathname.endsWith("StreamGenerate")) {
      writes++;
      const record = [null, [lineage.conversationId, lineage.replyId], {}];
      return new Response(`)]}'\n${JSON.stringify([["wrb.fr", null, JSON.stringify(record)]])}\ndi\n`, { headers: { "content-type": "application/json" } });
    }
    reads++;
    if (reads === 1) {
      const empty = JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify([[]]), null, null, null]]);
      return new Response(`)]}'\n${empty}\ndi\n`, { headers: { "content-type": "application/json" } });
    }
    return history();
  } });
  const provider = new GeminiWebProvider(cookie, client);
  const first = await provider.generateMedia({ kind: "video", prompt: "A turning fan." });
  assert.equal(first.remoteSession?.conversationId, lineage.conversationId);
  assert.equal(first.remoteSession?.candidateId, undefined);
  assert.equal(first.remoteSession?.mediaReadOnly, true);
  assert.equal(first.media?.[0].status, "pending");
  const next = await provider.getMedia(first.remoteSession!);
  assert.equal(next.remoteSession?.candidateId, lineage.candidateId);
  assert.equal(next.remoteSession?.mediaReadOnly, true);
  assert.equal(writes, 1); assert.equal(reads, 2);
  await assert.rejects(provider.chat({ message: "never send", thinking: false }, first.remoteSession), (e: any) => e.code === "session_state_error");
  assert.equal(writes, 1);
});

test("a recovery lookup failure remains uncertain and does not authorize account failover", async () => {
  const f = fixture(true);
  await assert.rejects(f.client.generateMedia({ kind: "video", prompt: "A drifting leaf." }),
    (e: any) => e.code === "rate_limit_error" && e.sessionUncertain);
  assert.deepEqual(f.counts(), { writes: 1, reads: 1 });
});

test("a quota notice in existing history reads the reset once, never submitting generation", async () => {
  const futureSeconds = Math.floor(Date.now() / 1000) + 300;
  let historyReads = 0, quotaReads = 0, writes = 0;
  const client = new GeminiWebClient(cookie, { baseUrl: "http://127.0.0.1", userAgent: "fixture-browser", fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === "/app") return new Response(html);
    if (url.pathname.endsWith("StreamGenerate")) { writes++; throw new Error("must not generate"); }
    let rpc: string, record: unknown;
    if (url.searchParams.get("rpcids") === "hNvQHb") {
      historyReads++;
      const c = candidate(2); c[1] = ["I can create more videos as soon as your limit resets. Check your usage in Settings."];
      c[12] = [{ "60": [[[null, ["opaque diagnostic"], null, 6]]] }];
      const turn: any[] = []; turn[0] = [null, lineage.replyId]; turn[3] = [[c]];
      rpc = "hNvQHb"; record = [[turn]];
    } else { quotaReads++; rpc = "aPya6c"; record = [true, 1, [futureSeconds]]; }
    const frame = JSON.stringify([["wrb.fr", rpc, JSON.stringify(record), null, null, null]]);
    return new Response(`)]}'\n${frame.length + 2}\n${frame}\ndi\n`, { headers: { "content-type": "application/json" } });
  } });
  await assert.rejects(client.getMedia({ ...lineage, accountHash: createHash("sha256").update("fixture@example.test").digest("hex"), mediaKind: "video" }),
    (e: any) => e instanceof GeminiMediaQuotaError && e.resetAtMs === futureSeconds * 1000);
  assert.deepEqual({ historyReads, quotaReads, writes }, { historyReads: 1, quotaReads: 1, writes: 0 });
});

test("owner URL recovery uses one history lookup, validates scope and preserves media-only state through status", async t => {
  const f = fixture(); const provider = new GeminiWebProvider(cookie, f.client);
  const directory = await mkdtemp(resolve(".validation-gemini-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = join(directory, "sessions.json");
  const sessions = new SessionStore(0, Date.now, storePath); const server = new McpServer({ name: "fixture", version: "0" });
  // A single-account adapter mirrors the account-aware production method signature.
  const routed = Object.assign(provider, { recoverMedia: (conversationId: string, kind: "image" | "video", _account?: string, signal?: AbortSignal) =>
    new GeminiWebProvider(cookie, f.client).recoverMedia(conversationId, kind, undefined, signal) });
  registerGeminiTools(server, routed, sessions);
  const client = new Client({ name: "fixture", version: "0" }); const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); t.after(async () => { await client.close(); await server.close(); });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  for (const url of ["https://evil.test/app/0123456789abcdef", "https://gemini.google.com/app/0123456789abcdef?token=secret", "https://gemini.google.com/app/../account"]) {
    assert.equal((await call("gemini_recover_media", { conversation_url: url, kind: "video" })).isError, true);
  }
  assert.deepEqual(f.counts(), { writes: 0, reads: 0 });
  const recovered = await call("gemini_recover_media", { conversation_url: "https://gemini.google.com/app/0123456789abcdef", kind: "video" });
  assert.equal(recovered.isError, undefined);
  const text = (recovered.content as any[]).map(c => c.text).join("\n"), key = text.match(/session_key: ([a-f0-9-]{36})/)[1];
  assert.equal(sessions.require(key, "gemini").remote.mediaReadOnly, true);
  const restored = new SessionStore(0, Date.now, storePath).require(key, "gemini");
  assert.equal(restored.remote.mediaReadOnly, true);
  await assert.rejects(provider.chat({ message: "blocked after restart", thinking: false }, restored.remote), (e: any) => e.code === "session_state_error");
  await call("gemini_media_status", { session_key: key });
  assert.equal(sessions.require(key, "gemini").remote.mediaReadOnly, true);
  assert.equal((await call("gemini_chat", { session_key: key, message: "blocked" })).isError, true);
  assert.deepEqual(f.counts(), { writes: 0, reads: 2 });
  assert.ok(!text.includes("fixture-at")); assert.ok(!text.includes("fixture@example.test"));
});
