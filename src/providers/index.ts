import type { ProviderRegistry } from "../core/registry.js";
import { DeepSeekWebProvider } from "./deepseek/index.js";

/** Composition root. Add future providers explicitly; do not register placeholders. */
export function registerProviders(registry: ProviderRegistry): void {
  registry.register(new DeepSeekWebProvider(process.env.DEEPSEEK_USER_TOKEN || ""));
  // FUTURE ONLY: registry.register(new DoubaoWebProvider(...))
}
