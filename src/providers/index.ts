import type { ProviderRegistry } from "../core/registry.js";
import { DeepSeekWebProvider } from "./deepseek/index.js";
import { DoubaoWebProvider } from "./doubao/index.js";

/** Composition root. Add future providers explicitly; do not register placeholders. */
export function registerProviders(registry: ProviderRegistry): void {
  const deepseekToken = process.env.DEEPSEEK_USER_TOKEN || "";
  const doubaoCookie = process.env.DOUBAO_COOKIE || "";

  if (deepseekToken || !doubaoCookie) {
    registry.register(new DeepSeekWebProvider(deepseekToken));
  }

  if (doubaoCookie) {
    registry.register(new DoubaoWebProvider(doubaoCookie));
  }
}
