import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { realpath, open } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import type { ProviderResult, WebAIProvider, FileInput } from "../core/provider.js";
import { ProviderError } from "../core/provider.js";
import type { SessionStore } from "../core/session-store.js";

const textResult = (text: string, error = false) => ({
  content: [{ type: "text" as const, text }],
  ...(error ? { isError: true as const } : {})
});

function redact(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  const token = process.env.DEEPSEEK_USER_TOKEN || "";
  if (token) message = message.replaceAll(token, "[REDACTED]");
  return error instanceof ProviderError ? `[${error.code}] ${message}` : message;
}

function formatAnswer(result: ProviderResult, key?: string, showReasoning = false) {
  const chunks: string[] = [];
  if (showReasoning && result.reasoning) chunks.push("## DeepSeek thinking\n\n" + result.reasoning);
  chunks.push("## DeepSeek answer\n\n" + result.content);
  if (key) chunks.push("session_key: " + key + "\nconversation_id: " + key);
  if (result.warning) chunks.push("warning: " + result.warning);
  return textResult(chunks.join("\n\n---\n\n"));
}

export function registerDeepSeekTools(
  server: McpServer, provider: WebAIProvider, sessions: SessionStore
): void {
  const sendChat = async (
    message: string,
    options: { key?: string; conversationId?: string; name?: string; makeDefault?: boolean; systemPrompt?: string; thinking: boolean; showReasoning: boolean; signal: AbortSignal }
  ) => {
    try {
      if (options.key && options.conversationId && options.key !== options.conversationId) {
        throw new Error("session_key and conversation_id must identify the same conversation");
      }
      const requestedKey = options.conversationId ?? options.key;
      if (requestedKey && options.name) throw new Error("Use conversation_id/session_key or conversation_name, not both");
      return await sessions.exclusive(requestedKey ?? options.name ?? "project-chat", async () => {
        const selected = requestedKey ?? (options.name ? undefined : sessions.defaultKey());
        const previous = selected ? sessions.require(selected, provider.id)
          : options.name ? sessions.named(options.name, provider.id) : undefined;
        const record = previous ?? sessions.put({
          providerId: provider.id, remote: {}, name: options.name,
          title: options.name ?? "Website conversation"
        });
        sessions.beginTurn(record.key);
        try {
          const result = await provider.chat({
            message, systemPrompt: options.systemPrompt, thinking: options.thinking, signal: options.signal
          }, previous?.remote);
          if (result.remoteSession) {
            sessions.update(record.key, result.remoteSession);
            if (options.makeDefault) sessions.selectDefault(record.key, provider.id);
          } else sessions.invalidate(record.key);
          return formatAnswer(result, result.remoteSession ? record.key : undefined, options.showReasoning);
        } catch (error) {
          if (error instanceof ProviderError && !error.sessionUncertain) {
            sessions.cancelTurn(record.key);
            if (!previous) sessions.delete(record.key);
            throw error;
          }
          sessions.invalidate(record.key);
          const code = error instanceof ProviderError ? error.code : "session_state_error";
          throw new ProviderError((error instanceof Error ? error.message : "Request failed") +
            "; session_key invalidated because the website may have advanced. Close this conversation explicitly before starting another.", code, true);
        }
      });
    } catch (error) {
      return textResult("[deepseek error] " + redact(error), true);
    }
  };

  server.tool(
    "deepseek_chat",
    "Chat through DeepSeek WEBSITE. Resume persisted conversation_id/session_key or conversation_name. make_default binds subsequent calls in this project.",
    {
      message: z.string().min(1),
      session_key: z.string().uuid().optional(),
      conversation_id: z.string().uuid().optional(),
      conversation_name: z.string().trim().min(1).max(80).optional(),
      make_default: z.boolean().optional(),
      system_prompt: z.string().optional(),
      thinking: z.boolean().optional(),
      show_reasoning: z.boolean().optional(),
    },
    async ({ message, session_key, conversation_id, conversation_name, make_default, system_prompt, thinking, show_reasoning }, extra) => sendChat(
      message, {
        key: session_key,
        conversationId: conversation_id,
        name: conversation_name,
        makeDefault: make_default,
        systemPrompt: system_prompt,
        thinking: thinking ?? false,
        showReasoning: show_reasoning ?? false,
        signal: extra.signal
      }
    )
  );

  server.tool(
    "deepseek_reasoner",
    "DeepSeek Web thinking; resume the same persisted conversation_id/session_key or conversation_name. Supports project default conversation.",
    {
      message: z.string().min(1),
      session_key: z.string().uuid().optional(),
      conversation_id: z.string().uuid().optional(),
      conversation_name: z.string().trim().min(1).max(80).optional(),
      make_default: z.boolean().optional(),
      system_prompt: z.string().optional(),
      show_reasoning: z.boolean().optional(),
    },
    async ({ message, session_key, conversation_id, conversation_name, make_default, system_prompt, show_reasoning }, extra) => sendChat(
      message, {
        key: session_key,
        conversationId: conversation_id,
        name: conversation_name,
        makeDefault: make_default,
        systemPrompt: system_prompt,
        thinking: true,
        showReasoning: show_reasoning ?? false,
        signal: extra.signal
      }
    )
  );

  server.tool(
    "deepseek_analyze_files",
    "Upload selected local files to DeepSeek Web. Requires explicit WEB_AI_ALLOWED_ROOTS.",
    {
      file_paths: z.array(z.string().min(1)).min(1).max(5),
      instruction: z.string().min(1).default("请分析这些文件并提供改进建议。"),
      thinking: z.boolean().optional(),
    },
    async ({ file_paths, instruction, thinking }, extra) => {
      try {
        if (!provider.analyzeFiles) throw new Error("This provider does not support file analysis");
        const allowlist = (process.env.WEB_AI_ALLOWED_ROOTS || "")
          .split(delimiter).map((p) => p.trim()).filter(Boolean);
        if (!allowlist.length) {
          throw new Error("Set WEB_AI_ALLOWED_ROOTS to enable local file analysis");
        }
        const roots = await Promise.all(allowlist.map((p) => realpath(resolve(p))));
        const files: FileInput[] = [];
        let total = 0;

        for (const path of file_paths) {
          extra.signal.throwIfAborted();
          if (!isAbsolute(path)) throw new Error("Only absolute file paths are permitted");
          const actual = await realpath(path);
          const permitted = roots.some((root) => {
            const rel = relative(root, actual);
            return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
          });
          if (!permitted) throw new Error("File outside allowed root: " + basename(actual));
          const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const fileStat = await handle.stat();
            if (!fileStat.isFile() || fileStat.size > 10 * 1024 * 1024) {
              throw new Error("Only ordinary files up to 10 MiB are permitted");
            }
            // Bound reads even if the file grows after stat; reject changed size.
            const buffer = Buffer.alloc(fileStat.size + 1);
            let length = 0;
            while (length < buffer.length) {
              extra.signal.throwIfAborted();
              const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
              if (!bytesRead) break;
              length += bytesRead;
            }
            if (length > fileStat.size) throw new Error("File grew during read; select a stable file and retry");
            total += length;
            if (total > 20 * 1024 * 1024) throw new Error("Total upload exceeds 20 MiB");
            files.push({ name: basename(actual), buffer: buffer.subarray(0, length) });
          } finally { await handle.close(); }
        }

        const result = await provider.analyzeFiles(files, instruction, thinking ?? false, extra.signal);
        const record = result.remoteSession ? sessions.put({
          providerId: provider.id, remote: result.remoteSession, title: instruction.slice(0, 80)
        }) : undefined;
        return formatAnswer(result, record?.key, false);
      } catch (error) {
        return textResult("[deepseek file error] " + redact(error), true);
      }
    }
  );

  server.tool(
    "deepseek_sessions_list",
    "List persisted local DeepSeek conversation IDs, names and state, excluding upstream IDs and credentials.",
    {},
    async () => textResult(
      JSON.stringify(sessions.list().filter((s) => s.providerId === provider.id), null, 2)
    )
  );

  server.tool(
    "deepseek_session_close",
    "Forget a local session; does NOT delete DeepSeek website history.",
    { session_key: z.string().uuid().optional(), conversation_id: z.string().uuid().optional() },
    async ({ session_key, conversation_id }) => {
      try {
        if (session_key && conversation_id && session_key !== conversation_id) throw new Error("Conflicting conversation IDs");
        const key = conversation_id ?? session_key;
        if (!key) throw new Error("Provide conversation_id or session_key");
        return textResult(sessions.delete(key)
          ? "Session forgotten locally"
          : "Session not present");
      } catch (error) {
        return textResult(redact(error), true);
      }
    }
  );
}
