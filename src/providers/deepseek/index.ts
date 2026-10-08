import type {
  ChatRequest, FileInput, ProviderResult, RemoteSession, WebAIProvider
} from "../../core/provider.js";
import { DeepSeekWebClient } from "./upstream/web-client.js";
import type { DeepSeekConfig } from "./upstream/config.js";

/** DeepSeek website adapter. No official DeepSeek API client or model proxy. */
export class DeepSeekWebProvider implements WebAIProvider {
  readonly id = "deepseek";
  readonly displayName = "DeepSeek Web";
  readonly capabilities = {
    chat: true, thinking: true, files: true, webSearch: false, sessionResume: true
  } as const;

  private readonly client: DeepSeekWebClient;

  constructor(userToken: string) {
    if (!userToken) throw new Error("Missing DEEPSEEK_USER_TOKEN (own website account)");
    const config: DeepSeekConfig = {
      authMode: "web_token",
      webToken: userToken,
      webEmail: "",
      webPassword: "",
      webBaseUrl: process.env.DEEPSEEK_WEB_BASE_URL || "https://chat.deepseek.com/api/v0",
      timeout: Number(process.env.DEEPSEEK_TIMEOUT || "60000"),
      maxRetries: 1,
      apiKey: "",
      baseUrl: "",
    };
    this.client = new DeepSeekWebClient(config);
  }

  async initialize(): Promise<void> {
    await this.client.initialize();
  }

  async chat(request: ChatRequest, previous?: RemoteSession): Promise<ProviderResult> {
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: "system", content: request.systemPrompt });
    messages.push({ role: "user", content: request.message });

    const id = previous?.sessionId;
    const parent = previous?.lastMessageId;
    if (previous && (typeof id !== "string" || typeof parent !== "number")) {
      throw new Error("Invalid DeepSeek remote session lineage");
    }
    const result = await this.client.webChatWithSession(
      { model: request.thinking ? "deepseek-reasoner" : "deepseek-chat", messages },
      typeof id === "string" ? id : undefined,
      typeof parent === "number" ? parent : null,
    );

    if (result.messageId == null) {
      // Deliberately fail rather than claim that future turns can safely resume.
      throw new Error("DeepSeek Web did not return response message ID; session cannot be safely continued");
    }
    return {
      content: result.content,
      reasoning: result.reasoning_content || undefined,
      remoteSession: { sessionId: result.sessionId, lastMessageId: result.messageId },
      usage: result.usage ? {
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: result.usage.completion_tokens,
        total_tokens: result.usage.total_tokens
      } : undefined,
    };
  }

  async analyzeFiles(files: FileInput[], instruction: string, thinking: boolean): Promise<ProviderResult> {
    const result = await this.client.chatWithFiles(
      files, instruction, thinking ? "deepseek-reasoner" : "deepseek-chat"
    );
    return { content: result.content, reasoning: result.reasoning_content || undefined };
  }
}
