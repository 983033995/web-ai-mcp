import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SessionStore } from "../src/core/session-store.js";
import { ProviderError, type MediaGenerationRequest, type RemoteSession, type WebAIProvider } from "../src/core/provider.js";
import { DoubaoWebClient } from "../src/providers/doubao/web-client.js";
import { DOUBAO_IMAGE_MODELS, DOUBAO_IMAGE_RATIOS, creationAbility, creationMedia } from "../src/providers/doubao/media.js";
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
const referenceImage = { name: "reference.png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64") };

test("Doubao media selects observed image/video abilities and rejects unsupported parameters before dispatch", () => {
  const still = creationAbility({ kind: "image", prompt: "fixture prompt" });
  assert.equal(still.ability_type, 3);
  assert.deepEqual(JSON.parse(still.ability_param), { ability_type: 1, ability_param: { model: "Seedream 5.0 Flash", ratio: "auto", input_box_content: { user_input_content: "fixture prompt", reply_message_format: "生成图片：%s" } } });
  const moving = creationAbility({ kind: "video", model: "Seedance 2.5", prompt: "fixture motion", ratio: "9:16", durationSeconds: 30 });
  assert.equal(moving.ability_type, 17);
  assert.deepEqual(JSON.parse(moving.ability_param), { model: "seedance_v2.5", ratio: "9:16", duration: 30, camera_movement: "fixed", input_box_content: { user_input_content: "fixture motion", reply_message_format: "生成视频：%s" } });
  assert.equal(JSON.parse(creationAbility({ kind: "video", prompt: "default" }).ability_param).model, "seedance_v2.0");
  for (const model of DOUBAO_IMAGE_MODELS) {
    const ability = creationAbility({ kind: "image", model, prompt: "fixture" });
    assert.equal(JSON.parse(ability.ability_param).ability_param.model, model);
  }
  for (const [model, expected] of [["Seedance 2.0 Fast", "seedance_v2.0"], ["Seedance 2.0", "seedance_v2.0_std"], ["Seedance 2.0 Mini", "seedance_v2.0_mini"]]) {
    assert.equal(JSON.parse(creationAbility({ kind: "video", model, prompt: "fixture", durationSeconds: 15 }).ability_param).model, expected);
    assert.throws(() => creationAbility({ kind: "video", model, prompt: "fixture", durationSeconds: 16 }), (e: any) => e.code === "invalid_request");
  }
  for (const bad of [{ kind: "video", prompt: "x", durationSeconds: 3 }, { kind: "video", prompt: "x", durationSeconds: 31 },
    { kind: "video", prompt: "x", durationSeconds: 4.1 }, { kind: "image", prompt: "x", durationSeconds: 4 },
    { kind: "image", prompt: "x", ratio: "21:9" }, { kind: "image", prompt: " " },
    { kind: "image", prompt: "x", model: "Seedance 2.0 Fast" }, { kind: "video", prompt: "x", model: "Seedream 4.0" },
    { kind: "video", prompt: "x", model: "seedance_v2.0" }, { kind: "image", prompt: "x", model: "unknown" }]) {
    assert.throws(() => creationAbility(bad as MediaGenerationRequest), (e: any) => e.code === "invalid_request");
  }
});

test("Doubao image ratios and website style mapping are independent of model selection", () => {
  for (const ratio of DOUBAO_IMAGE_RATIOS) {
    const ability = creationAbility({ kind: "image", model: "Seedream 4.0", prompt: "fixture", ratio, style: "水彩画" });
    const value = JSON.parse(ability.ability_param).ability_param;
    assert.equal(value.ratio, ratio); assert.equal(value.style, "skill_image_styles_watercolor");
  }
  for (const bad of [{ kind: "video", prompt: "x", style: "水彩画" }, { kind: "image", prompt: "x", style: "unknown" },
    { kind: "video", prompt: "x", referenceImages: [referenceImage] }, { kind: "image", prompt: "x", referenceImages: [] },
    { kind: "image", prompt: "x", referenceImages: Array(6).fill(referenceImage) }]) assert.throws(() => creationAbility(bad as MediaGenerationRequest));
});

test("Doubao reference image upload uses image grant and separate attachment message with requested generation parameters", async () => {
  const paths: string[] = [];
  const client = new DoubaoWebClient(cookie, { chatUrl, userAgent: "fixture", fetch: async (url, init) => {
    const address = new URL(String(url)); paths.push(address.pathname);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (address.pathname === "/alice/resource/prepare_upload") {
      assert.equal(body.resource_type, 2);
      return Response.json({ code: 0, data: { service_id: "fixture", upload_auth_token: { access_key: "access", secret_key: "secret", session_token: "token" } } });
    }
    if (address.searchParams.get("Action") === "ApplyImageUpload") {
      assert.equal(address.searchParams.get("FileExtension"), ".png");
      return Response.json({ Result: { UploadAddress: { StoreInfos: [{ StoreUri: "fixture/ref.png", Auth: "fixture-auth" }], UploadHosts: ["tos-d-x-lf.snssdk.com"], SessionKey: "fixture-session" } } });
    }
    if (address.pathname.startsWith("/upload/v1/")) {
      assert.equal(new Headers(init?.headers).get("cookie"), null);
      assert.deepEqual(Buffer.from(init?.body as Uint8Array), referenceImage.buffer);
      return Response.json({ code: 2000, data: { crc32: new Headers(init?.headers).get("content-crc32") } });
    }
    if (address.searchParams.get("Action") === "CommitImageUpload") return Response.json({ Result: { Results: [{ Uri: "fixture/ref.png", UriStatus: 2000 }],
      PluginResult: [{ SourceUri: "fixture/ref.png", ImageUri: "fixture/ref.png", ImageWidth: 1, ImageHeight: 1, ImageFormat: "png", NotFound: false }] } });
    assert.equal(address.pathname, "/chat/completion");
    assert.equal(body.messages.length, 2);
    const attachment = body.messages[0].content_block[0].content.attachment_block.attachments[0];
    assert.equal(attachment.type, 1); assert.equal(attachment.image.uri, "fixture/ref.png"); assert.equal(attachment.parse_state, 0);
    assert.equal(attachment.image.image_ori.width, 1);
    assert.equal(body.messages[1].content_block[0].block_type, 10000);
    assert.match(body.messages[1].content_block[0].content.text_block.text, /图片风格为水彩画，3:4$/);
    const params = JSON.parse(body.chat_ability.ability_param).ability_param;
    assert.equal(params.model, "Seedream 4.0"); assert.equal(params.style, "skill_image_styles_watercolor"); assert.equal(params.ratio, "3:4");
    return new Response(ack + text + chunk(card([image()])) + end, { headers: { "content-type": "text/event-stream" } });
  } });
  assert.equal((await client.generateMedia({ kind: "image", prompt: "fixture", model: "Seedream 4.0", ratio: "3:4", style: "水彩画", referenceImages: [referenceImage] })).media?.[0].status, "completed");
  assert.deepEqual(paths, ["/alice/resource/prepare_upload", "/top/v1", "/upload/v1/fixture/ref.png", "/top/v1", "/chat/completion"]);
});

test("Doubao validates all reference image buffers before upload and blocks writes after an image CAPTCHA", async () => {
  let calls = 0;
  const client = new DoubaoWebClient(cookie, { chatUrl, userAgent: "fixture", fetch: async () => { calls++; return Response.json({ code: 710022004 }); } });
  await assert.rejects(client.generateMedia({ kind: "image", prompt: "x", referenceImages: [referenceImage, { name: "bad.png", buffer: Buffer.from("not an image") }] }),
    (e: any) => e.code === "invalid_reference_image" && !e.sessionUncertain);
  assert.equal(calls, 0);
  await assert.rejects(client.generateMedia({ kind: "image", prompt: "x", referenceImages: [referenceImage] }), (e: any) => e.code === "captcha_required" && !e.sessionUncertain);
  await assert.rejects(client.generateMedia({ kind: "image", prompt: "x" }), (e: any) => e.code === "captcha_required");
  assert.equal(calls, 1);
});

test("Doubao HTTP switches requested models on one session and rejects incompatible durations without a write", async () => {
  const models: string[] = [];
  const client = new DoubaoWebClient(cookie, { chatUrl, userAgent: "fixture", fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    models.push(JSON.parse(body.chat_ability.ability_param).model);
    assert.equal(body.client_meta.conversation_id, "conv");
    assert.equal(body.option.need_create_conversation, false);
    return new Response(ack + text.replace('"message_index":3', '"message_index":5').replace('"message_id":"answer"', '"message_id":"advanced"') + end,
      { headers: { "content-type": "text/event-stream" } });
  } });
  for (const model of [undefined, "Seedance 2.5", "Seedance 2.0 Mini"]) await client.generateMedia({ kind: "video", prompt: "fixture", model }, previous);
  assert.deepEqual(models, ["seedance_v2.0", "seedance_v2.5", "seedance_v2.0_mini"]);
  for (const bad of [{ kind: "video", model: "Seedance 2.0 Fast", prompt: "fixture", durationSeconds: 30 },
    { kind: "image", model: "unknown", prompt: "fixture" }]) {
    await assert.rejects(client.generateMedia(bad as MediaGenerationRequest, previous), (e: any) => e.code === "invalid_request" && !e.sessionUncertain);
  }
  assert.equal(models.length, 3);
});

test("Doubao creation snapshots replace pending cards and expose actual URLs without raw task IDs", async () => {
  const reply = await parse(ack + text + chunk(card([image(1)])) + chunk(card([image()])) + end);
  assert.deepEqual(reply.media, [{ id: "96c2e389b3ec7dbcde40192a3aad0cca9f306ab228418f9672ade514d20bad83", type: "image", status: "completed", url: imageURL, width: 2048, height: 2048 }]);
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
    async generateMedia(request, remote) { generations.push({ request, previous: remote }); return { content: "Please confirm parameters",
      remoteSession: remote ? { ...remote, lastMessageId: "switched", lastMessageIndex: Number(remote.lastMessageIndex) + 1 } : previous }; },
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
  assert.equal(generations[0].request.model, "Seedance 2.0 Fast");
  assert.equal(generations[0].previous, undefined); assert.equal(sessions.defaultKey(), existing.key);
  const key = generated.text.match(/session_key: ([a-f0-9-]+)/)![1];
  const restarted = new SessionStore(0, Date.now, path); const second = await connect(restarted);
  const status = await second.call("doubao_media_status", { session_key: key });
  assert.equal(status.error, false); assert.ok(status.text.includes(videoURL));
  assert.equal(restarted.require(key, "doubao").remote.lastMessageIndex, 5);
  const failure = await second.call("doubao_media_status", { session_key: key });
  assert.equal(failure.error, true); assert.ok(!failure.text.includes("SECRET_CANARY"));
  assert.equal(restarted.require(key, "doubao").state, "active");
  for (const args of [{ prompt: "x", duration_seconds: 3 }, { prompt: "x", unknown: true }, { prompt: "x", model: "Seedream 4.0" },
    { prompt: "x", model: "unknown" }]) assert.equal((await second.call("doubao_generate_video", args)).error, true);
  assert.equal((await second.call("doubao_generate_image", { prompt: "x", model: "Seedance 2.0 Fast" })).error, true);
  const switched = await second.call("doubao_generate_video", { prompt: "switch fixture", session_key: key, model: "Seedance 2.5", duration_seconds: 30 });
  assert.equal(switched.error, false); assert.ok(switched.text.includes(key));
  assert.equal(generations[1].request.model, "Seedance 2.5"); assert.equal(generations[1].request.durationSeconds, 30);
  assert.equal(generations[1].previous?.lastMessageIndex, 5);
  const still = await second.call("doubao_generate_image", { prompt: "image switch fixture", model: "Seedream 4.0" });
  assert.equal(still.error, false); assert.equal(generations[2].request.model, "Seedream 4.0");
  const imagePath = join(directory, "reference.png"); writeFileSync(imagePath, referenceImage.buffer);
  const oldRoots = process.env.WEB_AI_ALLOWED_ROOTS;
  t.after(() => { if (oldRoots === undefined) delete process.env.WEB_AI_ALLOWED_ROOTS; else process.env.WEB_AI_ALLOWED_ROOTS = oldRoots; });
  delete process.env.WEB_AI_ALLOWED_ROOTS;
  assert.equal((await second.call("doubao_generate_image", { prompt: "x", reference_image_paths: [imagePath] })).error, true);
  process.env.WEB_AI_ALLOWED_ROOTS = directory;
  const outside = mkdtempSync(join(tmpdir(), "doubao-reference-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "outside.png"), referenceImage.buffer);
  symlinkSync(join(outside, "outside.png"), join(directory, "escape.png"));
  for (const path of ["relative.png", join(directory, "escape.png"), join(outside, "outside.png")]) assert.equal((await second.call("doubao_generate_image", { prompt: "x", reference_image_paths: [path] })).error, true);
  assert.equal((await second.call("doubao_generate_image", { prompt: "reference fixture", model: "Seedream 4.0", ratio: "3:4", style: "水彩画", reference_image_paths: [imagePath] })).error, false);
  assert.equal(generations[3].request.style, "水彩画"); assert.equal(generations[3].request.ratio, "3:4");
  assert.deepEqual(generations[3].request.referenceImages?.[0].buffer, referenceImage.buffer);
  const foreign = restarted.put({ providerId: "deepseek", remote: {}, title: "foreign" });
  for (const session_key of ["00000000-0000-4000-8000-000000000000", foreign.key]) assert.equal((await second.call("doubao_media_status", { session_key })).error, true);
  assert.equal(reads, 2); assert.equal(generations.length, 4);
  const disk = readFileSync(path, "utf8"); for (const secret of ["synthetic-prompt-canary", videoURL, "SECRET_CANARY"]) assert.ok(!disk.includes(secret));
});
