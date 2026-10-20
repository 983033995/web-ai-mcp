#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProviderRegistry } from "./core/registry.js";
import { SessionStore, sessionTtlMs } from "./core/session-store.js";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadPowWasm } from "./providers/deepseek/wasm.js";
import { registerProviders } from "./providers/index.js";
import { registerDeepSeekTools } from "./tools/deepseek.js";
import { registerDoubaoTools } from "./tools/doubao.js";
import { registerGeminiTools } from "./tools/gemini.js";
import { JobManager } from "./core/jobs.js";
import { registerCommonTools } from "./tools/common.js";
import { USAGE } from "./tools/guidance.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
    setup: { type: "boolean" }, "env-file": { type: "string" }
  } });
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  if (values.help) {
    console.log("web-ai-mcp [--env-file /absolute/path/.env] [--setup] [--version]\n\nNo options: start the local stdio MCP server. Configure DEEPSEEK_USER_TOKEN, experimental DOUBAO_COOKIE + DOUBAO_CHAT_URL + DOUBAO_USER_AGENT, or Gemini GEMINI_COOKIE + GEMINI_USER_AGENT / private GEMINI_ACCOUNTS_FILE.\n--setup: download and verify pinned PoW WASM in local cache; no website credentials required.\n--env-file: load local configuration (existing environment variables take precedence).\nDeepSeek startup downloads WASM if no local file/cache exists; see THIRD_PARTY_NOTICES.md.");
    return;
  }
  if (values.version) { console.log(version); return; }
  if (values["env-file"]) process.loadEnvFile(resolve(values["env-file"]));
  if (values.setup) {
    await loadPowWasm();
    console.error("[web-ai-mcp] Pinned PoW WASM is ready.");
    return;
  }
  const registry = new ProviderRegistry();
  await registerProviders(registry);
  await registry.initializeAll();

  const projectRoot = resolve(process.env.WEB_AI_PROJECT_ROOT || process.cwd());
  const sessions = new SessionStore(
    sessionTtlMs(process.env.WEB_AI_SESSION_TTL_MINUTES), Date.now,
    resolve(process.env.WEB_AI_SESSION_STORE_PATH || resolve(projectRoot, ".web-ai-mcp/sessions.json"))
  );

  const server = new McpServer({ name: "web-ai-mcp", version }, { instructions: USAGE });
  const jobs = new JobManager();
  registerCommonTools(server, jobs);
  if (registry.has("deepseek")) {
    registerDeepSeekTools(server, registry.get("deepseek"), sessions, jobs);
  }
  if (registry.has("doubao")) {
    registerDoubaoTools(server, registry.get("doubao"), sessions, jobs);
  }
  if (registry.has("gemini")) {
    registerGeminiTools(server, registry.get("gemini"), sessions, jobs);
  }

  server.tool(
    "webai_providers",
    "List active Web AI providers. Read webai_usage before first website call. Long reasoning: background=true with UUID request_id, then poll webai_job_status; never resubmit after timeout.",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          active: registry.list(),
          planned: ["doubao", "gemini"].filter(id => !registry.has(id))
            .map(id => ({ id, status: "not_configured", experimental: true }))
        }, null, 2),
      }]
    })
  );

  await server.connect(new StdioServerTransport());
  console.error("[web-ai-mcp] MCP stdio server ready (" + registry.list().map(p => p.id).join(", ") + ")");
}

main().catch((error: unknown) => {
  // stdout is reserved for MCP JSON-RPC messages.
  let message = error instanceof Error ? error.message : "Startup failed";
  for (const secret of [process.env.DEEPSEEK_USER_TOKEN, process.env.DOUBAO_COOKIE, process.env.DOUBAO_CHAT_URL, process.env.GEMINI_COOKIE]) {
    if (secret) message = message.replaceAll(secret, "[REDACTED]");
  }
  console.error("[web-ai-mcp] failed to start:", message);
  process.exitCode = 1;
});
