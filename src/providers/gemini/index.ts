import type { ChatRequest, MediaGenerationRequest, ProviderResult, RemoteSession, WebAIProvider } from "../../core/provider.js";
import { GeminiWebClient, type GeminiSelectedReply } from "./web-client.js";
import type { GeminiModelCatalog } from "./selection.js";

function result(reply: GeminiSelectedReply & { mediaKind?: "image" | "video" }, mediaRequest = false): ProviderResult {
  const resumable = Boolean(reply.conversationId && reply.replyId && reply.candidateId && reply.accountHash);
  const lineageWarning = !resumable
    ? "Gemini returned incomplete reply lineage; this result cannot be resumed. Start a new conversation explicitly."
    : mediaRequest && reply.media?.some(item => item.status === "unavailable")
    ? "Gemini returned a media card on an unverified URL host; its URL was withheld."
    : undefined;
  return {
    content: reply.content || (reply.media?.length ? "Gemini media result." : ""),
    ...(reply.media ? { media: reply.media.map(item => ({ ...item })) } : {}),
    remoteSession: resumable ? { conversationId: reply.conversationId, replyId: reply.replyId,
      candidateId: reply.candidateId, accountHash: reply.accountHash,
      ...(reply.mediaKind ? { mediaKind: reply.mediaKind } : {}),
      ...(reply.model ? { model: reply.model } : {}), ...(reply.thinkingLevel ? { thinkingLevel: reply.thinkingLevel } : {}) } : undefined,
    warning: [lineageWarning, reply.warning].filter(Boolean).join(" ") || undefined,
  };
}

/** Experimental own-account Gemini Web adapter. */
export class GeminiWebProvider implements WebAIProvider {
  readonly id = "gemini";
  readonly displayName = "Gemini Web (experimental HTTP)";
  readonly capabilities = { chat: true, thinking: true, files: true, webSearch: false, sessionResume: true,
    imageGeneration: true, videoGeneration: true } as const;
  private readonly client: GeminiWebClient;

  constructor(cookie: string, client?: GeminiWebClient) {
    this.client = client ?? new GeminiWebClient(cookie);
  }

  async initialize(): Promise<void> { await this.client.initialize(); }

  async chat(request: ChatRequest, previous?: RemoteSession): Promise<ProviderResult> {
    return result(await this.client.chat(request, previous));
  }

  async getModels(previous?: RemoteSession, signal?: AbortSignal): Promise<GeminiModelCatalog> {
    return this.client.getModels(previous, signal);
  }

  async generateMedia(request: MediaGenerationRequest, previous?: RemoteSession): Promise<ProviderResult> {
    return result(await this.client.generateMedia(request, previous), true);
  }

  async getMedia(previous: RemoteSession, signal?: AbortSignal): Promise<ProviderResult> {
    return result({ ...await this.client.getMedia(previous, signal),
      ...(typeof previous.model === "string" ? { model: previous.model } : {}),
      ...(typeof previous.thinkingLevel === "string" ? { thinkingLevel: previous.thinkingLevel } : {}) }, true);
  }

  async fetchMedia(url: string, init?: RequestInit): Promise<Response> {
    return this.client.fetchMedia(url, init);
  }
}
