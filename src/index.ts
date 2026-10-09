#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProviderRegistry } from "./core/registry.js";
import { SessionStore, sessionTtlMs } from "./core/session-store.js";
import { resolve } from "node:path";
import { registerProviders } from "./providers/index.js";
import { registerDeepSeekTools } from "./tools/deepseek.js";

async function main(): Promise<void> {
  const registry = new ProviderRegistry();
  registerProviders(registry);
  await registry.initializeAll();

  const projectRoot = resolve(process.env.WEB_AI_PROJECT_ROOT || process.cwd());
  const sessions = new SessionStore(
    sessionTtlMs(process.env.WEB_AI_SESSION_TTL_MINUTES), Date.now,
    resolve(process.env.WEB_AI_SESSION_STORE_PATH || resolve(projectRoot, ".web-ai-mcp/sessions.json"))
  );

  const server = new McpServer({ name: "web-ai-mcp", version: "0.1.0" });
  registerDeepSeekTools(server, registry.get("deepseek"), sessions);

  server.tool(
    "webai_providers",
    "List active and planned Web AI provider slots; planned providers are not callable.",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          active: registry.list(),
          planned: [{ id: "doubao", status: "not_implemented" }]
        }, null, 2),
      }]
    })
  );

  await server.connect(new StdioServerTransport());
  console.error("[web-ai-mcp] MCP stdio server ready (DeepSeek Web provider)");
}

main().catch((error: unknown) => {
  // stdout is reserved for MCP JSON-RPC messages.
  const token = process.env.DEEPSEEK_USER_TOKEN;
  const message = error instanceof Error ? error.message : String(error);
  console.error("[web-ai-mcp] failed to start:", token ? message.replaceAll(token, "[REDACTED]") : message);
  process.exitCode = 1;
});
