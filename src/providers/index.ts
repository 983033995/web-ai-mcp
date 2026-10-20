import type { ProviderRegistry } from "../core/registry.js";
import { DeepSeekWebProvider } from "./deepseek/index.js";
import { DoubaoWebProvider } from "./doubao/index.js";
import { GeminiWebProvider } from "./gemini/index.js";
import { GeminiWebClient } from "./gemini/web-client.js";
import { loadGeminiAccounts } from "./gemini/accounts.js";
import { GeminiAccountProvider, GeminiCooldownStore } from "./gemini/cooldown.js";
import { dirname, resolve } from "node:path";

/** Composition root. Add future providers explicitly; do not register placeholders. */
export async function registerProviders(registry: ProviderRegistry): Promise<void> {
  const deepseekToken = process.env.DEEPSEEK_USER_TOKEN || "";
  const doubaoCookie = process.env.DOUBAO_COOKIE || "";
  const geminiAccounts = await loadGeminiAccounts();

  if (deepseekToken || (!doubaoCookie && !geminiAccounts.length)) {
    registry.register(new DeepSeekWebProvider(deepseekToken));
  }

  if (doubaoCookie) {
    registry.register(new DoubaoWebProvider(doubaoCookie));
  }
  if (geminiAccounts.length) {
    const projectRoot = resolve(process.env.WEB_AI_PROJECT_ROOT || process.cwd());
    const store = resolve(process.env.WEB_AI_SESSION_STORE_PATH || resolve(projectRoot, ".web-ai-mcp/sessions.json"));
    registry.register(new GeminiAccountProvider(geminiAccounts,
      account => new GeminiWebProvider(account.cookie, new GeminiWebClient(account.cookie, { userAgent: account.userAgent })),
      new GeminiCooldownStore(process.env.GEMINI_COOLDOWN_STORE_PATH || resolve(dirname(store), "gemini-cooldowns.json"))));
  }
}
