import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FileInput, ProviderResult, WebAIProvider } from "../core/provider.js";
import { readAllowedFiles } from "../core/files.js";
import { ProviderError } from "../core/provider.js";
import type { SessionStore } from "../core/session-store.js";

const textResult = (text: string, error = false) => ({
  content: [{ type: "text" as const, text }],
  ...(error ? { isError: true as const } : {}),
});

const safeProviderMessages: Readonly<Record<string, string>> = {
  authentication_error: "Doubao login credentials are invalid or expired; log in through the website, update DOUBAO_COOKIE and restart.",
  access_denied: "Doubao website access denied; check access in your browser.",
  rate_limit_error: "Doubao website rate limit reached; wait before retrying.",
  captcha_required: "Doubao HTTP requested verification; the existing website tab may not display this challenge. This client has stopped sending messages. Resolve the challenge through the official website interface, refresh the complete local request configuration and restart MCP. Website chat success alone does not confirm HTTP recovery.",
  configuration_error: "Check the local Doubao website configuration.",
  http_error: "Doubao website returned an HTTP error.",
  network_error: "Doubao website transport failed; no automatic retry was performed.",
  timeout_error: "Doubao website request timed out.",
  cancelled: "Doubao website request cancelled.",
  invalid_response: "Doubao website returned an invalid response.",
  malformed_sse: "Invalid or incomplete Doubao website response.",
  stream_error: "Doubao website reported a stream error.",
  website_error: "Doubao website rejected the request; upstream details are not exposed.",
  invalid_request: "Doubao request is invalid; check the message and local parameters.",
  unsupported_capability: "The requested Doubao capability is not verified and is disabled.",
  session_state_error: "Doubao conversation state could not be confirmed.",
  file_access_error: "Check WEB_AI_ALLOWED_ROOTS, absolute file paths and upload size limits. Only ordinary TXT files are supported.",
  unsupported_file_type: "Doubao file analysis currently supports nonempty TXT files only.",
  upload_error: "Doubao file upload or commit failed; no chat was sent and no automatic retry was performed.",
  invalid_file: "Select nonempty TXT files with safe filenames, each at most 10 MiB.",
  upload_integrity_error: "Doubao storage did not confirm the file checksum; no chat was sent.",
  upload_commit_error: "Doubao did not confirm the uploaded file; no chat was sent.",
};

const safeSessionMessages = new Set([
  "session_key and conversation_id must identify the same conversation",
  "Use conversation_id/session_key or conversation_name, not both",
  "Conflicting conversation IDs",
  "Provide conversation_id or session_key",
  "Session missing or expired: start a new chat without session_key/conversation_id",
  "Session belongs to another provider",
  "Session invalidated after an interrupted or uncertain request; close it explicitly before starting another conversation",
  "Conversation name already exists",
  "Session missing",
  "Session was removed during request",
  "Session is busy; retry later",
  "Session is busy; cannot remove",
  "Project conversation store is busy; retry later",
  "Project conversation store is locked. If a previous MCP process crashed, confirm it has stopped before removing the .lock file",
]);

function redact(error: unknown): string {
  if (error instanceof ProviderError) {
    const known = Object.hasOwn(safeProviderMessages, error.code);
    const message = known
      ? `[${error.code}] ${safeProviderMessages[error.code]}`
      : "[provider_error] Doubao website request failed.";
    return message + (error.sessionUncertain
      ? " Session invalidated because the website may have advanced; close this conversation explicitly before starting another."
      : "");
  }
  if (error instanceof Error && safeSessionMessages.has(error.message)) return error.message;
  return "Doubao request failed; upstream error details are not exposed.";
}

function formatAnswer(result: ProviderResult, key?: string, showReasoning = false) {
  const chunks: string[] = [];
  if (showReasoning && result.reasoning) chunks.push("## Doubao thinking\n\n" + result.reasoning);
  chunks.push("## Doubao answer\n\n" + result.content);
  if (key) chunks.push("session_key: " + key + "\nconversation_id: " + key);
  if (result.warning) chunks.push("warning: " + result.warning);
  return textResult(chunks.join("\n\n---\n\n"));
}

function expertMode(mode?: "quick" | "expert", thinking?: boolean): boolean {
  if (mode && thinking !== undefined && (mode === "expert") !== thinking) {
    throw new ProviderError("mode and thinking must select the same mode", "invalid_request");
  }
  return mode ? mode === "expert" : thinking ?? false;
}

export function registerDoubaoTools(
  server: McpServer,
  provider: WebAIProvider,
  sessions: SessionStore
): void {
  const sendChat = async (
    message: string,
    options: {
      key?: string;
      conversationId?: string;
      name?: string;
      makeDefault?: boolean;
      systemPrompt?: string;
      thinking: boolean;
      showReasoning: boolean;
      files?: FileInput[];
      signal: AbortSignal;
    }
  ) => {
    try {
      if (options.key && options.conversationId && options.key !== options.conversationId) {
        throw new Error("session_key and conversation_id must identify the same conversation");
      }
      const requestedKey = options.conversationId ?? options.key;
      if (requestedKey && options.name) {
        throw new Error("Use conversation_id/session_key or conversation_name, not both");
      }
      return await sessions.exclusive(requestedKey ?? options.name ?? "project-chat", async () => {
        const selected = requestedKey ?? (options.name || options.files ? undefined : sessions.defaultKey(provider.id));
        const previous = selected
          ? sessions.require(selected, provider.id)
          : options.name
          ? sessions.named(options.name, provider.id)
          : undefined;
        const record =
          previous ??
          sessions.put({
            providerId: provider.id,
            remote: {},
            name: options.name,
            title: options.name ?? "Website conversation",
          });
        sessions.beginTurn(record.key);
        try {
          const result = options.files && provider.analyzeFiles
            ? await provider.analyzeFiles(options.files, message, options.thinking, options.signal)
            : await provider.chat({ message, systemPrompt: options.systemPrompt, thinking: options.thinking,
                signal: options.signal }, previous?.remote);
          if (result.remoteSession) {
            sessions.update(record.key, result.remoteSession);
            if (options.makeDefault) sessions.selectDefault(record.key, provider.id);
          } else {
            sessions.invalidate(record.key);
          }
          return formatAnswer(result, result.remoteSession ? record.key : undefined, options.showReasoning);
        } catch (error) {
          if (error instanceof ProviderError && !error.sessionUncertain) {
            sessions.cancelTurn(record.key);
            if (!previous) sessions.delete(record.key);
            throw error;
          }
          sessions.invalidate(record.key);
          const code = error instanceof ProviderError ? error.code : "session_state_error";
          throw new ProviderError("Doubao conversation state could not be confirmed", code, true);
        }
      });
    } catch (error) {
      return textResult("[doubao error] " + redact(error), true);
    }
  };

  server.registerTool(
    "doubao_chat",
    {
      description: "Chat through Doubao WEBSITE. Select persisted conversation_id/session_key or conversation_name. make_default binds subsequent calls in this project.",
      inputSchema: z.object({
        message: z.string().min(1),
        session_key: z.string().uuid().optional(),
        conversation_id: z.string().uuid().optional(),
        conversation_name: z.string().trim().min(1).max(80).optional(),
        make_default: z.boolean().optional(),
        system_prompt: z.string().optional(),
        mode: z.enum(["quick", "expert"]).optional(),
        thinking: z.boolean().optional(),
        show_reasoning: z.boolean().optional(),
      }).strict(),
    },
    async (
      {
        message,
        session_key,
        conversation_id,
        conversation_name,
        make_default,
        system_prompt,
        mode,
        thinking,
        show_reasoning,
      },
      extra
    ) => {
      try { return await sendChat(message, {
        key: session_key,
        conversationId: conversation_id,
        name: conversation_name,
        makeDefault: make_default,
        systemPrompt: system_prompt,
        thinking: expertMode(mode, thinking),
        showReasoning: show_reasoning ?? false,
        signal: extra.signal,
      }); } catch (error) { return textResult("[doubao error] " + redact(error), true); }
    }
  );

  server.registerTool("doubao_reasoner", {
    description: "Doubao Web expert mode with visible thinking. Resume the same local conversation by key or name.",
    inputSchema: z.object({ message: z.string().min(1), session_key: z.string().uuid().optional(), conversation_id: z.string().uuid().optional(),
      conversation_name: z.string().trim().min(1).max(80).optional(), make_default: z.boolean().optional(),
      system_prompt: z.string().optional(), show_reasoning: z.boolean().optional() }).strict(),
  }, async ({ message, session_key, conversation_id, conversation_name, make_default, system_prompt, show_reasoning }, extra) =>
    sendChat(message, { key: session_key, conversationId: conversation_id, name: conversation_name, makeDefault: make_default,
      systemPrompt: system_prompt, thinking: true, showReasoning: show_reasoning ?? false, signal: extra.signal }));

  server.registerTool("doubao_analyze_files", {
    description: "Create a Doubao file-analysis conversation by uploading selected TXT files. Requires WEB_AI_ALLOWED_ROOTS; resume later with the returned key.",
    inputSchema: z.object({ file_paths: z.array(z.string().min(1)).min(1).max(5),
      instruction: z.string().min(1).default("请分析这些文件并提供改进建议。"), mode: z.enum(["quick", "expert"]).optional(),
      thinking: z.boolean().optional(), show_reasoning: z.boolean().optional(), make_default: z.boolean().optional() }).strict(),
  }, async ({ file_paths, instruction, mode, thinking, show_reasoning, make_default }, extra) => {
    try {
      const expert = expertMode(mode, thinking);
      if (!provider.analyzeFiles) throw new ProviderError("File analysis unavailable", "unsupported_capability");
      let files: FileInput[];
      try { files = await readAllowedFiles(file_paths, extra.signal); }
      catch { throw new ProviderError("Local file read rejected", extra.signal.aborted ? "cancelled" : "file_access_error"); }
      return await sendChat(instruction, { files, thinking: expert, showReasoning: show_reasoning ?? false,
        makeDefault: make_default, signal: extra.signal });
    } catch (error) { return textResult("[doubao file error] " + redact(error), true); }
  });

  server.tool(
    "doubao_sessions_list",
    "List persisted local Doubao conversation IDs, names and state, excluding upstream IDs and credentials.",
    {},
    async () => {
      try {
        return textResult(
          JSON.stringify(
            sessions.list().filter((s) => s.providerId === provider.id),
            null,
            2
          )
        );
      } catch (error) {
        return textResult(redact(error), true);
      }
    }
  );

  server.tool(
    "doubao_session_close",
    "Forget a local session; does NOT delete Doubao website history.",
    { session_key: z.string().uuid().optional(), conversation_id: z.string().uuid().optional() },
    async ({ session_key, conversation_id }) => {
      try {
        if (session_key && conversation_id && session_key !== conversation_id) {
          throw new Error("Conflicting conversation IDs");
        }
        const key = conversation_id ?? session_key;
        if (!key) throw new Error("Provide conversation_id or session_key");
        return await sessions.exclusive("doubao-close:" + key, async () => {
          const record = sessions.list().find((record) => record.key === key);
          if (record && record.providerId !== provider.id) throw new Error("Session belongs to another provider");
          // Expired records are hidden by list(); delete checks ownership atomically, including those records.
          if (!sessions.delete(key, provider.id)) {
            throw new Error("Session missing or expired: start a new chat without session_key/conversation_id");
          }
          return textResult("Session forgotten locally");
        });
      } catch (error) {
        return textResult(redact(error), true);
      }
    }
  );
}
