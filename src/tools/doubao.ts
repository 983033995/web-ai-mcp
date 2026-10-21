import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FileInput, MediaGenerationRequest, ProviderResult, WebAIProvider } from "../core/provider.js";
import { downloadMediaFile, validateMediaDirectory } from "../providers/doubao/download.js";
import { readAllowedFiles } from "../core/files.js";
import { ProviderError } from "../core/provider.js";
import type { SessionStore } from "../core/session-store.js";
import type { JobManager } from "../core/jobs.js";
import { CHAT_DESCRIPTION, chatFields, dispatchChat, failureDetails } from "./guidance.js";
import { DOUBAO_IMAGE_MODELS, DOUBAO_VIDEO_MODELS, DOUBAO_IMAGE_RATIOS, DOUBAO_VIDEO_RATIOS, DOUBAO_IMAGE_STYLES } from "../providers/doubao/media.js";
import { doubaoDefaults } from "./defaults.js";

const textResult = (text: string, error = false) => ({
  content: [{ type: "text" as const, text }],
  ...(error ? { isError: true as const } : {}),
});

const safeProviderMessages: Readonly<Record<string, string>> = {
  download_configuration_error: "Set WEB_AI_MEDIA_DIR to an existing absolute directory without symbolic links; downloads never use WEB_AI_ALLOWED_ROOTS.",
  download_error: "Media download failed; no complete file was saved. Retry doubao_download_media, never generation.",
  media_not_ready: "The selected media has not completed or no longer appears in the latest 20 messages. Query doubao_media_status and use its media_id.",
  watermark_unavailable: "The website did not authorize the requested image download without watermark; check official account permissions. No fallback was downloaded.",
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
  invalid_reference_image: "Select PNG, JPEG or WebP reference images with matching file contents, at most 10 MiB each and 20 MiB total.",
  reference_image_access_error: "Check WEB_AI_ALLOWED_ROOTS and absolute reference image paths. Only ordinary PNG, JPEG and WebP files are supported.",
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

function formatAnswer(result: ProviderResult, key?: string, showReasoning = false, generation = false) {
  const chunks: string[] = [];
  if (showReasoning && result.reasoning) chunks.push("## Doubao thinking\n\n" + result.reasoning);
  chunks.push("## Doubao answer\n\n" + result.content);
  if (result.media?.length || generation) {
    const media = result.media ?? [];
    const status = !media.length ? "no_media_returned" : media.every(item => item.status === "completed") ? "completed" : "incomplete";
    chunks.push(JSON.stringify({ media_status: status, media: media.map(({ resourceId: _resourceId, id: media_id, ...item }) => ({ media_id, ...item })) }, null, 2));
    if (media.some(item => item.status === "completed")) chunks.push("To save a file, call doubao_download_media with session_key and media_id. Requires WEB_AI_MEDIA_DIR; without_watermark=true supports images only. Never regenerate to retry a download.");
    if (!media.length) chunks.push("No generated media was returned. Read the website reply for confirmation or clarification; query doubao_media_status later for asynchronous results. Do not resubmit automatically.");
  }
  if (key) chunks.push("session_key: " + key + "\nconversation_id: " + key);
  if (result.warning) chunks.push("warning: " + result.warning);
  return textResult(chunks.join("\n\n---\n\n"));
}

function expertMode(mode: "quick" | "expert" | undefined, thinking: boolean | undefined, fallback: "quick" | "expert"): boolean {
  if (mode && thinking !== undefined && (mode === "expert") !== thinking) {
    throw new ProviderError("mode and thinking must select the same mode", "invalid_request");
  }
  return mode ? mode === "expert" : thinking ?? fallback === "expert";
}

export function registerDoubaoTools(
  server: McpServer,
  provider: WebAIProvider,
  sessions: SessionStore,
  jobs?: JobManager
): void {
  const defaults = doubaoDefaults();
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
      generation?: MediaGenerationRequest;
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
        const selected = requestedKey ?? (options.name || options.files || options.generation ? undefined : sessions.defaultKey(provider.id));
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
          const result = options.generation && provider.generateMedia
            ? await provider.generateMedia(options.generation, previous?.remote)
            : options.files && provider.analyzeFiles
            ? await provider.analyzeFiles(options.files, message, options.thinking, options.signal)
            : await provider.chat({ message, systemPrompt: options.systemPrompt, thinking: options.thinking,
                signal: options.signal }, previous?.remote);
          if (result.remoteSession) {
            sessions.update(record.key, result.remoteSession);
            if (options.makeDefault) sessions.selectDefault(record.key, provider.id);
          } else {
            sessions.invalidate(record.key);
          }
          return formatAnswer(result, result.remoteSession ? record.key : undefined, options.showReasoning, Boolean(options.generation));
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
      return textResult("[doubao error] " + redact(error) + "\n" + failureDetails(error), true);
    }
  };

  server.registerTool(
    "doubao_chat",
    {
      description: "Chat through Doubao WEBSITE. Explicit mode/thinking apply to this message; omission uses DOUBAO_DEFAULT_MODE (built-in quick)." + CHAT_DESCRIPTION,
      inputSchema: z.object({
        ...chatFields,
        mode: z.enum(["quick", "expert"]).optional(),
        thinking: z.boolean().optional(),
        show_reasoning: z.boolean().optional(),
      }).strict(),
    },
    async (
      args,
      extra
    ) => {
      const {
        message,
        session_key,
        conversation_id,
        conversation_name,
        make_default,
        system_prompt,
        mode,
        thinking,
        show_reasoning,
      } = args;
      try {
        const selectedThinking = expertMode(mode, thinking, defaults.mode);
        return await dispatchChat(args, extra, jobs, "doubao_chat", signal => sendChat(message, {
        key: session_key,
        conversationId: conversation_id,
        name: conversation_name,
        makeDefault: make_default,
        systemPrompt: system_prompt,
        thinking: selectedThinking,
        showReasoning: show_reasoning ?? false,
        signal,
      })); } catch (error) { return textResult("[doubao error] " + redact(error) + "\n" + failureDetails(error), true); }
    }
  );

  server.registerTool("doubao_reasoner", {
    description: "Doubao Web expert mode. Prefer background=true for long reasoning. Stop if website reports quota exhaustion." + CHAT_DESCRIPTION,
    inputSchema: z.object({ ...chatFields }).strict(),
  }, async (args, extra) => dispatchChat(args, extra, jobs, "doubao_reasoner", signal =>
    sendChat(args.message, { key: args.session_key, conversationId: args.conversation_id, name: args.conversation_name, makeDefault: args.make_default,
      systemPrompt: args.system_prompt, thinking: true, showReasoning: args.show_reasoning ?? false, signal })));

  server.registerTool("doubao_analyze_files", {
    description: "Create a Doubao file-analysis conversation by uploading selected TXT files. Requires WEB_AI_ALLOWED_ROOTS; resume later with the returned key.",
    inputSchema: z.object({ file_paths: z.array(z.string().min(1)).min(1).max(5),
      instruction: z.string().min(1).default("请分析这些文件并提供改进建议。"), mode: z.enum(["quick", "expert"]).optional(),
      thinking: z.boolean().optional(), show_reasoning: z.boolean().optional(), make_default: z.boolean().optional() }).strict(),
  }, async ({ file_paths, instruction, mode, thinking, show_reasoning, make_default }, extra) => {
    try {
      const expert = expertMode(mode, thinking, defaults.mode);
      if (!provider.analyzeFiles) throw new ProviderError("File analysis unavailable", "unsupported_capability");
      let files: FileInput[];
      try { files = await readAllowedFiles(file_paths, extra.signal); }
      catch { throw new ProviderError("Local file read rejected", extra.signal.aborted ? "cancelled" : "file_access_error"); }
      return await sendChat(instruction, { files, thinking: expert, showReasoning: show_reasoning ?? false,
        makeDefault: make_default, signal: extra.signal });
    } catch (error) { return textResult("[doubao file error] " + redact(error), true); }
  });

  if (provider.generateMedia) {
    const selectors = { session_key: z.string().uuid().optional(), conversation_name: z.string().trim().min(1).max(80).optional() };
    const generate = async (request: MediaGenerationRequest, session_key?: string, conversation_name?: string, referencePaths?: string[]) => {
      try {
        if (referencePaths) {
          try { request.referenceImages = await readAllowedFiles(referencePaths, request.signal!); }
          catch { throw new ProviderError("Reference image read rejected", request.signal?.aborted ? "cancelled" : "reference_image_access_error"); }
        }
        return await sendChat(request.prompt, { key: session_key, name: conversation_name, generation: request,
          thinking: false, showReasoning: false, signal: request.signal! });
      } catch (error) { return textResult("[doubao image error] " + redact(error), true); }
    };
    server.registerTool("doubao_generate_image", {
      description: "Generate an image through your Doubao website account. Omitted model uses DOUBAO_DEFAULT_IMAGE_MODEL (built-in Seedream 5.0 Flash). Select ratio and optional website style. reference_image_paths uploads up to five PNG/JPEG/WebP files from WEB_AI_ALLOWED_ROOTS (10 MiB each, 20 MiB total). Creates a separate conversation by default. Returns actual creation URLs or a clarification. Website controls access/quota; no fallback or automatic resubmission.",
      inputSchema: z.object({ prompt: z.string().trim().min(1).max(10000), model: z.enum(DOUBAO_IMAGE_MODELS).default(defaults.imageModel),
        ratio: z.enum(DOUBAO_IMAGE_RATIOS).default("auto"), style: z.enum(Object.keys(DOUBAO_IMAGE_STYLES) as [string, ...string[]]).optional(),
        reference_image_paths: z.array(z.string().min(1)).min(1).max(5).optional(), ...selectors }).strict(),
    }, ({ prompt, model, ratio, style, reference_image_paths, session_key, conversation_name }, extra) =>
      generate({ kind: "image", prompt, model, ratio, style, signal: extra.signal }, session_key, conversation_name, reference_image_paths));
    server.registerTool("doubao_generate_video", {
      description: "Request a Doubao website video. Omitted model uses DOUBAO_DEFAULT_VIDEO_MODEL (built-in Seedance 2.0 Fast). Seedance 2.5 allows 4–30 seconds; other supported models allow 4–15 seconds. Optional reference_image_paths uploads up to five PNG/JPEG/WebP files from WEB_AI_ALLOWED_ROOTS through the same verified image uploader (10 MiB each, 20 MiB total). Creates a separate conversation by default. The website may ask for confirmation; use doubao_chat with the returned key. Query doubao_media_status for asynchronous results. Model access/quota are controlled by the website; no fallback. Text acknowledgement is not completion.",
      inputSchema: z.object({ prompt: z.string().trim().min(1).max(10000),
        model: z.enum(DOUBAO_VIDEO_MODELS).default(defaults.videoModel),
        ratio: z.enum(DOUBAO_VIDEO_RATIOS).default("auto"),
        duration_seconds: z.number().int().min(4).max(30).default(4),
        reference_image_paths: z.array(z.string().min(1)).min(1).max(5).optional(), ...selectors }).strict(),
    }, ({ prompt, model, ratio, duration_seconds, reference_image_paths, session_key, conversation_name }, extra) =>
      generate({ kind: "video", prompt, model, ratio, durationSeconds: duration_seconds, signal: extra.signal }, session_key, conversation_name, reference_image_paths));
  }

  if (provider.getMedia) server.registerTool("doubao_media_status", {
    description: "Read generated images/videos from the latest 20 messages of an existing local Doubao session. Read-only website query; never submits or retries generation. Can retrieve asynchronously delivered video results after MCP restart.",
    inputSchema: z.object({ session_key: z.string().uuid() }).strict(),
  }, async ({ session_key }, extra) => {
    try {
      return await sessions.exclusive(session_key, async () => {
        const record = sessions.require(session_key, provider.id);
        const result = await provider.getMedia!(record.remote, extra.signal);
        if (result.remoteSession) sessions.update(session_key, result.remoteSession);
        return formatAnswer(result, session_key, false, true);
      });
    } catch (error) { return textResult("[doubao media error] " + redact(error), true); }
  });

  if (provider.getMedia && provider.resolveMediaDownload) server.registerTool("doubao_download_media", {
    description: "Download ONE completed image/video from an existing Doubao conversation to configured WEB_AI_MEDIA_DIR. First query doubao_media_status and select its media_id. Never generates, confirms or resubmits. Website URLs are refreshed from history; arbitrary URLs, filenames and output directories are not accepted. without_watermark=true uses the official image download endpoint and requires website confirmation; videos currently reject that option. Files use unique names and are never overwritten. Total wait is bounded to 45 seconds; on failure retry this download tool, not generation.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: z.object({ session_key: z.string().uuid(), media_id: z.string().trim().min(1).max(256),
      without_watermark: z.boolean().default(false) }).strict(),
  }, async ({ session_key, media_id, without_watermark }, extra) => {
    try {
      const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(45000)]);
      signal.throwIfAborted();
      const directory = await validateMediaDirectory();
      return await sessions.exclusive(session_key, async () => {
        const record = sessions.require(session_key, provider.id);
        const result = await provider.getMedia!(record.remote, signal);
        if (result.remoteSession) sessions.update(session_key, result.remoteSession);
        const media = result.media?.find(item => item.id === media_id);
        if (!media || media.status !== "completed" || !media.url) throw new ProviderError("Media not ready", "media_not_ready");
        const url = await provider.resolveMediaDownload!(media, without_watermark, signal);
        const file = await downloadMediaFile(url, media.type, signal, { directory });
        return textResult(JSON.stringify({ session_key, media_id, type: media.type, local_path: file.localPath,
          bytes: file.bytes, mime_type: file.mimeType, watermark: without_watermark ? "without_watermark" : "original" }, null, 2));
      });
    } catch (error) { return textResult("[doubao download error] " + redact(error) + " Retry only doubao_download_media after correcting the issue; never regenerate to retry a download.", true); }
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
