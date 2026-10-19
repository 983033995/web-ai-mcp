import type { ChatRequest, FileInput, ProviderResult, RemoteSession, WebAIProvider } from "../../core/provider.js";
import { DoubaoWebClient } from "./web-client.js";
import type { DoubaoWebReply } from "./sse.js";

export class DoubaoWebProvider implements WebAIProvider {
  readonly id = "doubao";
  readonly displayName = "Doubao Web (experimental HTTP)";
  readonly capabilities = { chat: true, thinking: true, files: true, webSearch: false, sessionResume: true } as const;

  constructor(cookie: string, private readonly client = new DoubaoWebClient(cookie)) {}

  async initialize(): Promise<void> { await this.client.initialize(); }

  async chat(request: ChatRequest, previous?: RemoteSession): Promise<ProviderResult> {
    const reply = await this.client.chat(request, previous);
    return this.result(reply);
  }

  async analyzeFiles(files: FileInput[], instruction: string, thinking: boolean, signal?: AbortSignal): Promise<ProviderResult> {
    return this.result(await this.client.analyzeFiles(files, instruction, thinking, signal));
  }

  private result(reply: DoubaoWebReply): ProviderResult {
    const resumable = Boolean(reply.conversationId && reply.sectionId && reply.messageId && reply.localConversationId &&
      Number.isSafeInteger(reply.messageIndex) && Number(reply.messageIndex) >= 0);
    return {
      content: reply.content,
      reasoning: reply.reasoning,
      remoteSession: resumable ? {
        conversationId: reply.conversationId, sectionId: reply.sectionId, lastMessageId: reply.messageId,
        lastMessageIndex: reply.messageIndex, localConversationId: reply.localConversationId
      } : undefined,
      warning: resumable ? undefined : "Website returned incomplete reply lineage; answer is not resumable. Close the local session before starting another."
    };
  }
}
