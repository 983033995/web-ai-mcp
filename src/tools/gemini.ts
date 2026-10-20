import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProviderError, type FileInput, type ProviderResult, type RemoteSession, type WebAIProvider } from "../core/provider.js";
import { readAllowedFiles } from "../core/files.js";
import type { SessionStore } from "../core/session-store.js";
import type { JobManager } from "../core/jobs.js";
import { CHAT_DESCRIPTION, chatFields, dispatchChat, failureDetails } from "./guidance.js";
import { GeminiQuotaError, type GeminiAccountStatus } from "../providers/gemini/cooldown.js";
import { GEMINI_THINKING_LEVELS, type GeminiModelCatalog } from "../providers/gemini/selection.js";
import { downloadMediaFile, validateMediaDirectory } from "../core/media-download.js";
import { geminiMediaURL } from "../providers/gemini/media.js";

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
  invalid_request: "Invalid Gemini request. Check the model, thinking_level, ratio and reference-file parameters supported by this tool.",
  unsupported_capability: "This Gemini capability is not verified and is disabled.",
  invalid_file: "Gemini file input was rejected. Check WEB_AI_ALLOWED_ROOTS and use supported TXT, PNG, JPEG, WebP or MP4 files within the configured size limits.",
  file_upload_error: "Gemini file upload failed; no chat or generation request was sent. Correct the file or retry only after checking the upload state.",
  invalid_session: "Gemini website conversation state was not confirmed. Stop and check the website; do not create a replacement automatically.",
  session_state_error: "Gemini website conversation lineage was not confirmed.",
  invalid_response: "Gemini website returned an invalid or incomplete response.",
  malformed_sse: "Gemini website returned malformed or truncated stream frames.",
  stream_error: "Gemini website reported a stream error.",
  website_error: "Gemini website rejected the request; upstream details are not exposed.",
  quota_exhausted: "Eligible Gemini accounts are cooling down for this capability, or this conversation is pinned to an exhausted account. Read gemini_accounts for local cooldown state.",
  cooldown_state_error: "Gemini cooldown state could not be read or saved safely. Generation is blocked; preserve the state file and check its permissions or lock.",
  download_configuration_error: "Set WEB_AI_MEDIA_DIR to an existing private absolute directory without symbolic links.",
  download_error: "Gemini media could not be downloaded. Retry only the download; do not generate again.",
  media_not_ready: "The selected generated media is not ready; query gemini_media_status without resubmitting generation.",
  history_not_found: "Gemini has not published this media turn in history yet. Query gemini_media_status later; do not resubmit generation.",
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
  if (typeof result.remoteSession?.accountId === "string") chunks.push("account_id: " + result.remoteSession.accountId);
  if (result.media) chunks.push(JSON.stringify({
    media_status: !result.media.length ? "no_media_returned" : result.media.every(m => m.status === "completed") ? "completed" : "incomplete",
    media: result.media.map(({ resourceId: _resourceId, id: media_id, ...media }) => ({ media_id, ...media })),
  }, null, 2));
  if (result.warning) chunks.push("warning: " + result.warning);
  return textResult(chunks.join("\n\n---\n\n"));
}

function supportedGeminiFilename(name: string, kind?: "image" | "video"): boolean {
  if (kind === "image") return /\.(?:png|jpe?g|webp)$/i.test(name);
  if (kind === "video") return /\.mp4$/i.test(name);
  return /\.(?:txt|png|jpe?g|webp|mp4)$/i.test(name);
}

function safeModelCatalog(catalog: GeminiModelCatalog): unknown {
  const opaqueId = (value: string) => /^[a-f0-9]{8,64}$/i.test(value) || /^gemini-[a-f0-9]{8,64}$/i.test(value);
  return {
    capacity: catalog.capacity,
    models: catalog.models.flatMap(model => {
      const modelName = opaqueId(model.modelName) ? undefined : model.modelName;
      const displayName = opaqueId(model.displayName) ? undefined : model.displayName;
      if (!modelName && !displayName) return [];
      return [{ ...(modelName ? { model_name: modelName } : {}), ...(displayName ? { display_name: displayName } : {}),
        capacity: model.capacity, available: model.available, selectable: model.selectable }];
    }),
    thinking_levels: GEMINI_THINKING_LEVELS.map(({ id, label }) => ({ id, label })),
  };
}

export function registerGeminiTools(
  server: McpServer, provider: WebAIProvider, sessions: SessionStore, jobs?: JobManager
): void {
  const errorResult = (error: unknown) => textResult("[gemini error] " + redact(error) + "\n" + failureDetails(error) +
    (error instanceof GeminiQuotaError ? "\n" + JSON.stringify({ cooldown_until: error.resetAtMs ? new Date(error.resetAtMs).toISOString() : null }) : ""), true);
  const { show_reasoning: _showReasoning, ...fields } = chatFields;
  server.registerTool("gemini_chat", {
    description: "Chat through your own Gemini WEBSITE (experimental HTTP). Optional model and thinking_level are validated against the selected account; file_paths uploads supported files from WEB_AI_ALLOWED_ROOTS. No web search. system_prompt is a plain text prefix, not a website system role." + CHAT_DESCRIPTION,
    inputSchema: z.object({ ...fields,
      model: z.string().trim().min(1).max(160).optional(),
      thinking_level: z.enum(["low", "medium", "high"]).optional(),
      file_paths: z.array(z.string().min(1)).min(1).max(5).optional(),
    }).strict(),
  }, async (args, extra) => dispatchChat(args, extra, jobs, "gemini_chat", async signal => {
    try {
      const requestedKey = args.conversation_id ?? args.session_key;
      return await sessions.exclusive(requestedKey ?? args.conversation_name ?? "project-chat", async () => {
        const selected = requestedKey ?? (args.conversation_name ? undefined : sessions.defaultKey(provider.id));
        const previous = selected ? sessions.require(selected, provider.id)
          : args.conversation_name ? sessions.named(args.conversation_name, provider.id) : undefined;
        let files: FileInput[] | undefined;
        if (args.file_paths) {
          try { files = await readAllowedFiles(args.file_paths, signal); }
          catch { throw new ProviderError("Gemini file input rejected", signal.aborted ? "cancelled" : "invalid_file"); }
          if (files.some(file => !supportedGeminiFilename(file.name))) {
            throw new ProviderError("Gemini file input rejected", "invalid_file");
          }
        }
        const record = previous ?? sessions.put({
          providerId: provider.id, remote: {}, name: args.conversation_name,
          title: args.conversation_name ?? "Website conversation",
        });
        sessions.beginTurn(record.key);
        try {
          const request = {
            message: args.message, systemPrompt: args.system_prompt, thinking: false, signal,
            ...(args.model ? { model: args.model } : {}),
            ...(args.thinking_level ? { thinkingLevel: args.thinking_level } : {}),
            ...(files ? { files } : {}),
          };
          const result = await provider.chat(request, previous?.remote);
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

  const modelProvider = provider as WebAIProvider & {
    getModels?: (previous?: RemoteSession, signal?: AbortSignal) => Promise<GeminiModelCatalog>;
  };
  if (modelProvider.getModels) server.registerTool("gemini_models", {
    description: "Read this Gemini account's available model names and safe thinking levels. Optional session_key binds discovery to that conversation's account; without it the first configured account is queried. No generation or session mutation.",
    inputSchema: z.object({ session_key: z.string().uuid().optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ session_key }, extra) => {
    try {
      const catalog = session_key
        ? await sessions.exclusive(session_key, async () => {
          const record = sessions.require(session_key, provider.id);
          return modelProvider.getModels!(record.remote, extra.signal);
        })
        : await modelProvider.getModels!(undefined, extra.signal);
      return textResult(JSON.stringify(safeModelCatalog(catalog), null, 2));
    } catch (error) { return errorResult(error); }
  });

  const accounts = provider as WebAIProvider & { accountStatus?: () => Promise<GeminiAccountStatus[]> };
  if (accounts.accountStatus) server.registerTool("gemini_accounts", {
    description: "Read configured Gemini account order and independent image/video cooldowns. Local only; no login credentials, website requests or generation. Expiry restores eligibility, never replays tasks.",
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try {
      return textResult(JSON.stringify({ selection: "configured_order", accounts: (await accounts.accountStatus!()).map(a => ({
        account_id: a.id, order: a.order, image_generation: a.imageGeneration, video_generation: a.videoGeneration,
        cooldowns: Object.fromEntries(Object.entries(a.cooldown).map(([kind, value]) => [kind, {
          cooling_down: value.coolingDown, blocked_until: value.blockedUntilMs ? new Date(value.blockedUntilMs).toISOString() : null,
          remaining_seconds: value.remainingSeconds, source: value.source ?? null,
        }])),
      })) }, null, 2));
    } catch (error) { return errorResult(error); }
  });

  if (provider.generateMedia) {
    const fields = { prompt: z.string().trim().min(1).max(10000), model: z.string().trim().min(1).max(160).optional(),
      thinking_level: z.enum(["low", "medium", "high"]).optional(),
      reference_image_paths: z.array(z.string().min(1)).min(1).max(5).optional(),
      session_key: z.string().uuid().optional(), conversation_name: z.string().trim().min(1).max(80).optional(),
      background: chatFields.background, request_id: chatFields.request_id };
    for (const kind of ["image", "video"] as const) {
      if (!(kind === "image" ? provider.capabilities.imageGeneration : provider.capabilities.videoGeneration)) continue;
      const tool = "gemini_generate_" + kind;
      const ratio = (kind === "video" ? z.enum(["16:9", "9:16"]) : z.enum(["1:1", "3:4", "4:3", "16:9", "9:16"]))
        .optional().describe("Select the website's native output aspect-ratio control; inspect completed output dimensions.");
      const inputSchema = kind === "video"
        ? z.object({ ...fields, ratio, reference_video_paths: z.array(z.string().min(1)).min(1).max(5).optional() }).strict()
        : z.object({ ...fields, ratio }).strict();
      server.registerTool(tool, {
        description: `Generate a Gemini ${kind} using configured accounts in order. Optional model and thinking_level must be supported by the selected account. ${kind === "video" ? "reference_image_paths accepts PNG/JPEG/WebP and experimental reference_video_paths accepts MP4; the website may decline video-reference generation" : "reference_image_paths accepts PNG/JPEG/WebP"}; all files come from WEB_AI_ALLOWED_ROOTS, up to five combined. ratio selects the native website control. Only a definitive unaccepted generation-quota rejection can advance to another account; bound sessions never move. Use background=true with a fresh UUID request_id for long work, then webai_job_status. Prose is not completed media; query gemini_media_status.`,
        inputSchema,
      }, async (args, extra) => dispatchChat({ ...args, message: args.prompt }, extra, jobs, tool, async signal => {
        try {
          return await sessions.exclusive(args.session_key ?? args.conversation_name ?? "gemini-generation", async () => {
            const previous = args.session_key ? sessions.require(args.session_key, provider.id)
              : args.conversation_name ? sessions.named(args.conversation_name, provider.id) : undefined;
            const imagePaths = args.reference_image_paths ?? [];
            const videoPaths = kind === "video" ? (args as typeof args & { reference_video_paths?: string[] }).reference_video_paths ?? [] : [];
            if (imagePaths.length + videoPaths.length > 5) throw new ProviderError("Gemini media references rejected", "invalid_file");
            let references: FileInput[] = [];
            if (imagePaths.length + videoPaths.length > 0) {
              try { references = await readAllowedFiles([...imagePaths, ...videoPaths], signal); }
              catch { throw new ProviderError("Gemini media references rejected", signal.aborted ? "cancelled" : "invalid_file"); }
              const images = references.slice(0, imagePaths.length);
              const videos = references.slice(imagePaths.length);
              if (images.some(file => !supportedGeminiFilename(file.name, "image")) ||
                  videos.some(file => !supportedGeminiFilename(file.name, "video"))) {
                throw new ProviderError("Gemini media references rejected", "invalid_file");
              }
            }
            const record = previous ?? sessions.put({ providerId: provider.id, remote: {}, name: args.conversation_name, title: "Website media conversation" });
            sessions.beginTurn(record.key);
            try {
              const request = {
                kind, prompt: args.prompt, signal,
                ...(args.model ? { model: args.model } : {}),
                ...(args.thinking_level ? { thinkingLevel: args.thinking_level } : {}),
                ...(args.ratio ? { ratio: args.ratio } : {}),
                ...(imagePaths.length ? { referenceImages: references.slice(0, imagePaths.length) } : {}),
                ...(videoPaths.length ? { referenceVideos: references.slice(imagePaths.length) } : {}),
              };
              const result = await provider.generateMedia!(request, previous?.remote);
              if (result.remoteSession) sessions.update(record.key, result.remoteSession); else sessions.invalidate(record.key);
              return answer({ ...result, media: result.media ?? [] }, result.remoteSession ? record.key : undefined);
            } catch (error) {
              if (error instanceof ProviderError && !error.sessionUncertain) {
                sessions.cancelTurn(record.key); if (!previous) sessions.delete(record.key);
              } else sessions.invalidate(record.key);
              throw error;
            }
          });
        } catch (error) { return errorResult(error); }
      }));
    }
  }
  if (provider.getMedia) {
    server.registerTool("gemini_media_status", {
      description: "Read one bounded Gemini conversation response to retrieve existing generated media. Does not submit, confirm or retry generation, and never changes accounts. Requires the returned local session_key.",
      inputSchema: z.object({ session_key: z.string().uuid() }).strict(), annotations: { readOnlyHint: true },
    }, async ({ session_key }, extra) => {
      try {
        return await sessions.exclusive(session_key, async () => {
          const record = sessions.require(session_key, provider.id);
          const result = await provider.getMedia!(record.remote, extra.signal);
          if (result.remoteSession) sessions.update(record.key, result.remoteSession);
          return answer({ ...result, media: result.media ?? [] }, record.key);
        });
      } catch (error) { return errorResult(error); }
    });
    server.registerTool("gemini_download_media", {
      description: "Refresh existing Gemini media, select an actual completed media_id and save the validated image/video under WEB_AI_MEDIA_DIR. Does not generate or remove watermarks. Downloads never retry generation.",
      inputSchema: z.object({ session_key: z.string().uuid(), media_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    }, async ({ session_key, media_id }, extra) => {
      try {
        const directory = await validateMediaDirectory();
        return await sessions.exclusive(session_key, async () => {
          const record = sessions.require(session_key, provider.id);
          const result = await provider.getMedia!(record.remote, extra.signal);
          const media = result.media?.find(m => m.id === media_id && m.status === "completed" && m.url);
          if (!media?.url) throw new ProviderError("Media not ready", "media_not_ready");
          const bound = provider as WebAIProvider & { fetchMediaForSession?: (session: Record<string, string | number | boolean | null | undefined>, url: string, init?: RequestInit) => Promise<Response> };
          const file = await downloadMediaFile(media.url, media.type, extra.signal, { directory, validateUrl: geminiMediaURL,
            ...(bound.fetchMediaForSession ? { fetch: (input, init) => bound.fetchMediaForSession!(record.remote, String(input), init) } : {}) });
          return textResult(JSON.stringify({ media_id, type: media.type, local_path: file.localPath, bytes: file.bytes, mime_type: file.mimeType }));
        });
      } catch (error) { return errorResult(error); }
    });
  }
}
