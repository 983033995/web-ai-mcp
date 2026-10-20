import type { ChatRequest, ProviderResult, RemoteSession, WebAIProvider } from "../../core/provider.js";
import { GeminiWebClient } from "./web-client.js";
import type { GeminiWebReply } from "./stream.js";

function result(reply: GeminiWebReply & { accountHash?: string }): ProviderResult {
  const resumable = Boolean(reply.conversationId && reply.replyId && reply.candidateId && reply.accountHash);
  return {
    content: reply.content,
    remoteSession: resumable ? { conversationId: reply.conversationId, replyId: reply.replyId,
      candidateId: reply.candidateId, accountHash: reply.accountHash } : undefined,
    warning: resumable ? undefined : "Gemini returned an answer without complete reply lineage; the answer cannot be resumed. Start a new conversation explicitly."
  };
}

/** Experimental own-account Gemini Web adapter; only default-model chat is enabled. */
export class GeminiWebProvider implements WebAIProvider {
  readonly id = "gemini";
  readonly displayName = "Gemini Web (experimental HTTP)";
  readonly capabilities = { chat: true, thinking: false, files: false, webSearch: false, sessionResume: true } as const;
  private readonly client: GeminiWebClient;

  constructor(cookie: string, client?: GeminiWebClient) {
    this.client = client ?? new GeminiWebClient(cookie);
  }

  async initialize(): Promise<void> { await this.client.initialize(); }

  async chat(request: ChatRequest, previous?: RemoteSession): Promise<ProviderResult> {
    return result(await this.client.chat(request, previous));
  }
}
