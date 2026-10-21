import type { ProviderRegistry } from "../core/registry.js";
import { DeepSeekWebProvider } from "./deepseek/index.js";
import { DoubaoWebProvider } from "./doubao/index.js";
import { GeminiWebProvider } from "./gemini/index.js";
import { GeminiWebClient } from "./gemini/web-client.js";
import { loadGeminiAccounts } from "./gemini/accounts.js";
import { GeminiAccountProvider, GeminiCooldownStore } from "./gemini/cooldown.js";
import { dirname, resolve } from "node:path";
import { ProviderError } from "../core/provider.js";
import { GeminiBrowserChatClient } from "./gemini/browser-chat.js";

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
    const accountsFile = process.env.GEMINI_ACCOUNTS_FILE;
    registry.register(new GeminiAccountProvider(geminiAccounts,
      account => new GeminiWebProvider(account.cookie, account.browserChatSpaceId
        ? new GeminiBrowserChatClient(account.cookie, { spaceId: account.browserChatSpaceId, email: account.id }, { userAgent: account.userAgent })
        : new GeminiWebClient(account.cookie, { userAgent: account.userAgent, accountId: account.id })),
      new GeminiCooldownStore(process.env.GEMINI_COOLDOWN_STORE_PATH || resolve(dirname(store), "gemini-cooldowns.json")), undefined,
      accountsFile ? async id => {
        const current = await loadGeminiAccounts({ GEMINI_ACCOUNTS_FILE: accountsFile });
        if (current.length !== geminiAccounts.length || current.some((account, index) => account.id !== geminiAccounts[index].id)) {
          throw new ProviderError("Gemini account IDs or order changed; reconnect MCP to apply the new account list", "configuration_error");
        }
        return current.find(account => account.id === id)!;
      } : undefined));
  }
}
