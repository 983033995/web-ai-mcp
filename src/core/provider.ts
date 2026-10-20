/** Shared provider surface. Site-specific session IDs remain opaque to core. */
export type RemoteSession = Record<string, string | number | boolean | null | undefined>;

export interface ProviderCapabilities {
  chat: boolean;
  thinking: boolean;
  files: boolean;
  webSearch: boolean;
  sessionResume: boolean;
  imageGeneration?: boolean;
  videoGeneration?: boolean;
}

export interface MediaGenerationRequest {
  kind: "image" | "video";
  prompt: string;
  model?: string;
  style?: string;
  referenceImages?: FileInput[];
  ratio?: string;
  durationSeconds?: number;
  signal?: AbortSignal;
}

export interface GeneratedMedia {
  id?: string;
  type: "image" | "video";
  status: "pending" | "completed" | "unavailable";
  url?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  /** Opaque provider-owned download reference; never persisted in session storage. */
  resourceId?: string;
}

export interface ChatRequest {
  message: string;
  systemPrompt?: string;
  thinking: boolean;
  signal?: AbortSignal;
}

export interface ProviderResult {
  content: string;
  reasoning?: string;
  remoteSession?: RemoteSession;
  usage?: Record<string, number>;
  warning?: string;
  media?: GeneratedMedia[];
}

/** A failed write may have advanced website state even without a usable reply. */
export class ProviderError extends Error {
  constructor(message: string, readonly code: string, readonly sessionUncertain = false) {
    super(message);
  }
}

export interface FileInput {
  name: string;
  buffer: Buffer;
}

export interface WebAIProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  initialize(): Promise<void>;
  chat(request: ChatRequest, session?: RemoteSession): Promise<ProviderResult>;
  analyzeFiles?(files: FileInput[], instruction: string, thinking: boolean, signal?: AbortSignal): Promise<ProviderResult>;
  generateMedia?(request: MediaGenerationRequest, session?: RemoteSession): Promise<ProviderResult>;
  getMedia?(session: RemoteSession, signal?: AbortSignal): Promise<ProviderResult>;
  resolveMediaDownload?(media: GeneratedMedia, withoutWatermark: boolean, signal?: AbortSignal): Promise<string>;
}
