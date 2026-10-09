import type { ChatRequest, FileInput, ProviderResult, RemoteSession, WebAIProvider } from "../../core/provider.js";
import { DeepSeekWebClient } from "./web-client.js";
import type { WebReply } from "./sse.js";

function result(reply: WebReply & { sessionId: string }): ProviderResult {
  const resumable = Number.isSafeInteger(reply.messageId) && Number(reply.messageId) >= 0;
  return {
    content: reply.content,
    reasoning: reply.reasoning,
    remoteSession: resumable ? { sessionId: reply.sessionId, lastMessageId: reply.messageId } : undefined,
    warning: resumable ? undefined : "Website returned no response message ID; answer is not resumable. Start a new chat without session_key.",
    usage: reply.totalTokens === undefined ? undefined : { total_tokens: reply.totalTokens }
  };
}

/** DeepSeek website adapter. No official API or proxy routing. */
export class DeepSeekWebProvider implements WebAIProvider {
  readonly id = "deepseek";
  readonly displayName = "DeepSeek Web";
  readonly capabilities = {
    chat: true, thinking: true, files: true, webSearch: false, sessionResume: true
  } as const;
  private readonly client: DeepSeekWebClient;

  constructor(userToken: string, client?: DeepSeekWebClient) {
    this.client = client ?? new DeepSeekWebClient(userToken);
  }

  async initialize(): Promise<void> { await this.client.initialize(); }

  async chat(request: ChatRequest, previous?: RemoteSession): Promise<ProviderResult> {
    return result(await this.client.chat(request, previous));
  }

  async analyzeFiles(files: FileInput[], instruction: string, thinking: boolean, signal?: AbortSignal): Promise<ProviderResult> {
    return result(await this.client.analyzeFiles(files, instruction, thinking, signal));
  }
}
