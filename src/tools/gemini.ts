import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProviderError, type ProviderResult, type WebAIProvider } from "../core/provider.js";
import type { SessionStore } from "../core/session-store.js";
import type { JobManager } from "../core/jobs.js";
import { CHAT_DESCRIPTION, chatFields, dispatchChat, failureDetails } from "./guidance.js";

const textResult = (text: string, error = false) => ({
  content: [{ type: "text" as const, text }],
  ...(error ? { isError: true as const } : {}),
});

const providerMessages: Readonly<Record<string, string>> = {
  configuration_error: "Check GEMINI_COOKIE, GEMINI_USER_AGENT and GEMINI_TIMEOUT in the local MCP configuration.",
  authentication_error: "Gemini login is missing, expired or belongs to another account. Update your own website Cookie and restart MCP; never share cookies or reuse another account's session store.",
  access_denied: "Gemini website denied access; check your account through the official website.",
  captcha_required: "Gemini requires website verification. This client has stopped website writes; resolve verification manually and restart MCP.",
  rate_limit_error: "Gemini website quota or rate limit reached; stop and wait. Do not switch accounts or modes automatically.",
  timeout_error: "Gemini website operation timed out; do not automatically resend the message.",
  cancelled: "Gemini website operation cancelled; an accepted message cannot be withdrawn.",
  network_error: "Gemini website transport failed; no automatic retry was performed.",
  http_error: "Gemini website returned an HTTP error; no automatic retry was performed.",
  invalid_request: "Invalid Gemini chat request. Only the website default model is supported; thinking, search, files and media are not enabled.",
  unsupported_capability: "This Gemini capability is not verified and is disabled.",
  invalid_session: "Gemini website conversation state was not confirmed. Stop and check the website; do not create a replacement automatically.",
  session_state_error: "Gemini website conversation lineage was not confirmed.",
  invalid_response: "Gemini website returned an invalid or incomplete response.",
  malformed_sse: "Gemini website returned malformed or truncated stream frames.",
  stream_error: "Gemini website reported a stream error.",
  website_error: "Gemini website rejected the request; upstream details are not exposed.",
};
const sessionMessages = new Set([
  "session_key and conversation_id must identify the same conversation",
  "Use conversation_id/session_key or conversation_name, not both",
  "Conflicting conversation IDs", "Provide conversation_id or session_key",
  "Session missing or expired: start a new chat without session_key/conversation_id",
  "Session belongs to another provider",
  "Session invalidated after an interrupted or uncertain request; close it explicitly before starting another conversation",
  "Conversation name already exists", "Session missing", "Session was removed during request",
  "Session is busy; retry later", "Session is busy; cannot remove",
  "Project conversation store is busy; retry later",
  "Project conversation store is locked. If a previous MCP process crashed, confirm it has stopped before removing the .lock file",
]);
function redact(error: unknown): string {
  if (error instanceof ProviderError) {
    const known = Object.hasOwn(providerMessages, error.code);
    return (known ? `[${error.code}] ${providerMessages[error.code]}` : "[provider_error] Gemini website request failed.") +
      (error.sessionUncertain ? " Session invalidated because the website may have advanced; close it explicitly before starting another conversation." : "");
  }
  return error instanceof Error && sessionMessages.has(error.message) ? error.message : "Gemini operation failed; private details are not exposed.";
}
function answer(result: ProviderResult, key?: string) {
  const chunks = ["## Gemini answer\n\n" + result.content];
  if (key) chunks.push("session_key: " + key + "\nconversation_id: " + key);
  if (result.warning) chunks.push("warning: " + result.warning);
  return textResult(chunks.join("\n\n---\n\n"));
}

export function registerGeminiTools(
  server: McpServer, provider: WebAIProvider, sessions: SessionStore, jobs?: JobManager
): void {
  const { show_reasoning: _showReasoning, ...fields } = chatFields;
  server.registerTool("gemini_chat", {
    description: "Chat through your own Gemini WEBSITE using its default model (experimental HTTP). No model selection, thinking toggle, search, files or media. system_prompt is a plain text prefix, not a website system role." + CHAT_DESCRIPTION,
    inputSchema: z.object({ ...fields }).strict(),
  }, async (args, extra) => dispatchChat(args, extra, jobs, "gemini_chat", async signal => {
    try {
      const requestedKey = args.conversation_id ?? args.session_key;
      return await sessions.exclusive(requestedKey ?? args.conversation_name ?? "project-chat", async () => {
        const selected = requestedKey ?? (args.conversation_name ? undefined : sessions.defaultKey(provider.id));
        const previous = selected ? sessions.require(selected, provider.id)
          : args.conversation_name ? sessions.named(args.conversation_name, provider.id) : undefined;
        const record = previous ?? sessions.put({
          providerId: provider.id, remote: {}, name: args.conversation_name,
          title: args.conversation_name ?? "Website conversation",
        });
        sessions.beginTurn(record.key);
        try {
          const result = await provider.chat({ message: args.message, systemPrompt: args.system_prompt, thinking: false, signal }, previous?.remote);
          if (result.remoteSession) {
            sessions.update(record.key, result.remoteSession);
            if (args.make_default) sessions.selectDefault(record.key, provider.id);
          } else sessions.invalidate(record.key);
          return answer(result, result.remoteSession ? record.key : undefined);
        } catch (error) {
          if (error instanceof ProviderError && !error.sessionUncertain) {
            sessions.cancelTurn(record.key);
            if (!previous) sessions.delete(record.key);
            throw error;
          }
          sessions.invalidate(record.key);
          throw new ProviderError("Gemini conversation state is uncertain", error instanceof ProviderError ? error.code : "session_state_error", true);
        }
      });
    } catch (error) {
      return textResult("[gemini error] " + redact(error) + "\n" + failureDetails(error), true);
    }
  }));

  server.registerTool("gemini_sessions_list", {
    description: "List persisted local Gemini conversations and states; excludes website IDs and credentials.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try { return textResult(JSON.stringify(sessions.list().filter(s => s.providerId === provider.id), null, 2)); }
    catch (error) { return textResult(redact(error), true); }
  });
  server.registerTool("gemini_session_close", {
    description: "Forget a local Gemini conversation. Does not delete website history or cancel accepted work.",
    inputSchema: z.object({ session_key: z.string().uuid().optional(), conversation_id: z.string().uuid().optional() }).strict(),
  }, async ({ session_key, conversation_id }) => {
    try {
      if (session_key && conversation_id && session_key !== conversation_id) throw new Error("Conflicting conversation IDs");
      const key = conversation_id ?? session_key;
      if (!key) throw new Error("Provide conversation_id or session_key");
      return textResult(sessions.delete(key, provider.id) ? "Session forgotten locally" : "Session not present");
    } catch (error) { return textResult(redact(error), true); }
  });
}
