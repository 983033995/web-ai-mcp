import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SessionStore } from "../src/core/session-store.js";
import { DoubaoWebProvider } from "../src/providers/doubao/index.js";
import { DoubaoWebClient } from "../src/providers/doubao/web-client.js";
import { creationMedia } from "../src/providers/doubao/media.js";
import { registerDoubaoTools } from "../src/tools/doubao.js";

const cookie = "sessionid=private-canary; passport_csrf_token=fixture; s_v_web_id=fixture";
const chatUrl = "https://www.doubao.com/chat/completion?aid=497858&device_id=1&web_id=2&tea_uuid=3&fp=fixture&pc_version=3.41.4&region=CN&sys_region=CN&web_tab_id=fixture";
const uri = "tos-cn-i-fixture/rc_gen_image/fixture.png";
const imageURL = "https://p5-flow-imagex-sign.byteimg.com/fixture.png";
const cleanURL = imageURL + "?x-signature=clean";
const videoURL = "https://v11-vdl.doubao.com/fixture.mp4";
const previous = { conversationId: "conv", sectionId: "section", lastMessageId: "answer", lastMessageIndex: 3, localConversationId: "local" };
const image = { type: 1, id: "stable-image", image: { key: uri, status: 2, image_ori: { url: imageURL, width: 1, height: 1 } } };
const video = { type: 2, id: "stable-video", video: { status: 3, download_url: videoURL, width: 1, height: 1, duration: 4 } };
const imageId = creationMedia({ creations: [image] })[0].id!;
const videoId = creationMedia({ creations: [video] })[0].id!;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const box = (kind: string, body: Buffer) => { const header = Buffer.alloc(8); header.writeUInt32BE(body.length + 8); header.write(kind, 4); return Buffer.concat([header, body]); };
const mp4 = Buffer.concat([box("ftyp", Buffer.from("mp42\0\0\0\0", "binary")), box("moov", Buffer.from([1])), box("mdat", Buffer.from([2]))]);

test("MCP downloads selected completed media without generation, requires directory, confirms official image watermark permission and preserves lineage on download failure", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "doubao-download-")));
  const oldDir = process.env.WEB_AI_MEDIA_DIR;
  const originalFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = originalFetch; if (oldDir === undefined) delete process.env.WEB_AI_MEDIA_DIR; else process.env.WEB_AI_MEDIA_DIR = oldDir; await rm(directory, { recursive: true, force: true }); });
  let historyReads = 0, watermarkReads = 0, cdnReads = 0;
  let permission = true, invalidResponse = false, cdnFailure = false, reverse = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.redirect, "error");
    if (url.pathname === "/im/chain/single") {
      historyReads++;
      assert.equal(new Headers(init?.headers).get("cookie"), cookie);
      return Response.json({ status_code: 0, downlink_body: { pull_singe_chain_downlink_body: { messages: [{ conversation_id: "conv", user_type: 2,
        message_id: "delivered", section_id: "section", index_in_conv: 5, content_block: [{ block_type: 2074,
          content: { creation_block: { creations: reverse ? [video, image] : [image, video] } } }] }] } } });
    }
    if (url.pathname === "/creativity/resource/get_without_watermark") {
      watermarkReads++; assert.equal(new Headers(init?.headers).get("cookie"), cookie);
      assert.deepEqual(JSON.parse(init!.body as string), { uri: [uri] });
      return Response.json({ code: 0, data: { without_watermark: permission, download_image: { [uri]: { uri: invalidResponse ? "different" : uri, url: cleanURL } } } });
    }
    assert.ok(["p5-flow-imagex-sign.byteimg.com", "v11-vdl.doubao.com"].includes(url.hostname));
    cdnReads++;
    assert.equal(new Headers(init?.headers).get("cookie"), null);
    assert.equal(new Headers(init?.headers).get("x-tt-passport-csrf-token"), null);
    if (cdnFailure) throw new Error("private-url-canary");
    return new Response(url.hostname.startsWith("p") ? png : mp4, { headers: { "content-type": url.hostname.startsWith("p") ? "image/png" : "video/mp4" } });
  };
  const provider = new DoubaoWebProvider(cookie, new DoubaoWebClient(cookie, { chatUrl, userAgent: "fixture" }));
  const storePath = join(directory, "sessions.json");
  const sessions = new SessionStore(0, Date.now, storePath);
  const record = sessions.put({ providerId: "doubao", remote: previous });
  const server = new McpServer({ name: "download-fixture", version: "0" });
  registerDoubaoTools(server, provider, sessions);
  const client = new Client({ name: "download-fixture", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "doubao_download_media", arguments: { session_key: record.key, ...args } });
    return { error: !!result.isError, text: (result.content as Array<{ text?: string }>).map(x => x.text ?? "").join("\n") };
  };
  const listing = (await client.listTools()).tools.find(x => x.name === "doubao_download_media")!;
  assert.equal(listing.annotations?.destructiveHint, false); assert.equal(listing.annotations?.readOnlyHint, false);
  delete process.env.WEB_AI_MEDIA_DIR;
  assert.equal((await call({ media_id: imageId })).error, true); assert.equal(historyReads, 0);
  process.env.WEB_AI_MEDIA_DIR = directory;
  const first = await call({ media_id: imageId }); assert.equal(first.error, false, first.text);
  const file = JSON.parse(first.text); assert.equal(file.bytes, png.length); assert.equal(file.watermark, "original");
  assert.deepEqual(await readFile(file.local_path), png);
  reverse = true;
  const clean = await call({ media_id: imageId, without_watermark: true }); assert.equal(clean.error, false, clean.text);
  assert.equal(JSON.parse(clean.text).type, "image"); assert.equal(JSON.parse(clean.text).watermark, "without_watermark");
  const moving = await call({ media_id: videoId }); assert.equal(moving.error, false, moving.text);
  assert.deepEqual(await readFile(JSON.parse(moving.text).local_path), mp4);
  assert.equal(watermarkReads, 1); assert.equal(cdnReads, 3);
  for (const args of [{ media_id: videoId, without_watermark: true }, { media_id: "missing" }, { media_id: imageId, url: imageURL }, { media_id: imageId, session_key: "00000000-0000-4000-8000-000000000000" }]) {
    assert.equal((await call(args)).error, true);
  }
  permission = false;
  const denied = await call({ media_id: imageId, without_watermark: true }); assert.equal(denied.error, true); assert.match(denied.text, /watermark_unavailable/);
  permission = true; invalidResponse = true;
  assert.equal((await call({ media_id: imageId, without_watermark: true })).error, true);
  assert.equal(cdnReads, 3);
  cdnFailure = true;
  const failed = await call({ media_id: imageId }); assert.equal(failed.error, true); assert.ok(!failed.text.includes("private-url-canary"));
  assert.equal(sessions.require(record.key, "doubao").state, "active");
  assert.equal(sessions.require(record.key, "doubao").remote.lastMessageIndex, 5);
  assert.equal((await readdir(directory)).filter(x => x !== "sessions.json").length, 3);
  const stored = await readFile(storePath, "utf8");
  for (const secret of [cookie, imageURL, cleanURL, uri, "stable-image"]) assert.ok(!stored.includes(secret));
});

test("official watermark resolution rejects unsafe resources, blocks after CAPTCHA and returns despite a stalled cancellation cleanup", async () => {
  const media = creationMedia({ creations: [image] })[0];
  let calls = 0;
  const unsafe = new DoubaoWebClient(cookie, { chatUrl, userAgent: "fixture", fetch: async () => {
    calls++; return Response.json({ code: 0, data: { without_watermark: true, download_image: { [uri]: { uri, url: "https://evil.test/file" } } } });
  } });
  await assert.rejects(unsafe.resolveMediaDownload(media, true), (e: any) => e.code === "invalid_response" && !e.sessionUncertain);
  assert.equal(calls, 1);
  const blocked = new DoubaoWebClient(cookie, { chatUrl, userAgent: "fixture", fetch: async () => { calls++; return Response.json({ code: 710022004 }); } });
  await assert.rejects(blocked.resolveMediaDownload(media, true), (e: any) => e.code === "captcha_required" && !e.sessionUncertain);
  await assert.rejects(blocked.generateMedia({ kind: "image", prompt: "must not submit" }), (e: any) => e.code === "captcha_required");
  assert.equal(calls, 2);
  const stalled = new DoubaoWebClient(cookie, { chatUrl, userAgent: "fixture", timeout: 10, fetch: async () =>
    new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel() { return new Promise(() => {}); } }), { headers: { "content-type": "application/json" } }) });
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(Promise.race([stalled.resolveMediaDownload(media, true), new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("cleanup did not finish")), 250); })]),
      (e: any) => e.code === "timeout_error" && !e.sessionUncertain);
  } finally { if (guard) clearTimeout(guard); }
});
