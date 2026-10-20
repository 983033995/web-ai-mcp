import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
let client;
let transport;
let directory;
let stage = "configuration";
let requests = 0;
let localId;
const fileLocalIds = new Map();
const uploadStages = [];
const messageIndexes = new Map();
let uploadedFixture;
let uploadedReference;
let uploadResourceType = 1;
const evidence = [];
const website = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks); const raw = bytes.toString();
    response.setHeader("Content-Type", "application/json");
    if (["/upload/v1/fixture-object/fixture.txt", "/upload/v1/fixture-object/reference.png"].includes(url.pathname)) {
      assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.authorization, "fixture-storage-auth");
      if (uploadResourceType === 2) assert.deepEqual(bytes, uploadedReference); else assert.equal(raw, uploadedFixture);
      uploadStages.push("upload");
      response.end(JSON.stringify({ code: 2000, data: { crc32: request.headers["content-crc32"] } })); return;
    }
    assert.equal(request.headers.cookie, "sessionid=fixture; passport_csrf_token=fixture; s_v_web_id=fixture");
    if (url.pathname === "/im/chain/single") {
      assert.equal(request.headers["content-type"], "application/json; encoding=utf-8");
      const body = JSON.parse(raw);
      const query = body.uplink_body.pull_singe_chain_uplink_body;
      assert.equal(body.cmd, 3100); assert.equal(query.limit, 20);
      assert.equal(query.conversation_id, "fixture-video-conv");
      response.end(JSON.stringify({ status_code: 0, downlink_body: { pull_singe_chain_downlink_body: { messages: [{
        conversation_id: query.conversation_id, section_id: "fixture-sec", user_type: 2, message_id: "delivered-video",
        index_in_conv: String(messageIndexes.get(query.conversation_id) + 2), content_block: [{ block_type: 2074, block_id: "video",
          content: { creation_block: { creations: [{ type: 2, id: "fixture-creation", video: { status: 3,
            download_url: "https://v11-vdl.doubao.com/fixture.mp4", width: "384", height: "384", duration: 4.065 } }] } } }]
      }] } } })); return;
    }
    if (url.pathname === "/alice/resource/prepare_upload") {
      uploadResourceType = JSON.parse(raw).resource_type;
      assert.ok([1, 2].includes(uploadResourceType));
      uploadStages.push("prepare"); response.end(JSON.stringify({ code: 0, data: { service_id: "fixture-service",
        upload_auth_token: { access_key: "fixture-access", secret_key: "fixture-secret", session_token: "fixture-token" } } })); return;
    }
    if (url.pathname === "/top/v1") {
      assert.ok(request.headers.authorization?.startsWith("AWS4-HMAC-SHA256 "));
      const action = url.searchParams.get("Action"); uploadStages.push(action);
      const uri = uploadResourceType === 2 ? "fixture-object/reference.png" : "fixture-object/fixture.txt";
      if (action === "ApplyImageUpload") response.end(JSON.stringify({ Result: { UploadAddress: { StoreInfos: [{ StoreUri: uri, Auth: "fixture-storage-auth" }],
        UploadHosts: ["127.0.0.1"], SessionKey: "fixture-upload-session" } } }));
      else { assert.equal(JSON.parse(raw).SessionKey, "fixture-upload-session"); response.end(JSON.stringify({ Result: { Results: [{ Uri: uri, UriStatus: 2000 }],
        ...(uploadResourceType === 2 ? { PluginResult: [{ SourceUri: uri, ImageUri: uri, ImageWidth: 1, ImageHeight: 1, ImageFormat: "png", NotFound: false }] } : {}) } })); }
      return;
    }
    assert.equal(url.pathname, "/chat/completion");
    const body = JSON.parse(raw);
    requests++;
    const attachment = body.messages[0].content_block.find(block => block.block_type === 10052);
    const generation = body.chat_ability;
    const fileConversation = Boolean((attachment && !generation) || body.client_meta.conversation_id === "fixture-file-conv");
    const conversation = generation ? generation.ability_type === 3 ? "fixture-image-conv" : "fixture-video-conv"
      : fileConversation ? "fixture-file-conv" : "fixture-conv";
    if (generation) {
      assert.equal(body.option.need_create_conversation, true);
      assert.equal(body.option.agent_mode, undefined);
      const parameters = JSON.parse(generation.ability_param);
      if (generation.ability_type === 3) {
        assert.equal(parameters.ability_param.model, "Seedream 4.0"); assert.equal(parameters.ability_param.style, "skill_image_styles_watercolor");
        assert.equal(parameters.ability_param.ratio, "3:4"); assert.equal(body.messages.length, 2);
        assert.equal(attachment.content.attachment_block.attachments[0].type, 1);
        assert.equal(attachment.content.attachment_block.attachments[0].image.uri, "fixture-object/reference.png");
        assert.match(body.messages[1].content_block[0].content.text_block.text, /图片风格为水彩画，3:4$/);
      }
      else { assert.equal(generation.ability_type, 17); assert.equal(parameters.model, "seedance_v2.0"); assert.equal(parameters.duration, 4); }
    } else if (attachment) {
      assert.equal(body.option.need_create_conversation, true);
      assert.equal(attachment.content.attachment_block.attachments[0].file.uri, "fixture-object/fixture.txt");
      assert.deepEqual(uploadStages, ["prepare", "ApplyImageUpload", "upload", "CommitImageUpload"]);
      fileLocalIds.set(conversation, body.client_meta.local_conversation_id);
    } else if (requests === 1) {
      assert.equal(body.option.need_create_conversation, true);
      localId = body.client_meta.local_conversation_id;
    } else {
      assert.equal(body.option.need_create_conversation, false);
      assert.equal(body.client_meta.conversation_id, conversation);
      assert.equal(body.client_meta.last_section_id, "fixture-sec");
      assert.equal(body.client_meta.last_message_index, messageIndexes.get(conversation));
      assert.equal(body.client_meta.local_conversation_id, fileConversation ? fileLocalIds.get(conversation) : localId);
    }
    const thinking = body.option.need_deep_think === 3;
    messageIndexes.set(conversation, requests * 2);
    assert.equal(body.option.model_config.model_item_key, generation ? "" : thinking ? "3" : "0");
    response.setHeader("Content-Type", "text/event-stream");
    response.end(frame("SSE_ACK", { ack_client_meta: { conversation_id: conversation, section_id: "fixture-sec" }, query_list: [{ question_id: "fixture-question" }] }) +
      (fileConversation ? frame("DOWNSTREAM_VERBOSE_INFO", { verbose_type: "fixture", verbose_payload: "{}" }) : "") +
      frame("STREAM_MSG_NOTIFY", { message_id: "fixture-answer-" + requests, message_index: requests * 2, content: { content_block: [
        ...(generation?.ability_type === 3 ? [{ block_type: 2074, block_id: "image", content: { creation_block: { creations: [{ type: 1,
          id: "fixture-image", image: { status: 2, image_ori: { url: "https://p5-flow-imagex-sign.byteimg.com/fixture.png", width: 2048, height: 2048 } } }] } } }] : []),
        ...(thinking ? [{ block_id: "thinking", block_type: 10040, content: { thinking_block: {} } },
          { block_id: "thought", parent_id: "thinking", block_type: 10000, content: { text_block: { text: "fixture-visible-thought" } } }] : []),
        { block_id: "b1", block_type: 10000, content: { text_block: { text: fileConversation ? "fixture-file-marker 89" : "fixture-answer-text" } } }
      ] } }) +
      frame("SSE_REPLY_END", { end_type: 3 }));
  } catch {
    response.statusCode = 400;
    response.end("Fixture rejected payload");
  }
});
try {
  directory = await mkdtemp(resolve(".validation-doubao-smoke-"));
  website.listen(0, "127.0.0.1");
  await once(website, "listening");
  const env = {
    DEEPSEEK_USER_TOKEN: "", DOUBAO_COOKIE: "sessionid=fixture; passport_csrf_token=fixture; s_v_web_id=fixture",
    DOUBAO_CHAT_URL: `http://127.0.0.1:${website.address().port}/chat/completion?aid=497858&device_id=1&web_id=2&tea_uuid=3&fp=fixture&pc_version=3.41.1&region=CN&sys_region=CN&web_tab_id=fixture`,
    DOUBAO_USER_AGENT: "fixture-agent", WEB_AI_MEDIA_DIR: "", WEB_AI_SESSION_STORE_PATH: join(directory, "sessions.json"), WEB_AI_SESSION_TTL_MINUTES: "0"
  };
  const connect = async () => {
    client = new Client({ name: "doubao-smoke", version: "0" });
    transport = new StdioClientTransport({ command: process.env.WEB_AI_SMOKE_COMMAND || process.execPath,
      args: process.env.WEB_AI_SMOKE_ARGS ? JSON.parse(process.env.WEB_AI_SMOKE_ARGS) : [resolve("dist/index.js")],
      cwd: process.env.WEB_AI_SMOKE_CWD, env, stderr: "pipe" });
    transport.stderr?.on("data", () => {});
    await client.connect(transport);
  };
  const call = async (name, args = {}) => {
    stage = name;
    const result = await client.callTool({ name, arguments: args });
    return { error: Boolean(result.isError), text: result.content.filter(i => i.type === "text").map(i => i.text).join("\n") };
  };
  stage = "stdio initialization";
  await connect();
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ["doubao_analyze_files", "doubao_chat", "doubao_download_media", "doubao_generate_image", "doubao_generate_video", "doubao_media_status", "doubao_reasoner", "doubao_session_close", "doubao_sessions_list", "webai_job_cancel", "webai_job_status", "webai_providers", "webai_usage"]);
  evidence.push("Doubao-only thirteen tools discovered, including usage and background job controls");
  const providers = JSON.parse((await call("webai_providers")).text);
  assert.equal(providers.active[0].id, "doubao");
  assert.equal(providers.active[0].capabilities.thinking, true);
  assert.equal(providers.active[0].capabilities.files, true);
  assert.equal(providers.active[0].capabilities.imageGeneration, true);
  assert.equal(providers.active[0].capabilities.videoGeneration, true);
  const first = await call("doubao_chat", { message: "first-canary", conversation_name: "fixture", make_default: true });
  assert.equal(first.error, false);
  const key = first.text.match(/session_key: ([a-f0-9-]{36})/)?.[1];
  assert.ok(key);
  assert.ok(!first.text.includes("fixture-conv"));
  evidence.push("product Provider HTTP response, answer aggregation and local key");
  await client.close(); await transport.close();
  stage = "restart";
  await connect();
  const second = await call("doubao_chat", { message: "second-canary" });
  assert.equal(second.error, false);
  assert.ok(second.text.includes(key));
  assert.equal(requests, 2);
  evidence.push("process restart preserves default and complete reply lineage");
  const expert = await call("doubao_reasoner", { message: "expert-canary", show_reasoning: true });
  assert.equal(expert.error, false); assert.ok(expert.text.includes("fixture-visible-thought"));
  assert.ok(expert.text.includes("## Doubao answer"));
  evidence.push("expert model parameters and separated visible reasoning");
  uploadedFixture = "fixture-file-marker\nA:17\nB:29\nC:43\n";
  const fixturePath = join(directory, "fixture.txt");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(fixturePath, uploadedFixture, { mode: 0o600 });
  env.WEB_AI_ALLOWED_ROOTS = directory;
  await client.close(); await transport.close(); await connect();
  const files = await call("doubao_analyze_files", { file_paths: [fixturePath], instruction: "read file fixture" });
  assert.equal(files.error, false); assert.ok(files.text.includes("fixture-file-marker 89"));
  const fileKey = files.text.match(/session_key: ([a-f0-9-]{36})/)?.[1]; assert.ok(fileKey);
  await client.close(); await transport.close(); await connect();
  const fileFollowup = await call("doubao_chat", { message: "file followup", session_key: fileKey });
  assert.equal(fileFollowup.error, false); assert.ok(fileFollowup.text.includes(fileKey));
  evidence.push("bounded TXT upload, commit, file answer and restart follow-up");
  uploadedReference = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const referencePath = join(directory, "reference.png"); await writeFile(referencePath, uploadedReference, { mode: 0o600 });
  const image = await call("doubao_generate_image", { prompt: "synthetic image fixture", model: "Seedream 4.0", ratio: "3:4", style: "水彩画", reference_image_paths: [referencePath] });
  assert.equal(image.error, false); assert.ok(image.text.includes('"media_status": "completed"'));
  assert.ok(image.text.includes("https://p5-flow-imagex-sign.byteimg.com/fixture.png"));
  const video = await call("doubao_generate_video", { prompt: "synthetic video fixture", duration_seconds: 4 });
  assert.equal(video.error, false); assert.ok(video.text.includes("no_media_returned"));
  const videoKey = video.text.match(/session_key: ([a-f0-9-]{36})/)?.[1]; assert.ok(videoKey);
  await client.close(); await transport.close(); await connect();
  const media = await call("doubao_media_status", { session_key: videoKey });
  assert.equal(media.error, false); assert.ok(media.text.includes("https://v11-vdl.doubao.com/fixture.mp4"));
  evidence.push("image model, ratio, style and allowed reference upload; default Fast video and read-only result lookup after restart");
  const mediaId = JSON.parse(media.text.split("\n\n---\n\n").find(part => part.trim().startsWith("{"))).media[0].media_id;
  assert.ok(mediaId);
  const download = await call("doubao_download_media", { session_key: videoKey, media_id: mediaId });
  assert.equal(download.error, true); assert.ok(download.text.includes("download_configuration_error"));
  evidence.push("download tool and stable media ID are available; missing media directory rejects before download");
  const disk = await readFile(env.WEB_AI_SESSION_STORE_PATH, "utf8");
  assert.ok(!disk.includes("first-canary") && !disk.includes("second-canary") && !disk.includes("sessionid=fixture"));
  assert.ok(!disk.includes("synthetic image fixture") && !disk.includes("fixture.mp4"));
  evidence.push("disk excludes cookies and messages");
  assert.equal((await call("doubao_chat", { message: "unknown", session_key: "00000000-0000-4000-8000-000000000000" })).error, true);
  assert.equal((await call("doubao_session_close", { session_key: key })).error, false);
  assert.equal((await call("doubao_chat", { message: "closed", session_key: key })).error, true);
  assert.equal(requests, 7);
  evidence.push("unknown and closed keys fail without upstream writes");
  console.log(JSON.stringify({ mode: "Doubao local HTTP fixture; not live website", passed: evidence }, null, 2));
} catch {
  console.error(`[doubao smoke] failed at ${stage}; sensitive details suppressed`);
  process.exitCode = 1;
} finally {
  await client?.close(); await transport?.close();
  if (website.listening) await new Promise(resolve => website.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
}
