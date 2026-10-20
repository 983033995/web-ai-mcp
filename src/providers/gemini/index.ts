import type { ChatRequest, MediaGenerationRequest, ProviderResult, RemoteSession, WebAIProvider } from "../../core/provider.js";
import { GeminiWebClient } from "./web-client.js";
import type { GeminiWebReply } from "./stream.js";

function result(reply: GeminiWebReply & { accountHash?: string; mediaKind?: "image" | "video" }, mediaRequest = false): ProviderResult {
  const resumable = Boolean(reply.conversationId && reply.replyId && reply.candidateId && reply.accountHash);
  const warning = !resumable
    ? "Gemini returned incomplete reply lineage; this result cannot be resumed. Start a new conversation explicitly."
    : mediaRequest && reply.media?.some(item => item.status === "unavailable")
    ? "Gemini returned a media card on an unverified URL host; its URL was withheld."
    : undefined;
  return {
    content: reply.content || (reply.media?.length ? "Gemini media result." : ""),
    ...(reply.media ? { media: reply.media.map(item => ({ ...item })) } : {}),
    remoteSession: resumable ? { conversationId: reply.conversationId, replyId: reply.replyId,
      candidateId: reply.candidateId, accountHash: reply.accountHash,
      ...(reply.mediaKind ? { mediaKind: reply.mediaKind } : {}) } : undefined,
    warning,
  };
}

/** Experimental own-account Gemini Web adapter; only default-model chat is enabled. */
export class GeminiWebProvider implements WebAIProvider {
  readonly id = "gemini";
  readonly displayName = "Gemini Web (experimental HTTP)";
  readonly capabilities = { chat: true, thinking: false, files: false, webSearch: false, sessionResume: true,
    imageGeneration: true, videoGeneration: true } as const;
  private readonly client: GeminiWebClient;

  constructor(cookie: string, client?: GeminiWebClient) {
    this.client = client ?? new GeminiWebClient(cookie);
  }

  async initialize(): Promise<void> { await this.client.initialize(); }

  async chat(request: ChatRequest, previous?: RemoteSession): Promise<ProviderResult> {
    return result(await this.client.chat(request, previous));
  }

  async generateMedia(request: MediaGenerationRequest, previous?: RemoteSession): Promise<ProviderResult> {
    return result(await this.client.generateMedia(request, previous), true);
  }

  async getMedia(previous: RemoteSession, signal?: AbortSignal): Promise<ProviderResult> {
    return result(await this.client.getMedia(previous, signal), true);
  }

  async fetchMedia(url: string, init?: RequestInit): Promise<Response> {
    return this.client.fetchMedia(url, init);
  }
}
