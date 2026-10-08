#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProviderRegistry } from "./core/registry.js";
import { SessionStore } from "./core/session-store.js";
import { registerProviders } from "./providers/index.js";
import { registerDeepSeekTools } from "./tools/deepseek.js";

async function main(): Promise<void> {
  const registry = new ProviderRegistry();
  registerProviders(registry);
  await registry.initializeAll();

  const configuredTtl = Number(process.env.WEB_AI_SESSION_TTL_MINUTES || "30") * 60_000;
  const sessions = new SessionStore(
    Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : 30 * 60_000
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
  console.error("[web-ai-mcp] failed to start:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
