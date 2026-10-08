import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { realpath, readFile, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import type { ProviderResult, WebAIProvider, FileInput } from "../core/provider.js";
import type { SessionStore } from "../core/session-store.js";

const textResult = (text: string, error = false) => ({
  content: [{ type: "text" as const, text }],
  ...(error ? { isError: true as const } : {})
});

function redact(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  const token = process.env.DEEPSEEK_USER_TOKEN || "";
  if (token) message = message.replaceAll(token, "[REDACTED]");
  return message;
}

function formatAnswer(result: ProviderResult, key?: string, showReasoning = false) {
  const chunks: string[] = [];
  if (showReasoning && result.reasoning) chunks.push("## DeepSeek thinking\n\n" + result.reasoning);
  chunks.push("## DeepSeek answer\n\n" + result.content);
  if (key) chunks.push("session_key: " + key);
  return textResult(chunks.join("\n\n---\n\n"));
}

export function registerDeepSeekTools(
  server: McpServer, provider: WebAIProvider, sessions: SessionStore
): void {
  const sendChat = async (
    message: string,
    options: { key?: string; systemPrompt?: string; thinking: boolean; showReasoning: boolean }
  ) => {
    try {
      if (options.key) {
        return await sessions.exclusive(options.key, async () => {
          const record = sessions.require(options.key!, provider.id);
          const result = await provider.chat({
            message, systemPrompt: options.systemPrompt, thinking: options.thinking
          }, record.remote);
          if (!result.remoteSession) throw new Error("No resumable session state returned");
          sessions.update(record.key, result.remoteSession);
          return formatAnswer(result, record.key, options.showReasoning);
        });
      }

      const result = await provider.chat({
        message, systemPrompt: options.systemPrompt, thinking: options.thinking
      });
      const record = result.remoteSession
        ? sessions.put({
            providerId: provider.id,
            remote: result.remoteSession,
            title: message.slice(0, 80)
          })
        : undefined;
      return formatAnswer(result, record?.key, options.showReasoning);
    } catch (error) {
      return textResult("[deepseek error] " + redact(error), true);
    }
  };

  server.tool(
    "deepseek_chat",
    "Chat through your own DeepSeek WEBSITE account; continue with session_key. Not the official API.",
    {
      message: z.string().min(1),
      session_key: z.string().uuid().optional(),
      system_prompt: z.string().optional(),
      thinking: z.boolean().optional(),
      show_reasoning: z.boolean().optional(),
    },
    async ({ message, session_key, system_prompt, thinking, show_reasoning }) => sendChat(
      message, {
        key: session_key,
        systemPrompt: system_prompt,
        thinking: thinking ?? false,
        showReasoning: show_reasoning ?? false
      }
    )
  );

  server.tool(
    "deepseek_reasoner",
    "DeepSeek Web deep-thinking consultation; supports session_key continuity.",
    {
      message: z.string().min(1),
      session_key: z.string().uuid().optional(),
      system_prompt: z.string().optional(),
      show_reasoning: z.boolean().optional(),
    },
    async ({ message, session_key, system_prompt, show_reasoning }) => sendChat(
      message, {
        key: session_key,
        systemPrompt: system_prompt,
        thinking: true,
        showReasoning: show_reasoning ?? false
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
    async ({ file_paths, instruction, thinking }) => {
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
          if (!isAbsolute(path)) throw new Error("Only absolute file paths are permitted");
          const actual = await realpath(path);
          const permitted = roots.some((root) => {
            const rel = relative(root, actual);
            return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
          });
          if (!permitted) throw new Error("File outside allowed root: " + basename(actual));
          const fileStat = await stat(actual);
          if (!fileStat.isFile() || fileStat.size > 10 * 1024 * 1024) {
            throw new Error("Only ordinary files up to 10 MiB are permitted");
          }
          total += fileStat.size;
          if (total > 20 * 1024 * 1024) throw new Error("Total upload exceeds 20 MiB");
          files.push({ name: basename(actual), buffer: await readFile(actual) });
        }

        const result = await provider.analyzeFiles(files, instruction, thinking ?? false);
        return formatAnswer(result, undefined, false);
      } catch (error) {
        return textResult("[deepseek file error] " + redact(error), true);
      }
    }
  );

  server.tool(
    "deepseek_sessions_list",
    "List local DeepSeek session keys, excluding remote IDs and credentials.",
    {},
    async () => textResult(
      JSON.stringify(sessions.list().filter((s) => s.providerId === provider.id), null, 2)
    )
  );

  server.tool(
    "deepseek_session_close",
    "Forget a local session; does NOT delete DeepSeek website history.",
    { session_key: z.string().uuid() },
    async ({ session_key }) => {
      try {
        return textResult(sessions.delete(session_key)
          ? "Session forgotten locally"
          : "Session not present");
      } catch (error) {
        return textResult(redact(error), true);
      }
    }
  );
}
