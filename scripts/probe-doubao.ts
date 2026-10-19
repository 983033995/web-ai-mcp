import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DoubaoWebProvider } from "../src/providers/doubao/index.js";
import { ProviderError } from "../src/core/provider.js";

let probeMode = "live product HTTP Provider";
let probeStage = "configuration";

async function featureProbe(): Promise<void> {
  const directory = await mkdtemp(resolve(".validation-doubao-features-"));
  await chmod(directory, 0o700);
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  const env = { DEEPSEEK_USER_TOKEN: "", DOUBAO_COOKIE: process.env.DOUBAO_COOKIE || "",
    DOUBAO_CHAT_URL: process.env.DOUBAO_CHAT_URL || "", DOUBAO_USER_AGENT: process.env.DOUBAO_USER_AGENT || "",
    DOUBAO_TIMEOUT: process.env.DOUBAO_TIMEOUT || "120000", WEB_AI_ALLOWED_ROOTS: directory,
    WEB_AI_SESSION_STORE_PATH: join(directory, "sessions.json"), WEB_AI_SESSION_TTL_MINUTES: "0" };
  const connect = async () => {
    client = new Client({ name: "doubao-live-features", version: "0" });
    transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/index.js")], env, stderr: "pipe" });
    transport.stderr?.on("data", () => {});
    await client.connect(transport);
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    probeStage = name;
    const response = await client!.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    const text = (response.content as Array<{ type: string; text?: string }>).filter(item => item.type === "text").map(item => item.text).join("\n");
    if (response.isError) {
      const code = text.match(/\[(captcha_required|authentication_error|rate_limit_error|upload_error|upload_integrity_error|upload_commit_error|file_access_error|invalid_file|invalid_response|website_error|access_denied|malformed_sse|timeout_error|network_error)\]/)?.[1] || "live_validation_failed";
      throw new ProviderError("Live MCP feature call failed; sensitive details suppressed", code);
    }
    return text;
  };
  const key = (text: string) => {
    const value = text.match(/session_key: ([a-f0-9-]{36})/)?.[1];
    if (!value) throw new ProviderError("Missing complete resumable lineage", "live_validation_failed");
    return value;
  };
  try {
    await connect();
    const tools = (await client!.listTools()).tools.map(tool => tool.name);
    if (tools.length !== 9 || !["doubao_chat", "doubao_reasoner", "doubao_analyze_files", "doubao_generate_image", "doubao_generate_video", "doubao_media_status"].every(name => tools.includes(name))) throw new ProviderError("Missing feature tools", "live_validation_failed");
    const marker = "expert-" + randomUUID();
    const expert = await call("doubao_reasoner", { message: `计算 9240 的正因数个数，给出公式，最后写 RESULT=正确数字。记住标记 ${marker} 供下一轮回忆。不要联网。`, show_reasoning: true });
    const answer = expert.split("## Doubao answer")[1] || "";
    if (!/RESULT\s*=\s*64/.test(answer) || !expert.includes("## Doubao thinking")) throw new ProviderError("Expert answer or separated reasoning missing", "live_validation_failed");
    const expertKey = key(expert);
    console.log(JSON.stringify({ stage: "expert answer and separate thinking", passed: true }));
    const recalled = await call("doubao_chat", { message: "上一条要求记住的完整标记是什么？只回复标记。", session_key: expertKey, mode: "quick" });
    if (!recalled.includes(marker) || key(recalled) !== expertKey) throw new ProviderError("Expert conversation did not preserve context", "live_validation_failed");
    console.log(JSON.stringify({ stage: "expert-to-quick context", passed: true }));
    const fileMarker = "file-" + randomUUID();
    const path = join(directory, "fixture.txt");
    await writeFile(path, `Non-sensitive synthetic fixture\nMarker: ${fileMarker}\nA: 17\nB: 29\nC: 43\n`, { mode: 0o600 });
    const fileAnswer = await call("doubao_analyze_files", { file_paths: [path], instruction: "读出文件内完整 Marker 并计算 A、B、C 合计。只输出 Marker 和合计。", mode: "quick" });
    const fileKey = key(fileAnswer);
    if (!fileAnswer.includes(fileMarker) || !/\b89\b/.test(fileAnswer)) throw new ProviderError("Uploaded file was not correctly read", "live_validation_failed");
    console.log(JSON.stringify({ stage: "Node TXT upload and file readback", passed: true }));
    await client!.close(); await transport!.close();
    await connect();
    const followup = await call("doubao_chat", { message: "刚才文件中的完整 Marker 和三项合计是什么？只回复这两项。", session_key: fileKey });
    if (!followup.includes(fileMarker) || !/\b89\b/.test(followup) || key(followup) !== fileKey) throw new ProviderError("File context did not survive MCP restart", "live_validation_failed");
    const disk = await readFile(env.WEB_AI_SESSION_STORE_PATH, "utf8");
    if (disk.includes(marker) || disk.includes(fileMarker) || disk.includes(env.DOUBAO_COOKIE)) throw new ProviderError("Private store contains message or credential data", "live_validation_failed");
    console.log(JSON.stringify({ mode: "live product MCP stdio", passed: ["nine Doubao tools discovered (generation not exercised)", "expert answer and separate thinking", "expert-to-quick context", "Node TXT upload and file readback", "file follow-up after MCP restart", "store excludes messages and credentials"] }));
  } finally {
    await client?.close(); await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    live: { type: "boolean" }, features: { type: "boolean" }, "env-file": { type: "string" }, help: { type: "boolean" }
  } });
  if (values.help) {
    console.log("tsx scripts/probe-doubao.ts --env-file /private/path/.env --live [--features]\nDefault: two product HTTP messages. --features: four actual MCP stdio messages for expert thinking, TXT upload and restart recall; run npm run build first. Never prints credentials, signed URLs, remote IDs or answers.");
    return;
  }
  if (!values.live) throw new ProviderError("Pass --live to authorize two website test messages", "live_opt_in_required");
  if (values["env-file"]) process.loadEnvFile(resolve(values["env-file"]));
  if (values.features) { probeMode = "live product MCP stdio"; await featureProbe(); return; }
  const provider = new DoubaoWebProvider(process.env.DOUBAO_COOKIE || "");
  await provider.initialize();
  const marker = "probe-" + randomUUID();
  const first = await provider.chat({ message: `记住测试标记 ${marker}。仅回复 OK。`, thinking: false });
  if (!first.content.trim() || !first.remoteSession) throw new ProviderError("First reply missing complete resumable lineage", "live_validation_failed");
  const second = await provider.chat({ message: "上一条的测试标记是什么？只回复完整标记。", thinking: false }, first.remoteSession);
  if (!second.content.includes(marker) || second.remoteSession?.conversationId !== first.remoteSession.conversationId) {
    throw new ProviderError("Same-session follow-up did not preserve context", "live_validation_failed", true);
  }
  console.log(JSON.stringify({ mode: "live product HTTP Provider", passed: ["complete first reply", "resumable reply lineage", "same-conversation marker recall"], thinkingTested: false }));
}

main().catch(error => {
  const code = error instanceof ProviderError ? error.code : "probe_failed";
  console.error(JSON.stringify({ mode: probeMode, stage: probeStage, passed: false, code, sensitiveDetailsSuppressed: true }));
  process.exitCode = 1;
});
