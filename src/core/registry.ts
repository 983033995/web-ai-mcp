import type { WebAIProvider } from "./provider.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, WebAIProvider>();

  register(provider: WebAIProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error("Provider already registered: " + provider.id);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): WebAIProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error("Provider not available: " + id);
    return provider;
  }

  list() {
    return Array.from(this.providers.values(), ({ id, displayName, capabilities }) => ({
      id, displayName, capabilities, status: "active" as const
    }));
  }

  async initializeAll(): Promise<void> {
    for (const provider of this.providers.values()) await provider.initialize();
  }
}
