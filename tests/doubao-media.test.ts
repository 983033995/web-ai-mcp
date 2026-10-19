import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SessionStore } from "../src/core/session-store.js";
import { ProviderError, type MediaGenerationRequest, type RemoteSession, type WebAIProvider } from "../src/core/provider.js";
import { DoubaoWebClient } from "../src/providers/doubao/web-client.js";
import { creationAbility, creationMedia } from "../src/providers/doubao/media.js";
import { parseSSE } from "../src/providers/doubao/sse.js";
import { registerDoubaoTools } from "../src/tools/doubao.js";

const cookie = "sessionid=fixture; passport_csrf_token=fixture; s_v_web_id=fixture";
const chatUrl = "https://www.doubao.com/chat/completion?aid=497858&device_id=1&web_id=2&tea_uuid=3&fp=fixture&pc_version=3.41.4&region=CN&sys_region=CN&web_tab_id=fixture";
const previous: RemoteSession = { conversationId: "conv", sectionId: "section", lastMessageId: "answer", lastMessageIndex: 3, localConversationId: "local-fixture" };
const imageURL = "https://p5-flow-imagex-sign.byteimg.com/fixture.png?x-signature=fixture";
const videoURL = "https://v11-vdl.doubao.com/fixture.mp4?fixture=1";
const image = (status = 2) => ({ type: 1, id: "creation-image", image: { status, image_ori: { url: imageURL, width: 2048, height: 2048 } } });
const video = () => ({ type: 2, id: "creation-video", video: { status: 3, download_url: videoURL, width: "384", height: "384", duration: 4.065 } });
const card = (creations: unknown[]) => ({ block_id: "media", block_type: 2074, content: { creation_block: { creations } } });
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const ack = frame("SSE_ACK", { ack_client_meta: { conversation_id: "conv", section_id: "section" } });
const text = frame("STREAM_MSG_NOTIFY", { message_id: "answer", message_index: 3, content: { content_block: [{ block_id: "text", block_type: 10000, content: { text_block: { text: "accepted" } } }] } });
const end = frame("SSE_REPLY_END", { end_type: 3 });
const chunk = (block: unknown, type = 1) => frame("STREAM_CHUNK", { message_id: "answer", patch_op: [{ patch_object: 1, patch_type: type, patch_value: { content_block: [block] } }] });
const parse = (data: string) => parseSSE(new Response(data).body!, new AbortController().signal);
const historyMessage = (index: string | number, creations: unknown[], user_type = 2) => ({ conversation_id: "conv", section_id: "section", message_id: index === "3" || index === 3 ? "answer" : "delivered", index_in_conv: index, user_type,
  content_block: [card(creations)] });
const history = (messages: unknown[]) => ({ status_code: 0, downlink_body: { pull_singe_chain_downlink_body: { messages } } });

test("Doubao media selects observed image/video abilities and rejects unsupported parameters before dispatch", () => {
  const still = creationAbility({ kind: "image", prompt: "fixture prompt" });
  assert.equal(still.ability_type, 3);
  assert.deepEqual(JSON.parse(still.ability_param), { ability_type: 1, ability_param: { model: "Seedream 5.0 Flash", ratio: "auto", input_box_content: { user_input_content: "fixture prompt", reply_message_format: "生成图片：%s" } } });
  const moving = creationAbility({ kind: "video", prompt: "fixture motion", ratio: "9:16", durationSeconds: 30 });
  assert.equal(moving.ability_type, 17);
  assert.deepEqual(JSON.parse(moving.ability_param), { model: "seedance_v2.5", ratio: "9:16", duration: 30, camera_movement: "fixed", input_box_content: { user_input_content: "fixture motion", reply_message_format: "生成视频：%s" } });
  for (const bad of [{ kind: "video", prompt: "x", durationSeconds: 3 }, { kind: "video", prompt: "x", durationSeconds: 31 },
    { kind: "video", prompt: "x", durationSeconds: 4.1 }, { kind: "image", prompt: "x", durationSeconds: 4 },
    { kind: "image", prompt: "x", ratio: "9:16" }, { kind: "image", prompt: " " }]) {
    assert.throws(() => creationAbility(bad as MediaGenerationRequest), (e: any) => e.code === "invalid_request");
  }
});

test("Doubao creation snapshots replace pending cards and expose actual URLs without raw task IDs", async () => {
  const reply = await parse(ack + text + chunk(card([image(1)])) + chunk(card([image()])) + end);
  assert.deepEqual(reply.media, [{ type: "image", status: "completed", url: imageURL, width: 2048, height: 2048 }]);
  assert.ok(!JSON.stringify(reply.media).includes("creation-image"));
  assert.equal((await parse(ack + text + chunk(card([image(1)])) + end)).media?.[0].status, "pending");
  assert.equal((await parse(ack + text + chunk(card([image(1)])) + chunk(card([]), 3) + end)).media, undefined);
  const onlyMedia = await parse(ack + frame("STREAM_MSG_NOTIFY", { message_id: "answer", message_index: 3, content: { content_block: [card([video()])] } }) + end);
  assert.equal(onlyMedia.content, ""); assert.equal(onlyMedia.media?.[0].durationSeconds, 4.065);
  const noResult = await parse(ack + text + end);
  assert.equal(noResult.media, undefined);
  await assert.rejects(parse(ack + text + chunk(card([image()]))));
});

test("Doubao media rejects unsafe/incomplete results and does not treat unknown statuses as complete", async () => {
  for (const url of ["javascript:alert(1)", "https://attacker.invalid/a.png", "https://p5-flow-imagex-sign.byteimg.com.attacker.invalid/a.png", "http://127.0.0.1/a", "https://user:secret@p5-flow-imagex-sign.byteimg.com/a"]) {
    const value = image(); value.image.image_ori.url = url;
    assert.throws(() => creationMedia({ creations: [value] }));
  }
  for (const value of [{ ...image(), image: { status: 2 } }, { ...image(), image: { status: 2, image_ori: { url: imageURL, width: -1 } } },
    { ...video(), video: { status: 3, download_url: videoURL, duration: -1 } }, { creations: null }]) {
    assert.throws(() => creationMedia({ creations: [value] }));
  }
  assert.equal(creationMedia({ creations: [{ ...video(), video: { status: 999 } }] })[0].status, "unavailable");
  assert.throws(() => creationMedia({ creations: [image(), image()] }));
  await assert.rejects(parse(ack + text + chunk(card([image()])) + frame("CHUNK_DELTA", { text: "no text context" }) + end));
});

test("Doubao accepts observed interrupt downlink metadata but refuses unknown commands", async () => {
  const command = { cmd: 310, downlink_body: { chunk_update_downlink_body: { interrupt_info: { no_interrupt: true, chat_id: "fixture" } } } };
  assert.equal((await parse(ack + frame("DOWNLINK_CMD", command) + text + end)).content, "accepted");
  for (const bad of [{ ...command, cmd: 999 }, { cmd: 310, downlink_body: {} }]) await assert.rejects(parse(ack + frame("DOWNLINK_CMD", bad) + text + end));
});

test("Doubao HTTP generation uses chat abilities; history is a bounded read and advances delivered reply lineage", async () => {
  const calls: Array<{ url: URL; body: any }> = [];
  const client = new DoubaoWebClient(cookie, { chatUrl, userAgent: "fixture", fetch: async (url, init) => {
    assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("cookie"), cookie);
    const body = JSON.parse(String(init?.body)); const address = new URL(String(url)); calls.push({ url: address, body });
    if (address.pathname === "/chat/completion") return new Response(ack + text + chunk(card([image()])) + end, { headers: { "content-type": "text/event-stream" } });
    assert.equal(address.pathname, "/im/chain/single");
    assert.equal(new Headers(init?.headers).get("content-type"), "application/json; encoding=utf-8");
    assert.equal(body.cmd, 3100); assert.equal(body.uplink_body.pull_singe_chain_uplink_body.limit, 20);
    assert.equal(body.uplink_body.pull_singe_chain_uplink_body.conversation_id, "conv");
    return Response.json(history([historyMessage("5", [video()]), historyMessage("3", [image()]), historyMessage("1", [image()], 1)]));
  } });
  const generated = await client.generateMedia({ kind: "image", prompt: "synthetic prompt" });
  assert.equal(generated.media?.[0].status, "completed");
  assert.equal(calls[0].body.chat_ability.ability_type, 3);
  assert.equal(calls[0].body.option.agent_mode, undefined);
  const result = await client.getMedia(previous);
  assert.equal(result.media?.length, 2); assert.equal(result.remoteSession?.lastMessageIndex, 5);
  assert.equal(result.remoteSession?.lastMessageId, "delivered");
  assert.equal(previous.lastMessageIndex, 3);
  assert.equal(calls.length, 2);
});

test("Doubao history rejects remapped/unsafe lineage and reports read failures without invalidating a session", async () => {
  for (const payload of [history([{ ...historyMessage("5", [video()]), conversation_id: "foreign" }]),
    history([{ ...historyMessage("3", []), message_id: "different" }]), history([historyMessage("9007199254740993", [])]),
    history(Array.from({ length: 21 }, () => historyMessage("3", []))), { status_code: 712012002, downlink_body: {} }, null, []]) {
    let calls = 0;
    const client = new DoubaoWebClient(cookie, { chatUrl, userAgent: "fixture", fetch: async () => { calls++; return Response.json(payload); } });
    await assert.rejects(client.getMedia(previous), (e: any) => !e.sessionUncertain);
    assert.equal(calls, 1);
  }
});

test("Doubao history CAPTCHA blocks generation, and read cancellation never writes a chat", async () => {
  let calls = 0;
  const client = new DoubaoWebClient(cookie, { chatUrl, userAgent: "fixture", fetch: async () => { calls++; return Response.json({ status_code: 710022004 }); } });
  await assert.rejects(client.getMedia(previous), (e: any) => e.code === "captcha_required" && !e.sessionUncertain);
  await assert.rejects(client.generateMedia({ kind: "video", prompt: "fixture" }), (e: any) => e.code === "captcha_required");
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  const cancelled = new DoubaoWebClient(cookie, { chatUrl, userAgent: "fixture", fetch: async () => { calls++; throw new Error("must not dispatch"); } });
  await assert.rejects(cancelled.getMedia(previous, controller.signal), (e: any) => e.code === "cancelled");
  assert.equal(calls, 1);
});

test("Doubao MCP media tools isolate project defaults, preserve restart lookup, and never store prompts or result URLs", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-media-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "sessions.json");
  const sessions = new SessionStore(0, Date.now, path);
  const existing = sessions.put({ providerId: "doubao", remote: previous, title: "fixture" }); sessions.selectDefault(existing.key, "doubao");
  const generations: Array<{ request: MediaGenerationRequest; previous?: RemoteSession }> = [];
  let reads = 0;
  const provider: WebAIProvider = { id: "doubao", displayName: "fixture", capabilities: { chat: true, thinking: true, files: false, webSearch: false, sessionResume: true, imageGeneration: true, videoGeneration: true },
    async initialize() {}, async chat() { throw new Error("unused"); },
    async generateMedia(request, remote) { generations.push({ request, previous: remote }); return { content: "Please confirm parameters", remoteSession: previous }; },
    async getMedia(remote) { reads++; if (reads === 2) throw new ProviderError("SECRET_CANARY", "network_error");
      return { content: "", media: creationMedia({ creations: [video()] }), remoteSession: { ...remote, lastMessageId: "delivered", lastMessageIndex: 5 } }; }
  };
  const connect = async (store: SessionStore) => {
    const server = new McpServer({ name: "fixture", version: "0" }); registerDoubaoTools(server, provider, store);
    const client = new Client({ name: "fixture", version: "0" }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
    t.after(async () => { await client.close(); await server.close(); });
    return { client, call: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return { error: !!result.isError, text: (result.content as Array<{ text?: string }>).map(c => c.text ?? "").join("\n") };
    } };
  };
  const f = await connect(sessions);
  for (const name of ["doubao_generate_image", "doubao_generate_video", "doubao_media_status"]) assert.ok((await f.client.listTools()).tools.some(t => t.name === name));
  const generated = await f.call("doubao_generate_video", { prompt: "synthetic-prompt-canary" });
  assert.equal(generated.error, false); assert.ok(generated.text.includes("no_media_returned"));
  assert.equal(generations[0].previous, undefined); assert.equal(sessions.defaultKey(), existing.key);
  const key = generated.text.match(/session_key: ([a-f0-9-]+)/)![1];
  const restarted = new SessionStore(0, Date.now, path); const second = await connect(restarted);
  const status = await second.call("doubao_media_status", { session_key: key });
  assert.equal(status.error, false); assert.ok(status.text.includes(videoURL));
  assert.equal(restarted.require(key, "doubao").remote.lastMessageIndex, 5);
  const failure = await second.call("doubao_media_status", { session_key: key });
  assert.equal(failure.error, true); assert.ok(!failure.text.includes("SECRET_CANARY"));
  assert.equal(restarted.require(key, "doubao").state, "active");
  for (const args of [{ prompt: "x", duration_seconds: 3 }, { prompt: "x", unknown: true }]) assert.equal((await second.call("doubao_generate_video", args)).error, true);
  const foreign = restarted.put({ providerId: "deepseek", remote: {}, title: "foreign" });
  for (const session_key of ["00000000-0000-4000-8000-000000000000", foreign.key]) assert.equal((await second.call("doubao_media_status", { session_key })).error, true);
  assert.equal(reads, 2); assert.equal(generations.length, 1);
  const disk = readFileSync(path, "utf8"); for (const secret of ["synthetic-prompt-canary", videoURL, "SECRET_CANARY"]) assert.ok(!disk.includes(secret));
});
