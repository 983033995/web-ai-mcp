import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let stage = "configuration";
let directory: string | undefined;
let complete = false;
let client: Client | undefined;
let transport: StdioClientTransport | undefined;
const flatten = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as Array<{ type: string; text?: string }>).filter(i => i.type === "text").map(i => i.text ?? "").join("\n");

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { live: { type: "boolean" }, "env-file": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("tsx scripts/probe-gemini.ts --env-file /private/path/.env --live\nRequires npm run build. Sends three ordinary fictional-story messages through actual MCP stdio: background first reply, follow-up and follow-up after restart. No technical markers in website messages. No retries; failures retain a private local journal. Never prints cookies, remote IDs or replies.");
    return;
  }
  if (!values.live) throw new Error("live_opt_in_required");
  if (values["env-file"]) process.loadEnvFile(resolve(values["env-file"]));
  if (!process.env.GEMINI_COOKIE || !process.env.GEMINI_USER_AGENT) throw new Error("configuration_error");
  directory = await mkdtemp(resolve(".validation-gemini-live-")); await chmod(directory, 0o700);
  const env: Record<string, string> = {
    DEEPSEEK_USER_TOKEN: "", DOUBAO_COOKIE: "", GEMINI_COOKIE: process.env.GEMINI_COOKIE,
    GEMINI_USER_AGENT: process.env.GEMINI_USER_AGENT, GEMINI_TIMEOUT: process.env.GEMINI_TIMEOUT || "180000",
    WEB_AI_SESSION_STORE_PATH: join(directory, "sessions.json"), WEB_AI_SESSION_TTL_MINUTES: "0",
  };
  for (const name of ["NODE_USE_ENV_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_OPTIONS"]) {
    if (process.env[name]) env[name] = process.env[name]!;
  }
  const connect = async () => {
    client = new Client({ name: "gemini-live", version: "0" });
    transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/index.js")], env, stderr: "pipe" });
    transport.stderr?.on("data", () => {});
    await client.connect(transport);
  };
  const call = (name: string, args: Record<string, unknown>) => client!.callTool({ name, arguments: args }, undefined, { timeout: 210_000 });
  const checked = (result: Awaited<ReturnType<Client["callTool"]>>) => {
    if (result.isError) {
      const code = flatten(result).match(/\[(authentication_error|captcha_required|rate_limit_error|timeout_error|network_error|invalid_response|malformed_sse|session_state_error|invalid_session|access_denied|website_error)\]/)?.[1];
      throw new Error(code ?? "live_validation_failed");
    }
    return flatten(result);
  };
  const key = (text: string) => {
    const value = text.match(/session_key: ([a-f0-9-]{36})/)?.[1];
    if (!value) throw new Error("missing_resumable_lineage");
    return value;
  };
  const journal = join(directory, "probe.json");
  try {
    stage = "tool discovery"; await connect();
    const names = (await client!.listTools()).tools.map(t => t.name);
    if (names.length !== 14 || !["gemini_chat", "gemini_sessions_list", "gemini_session_close", "webai_job_status", "gemini_accounts"].every(n => names.includes(n))) throw new Error("tool_discovery_failed");
    stage = "background first reply";
    await writeFile(journal, JSON.stringify({ stage, status: "pending", replay: false }), { mode: 0o600 });
    const requestId = randomUUID();
    const submitted = await call("gemini_chat", { message: "一起写个小故事：江禾把一个黄色帆布袋落在了望海花店。请用一句话作为开头。", conversation_name: "story", background: true, request_id: requestId });
    const metadata = submitted._meta?.web_ai_job as { job_id?: string; status?: string } | undefined;
    if (submitted.isError || !metadata?.job_id) { checked(submitted); throw new Error("missing_job_id"); }
    const deadline = Date.now() + 200_000;
    let first: string | undefined;
    while (Date.now() < deadline) {
      const result = await call("webai_job_status", { job_id: metadata.job_id });
      const job = result._meta?.web_ai_job as { status?: string; poll_after_seconds?: number } | undefined;
      if (job?.status === "completed") { first = checked(result); break; }
      if (result.isError || job?.status !== "running") { checked(result); throw new Error("background_failed"); }
      await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(30, job.poll_after_seconds ?? 10)) * 1000));
    }
    if (!first) throw new Error("background_deadline");
    const conversationKey = key(first);
    console.log(JSON.stringify({ stage, passed: true }));
    stage = "same conversation follow-up";
    await writeFile(journal, JSON.stringify({ stage, status: "pending", replay: false }), { mode: 0o600 });
    const second = checked(await call("gemini_chat", { message: "故事里，江禾落下了什么物品、是什么颜色、留在哪里？只用一句话回答。", session_key: conversationKey }));
    if (key(second) !== conversationKey || !["黄色", "帆布袋", "望海"].every(s => second.includes(s))) throw new Error("context_not_preserved");
    console.log(JSON.stringify({ stage, passed: true }));
    await client!.close(); await transport!.close();
    stage = "restart follow-up"; await connect();
    await writeFile(journal, JSON.stringify({ stage, status: "pending", replay: false }), { mode: 0o600 });
    const third = checked(await call("gemini_chat", { message: "请用“人物，物品，地点”的格式概括刚才的故事，保留物品颜色。", conversation_id: conversationKey }));
    if (key(third) !== conversationKey || !["江禾", "黄色", "帆布袋", "望海"].every(s => third.includes(s))) throw new Error("restart_context_not_preserved");
    const disk = await readFile(env.WEB_AI_SESSION_STORE_PATH, "utf8");
    for (const secret of [env.GEMINI_COOKIE, "黄色", "望海", "SNlM0e", "__Secure-1PSID"]) if (disk.includes(secret)) throw new Error("private_store_violation");
    stage = "unknown key rejection";
    if (!(await call("gemini_chat", { message: "继续刚才的故事。", session_key: randomUUID() })).isError) throw new Error("unknown_key_not_rejected");
    await writeFile(journal, JSON.stringify({ status: "completed", messages: 3, background: true, restart: true, replay: false }), { mode: 0o600 });
    complete = true;
    console.log(JSON.stringify({ mode: "actual Gemini MCP stdio", passed: ["Gemini-only fourteen tools (media not exercised)", "background chat and read-only status", "same-conversation recall", "restart recall", "secret-free lineage storage", "unknown key rejected"], messageCount: 3, model: "website default" }));
  } finally {
    await client?.close(); await transport?.close();
    if (complete) await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => {
  const known = ["live_opt_in_required", "configuration_error", "authentication_error", "captcha_required", "rate_limit_error", "timeout_error", "network_error", "invalid_response", "malformed_sse", "session_state_error", "invalid_session", "access_denied", "website_error", "context_not_preserved", "restart_context_not_preserved", "missing_resumable_lineage"];
  console.error(JSON.stringify({ mode: "actual Gemini MCP stdio", stage, passed: false, code: error instanceof Error && known.includes(error.message) ? error.message : "live_validation_failed", automaticRetry: false, journalRetained: Boolean(directory) }));
  process.exitCode = 1;
});
