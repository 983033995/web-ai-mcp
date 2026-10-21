import { ProviderError } from "../core/provider.js";
import { DOUBAO_IMAGE_MODELS, DOUBAO_VIDEO_MODELS } from "../providers/doubao/media.js";

type Environment = Record<string, string | undefined>;

function invalid(name: string): never {
  // Configuration values may contain accidentally pasted credentials. Report only the name.
  throw new ProviderError(`Invalid ${name}; check the documented default setting`, "configuration_error");
}

function setting(env: Environment, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function choice<T extends string>(env: Environment, name: string, values: readonly T[], fallback?: T): T | undefined {
  const value = setting(env, name);
  if (value === undefined) return fallback;
  return values.includes(value as T) ? value as T : invalid(name);
}

function model(env: Environment, name: string): string | undefined {
  const value = setting(env, name);
  if (value !== undefined && (value.length > 160 || /[\u0000-\u001f\u007f]/.test(value))) invalid(name);
  return value;
}

/** Read once when tools are registered, after --env-file has been loaded. */
export function deepseekDefaults(env: Environment = process.env) {
  return { thinking: choice(env, "DEEPSEEK_DEFAULT_THINKING", ["true", "false"], "false") === "true" };
}

export function doubaoDefaults(env: Environment = process.env) {
  return {
    mode: choice(env, "DOUBAO_DEFAULT_MODE", ["quick", "expert"], "quick")!,
    imageModel: choice(env, "DOUBAO_DEFAULT_IMAGE_MODEL", DOUBAO_IMAGE_MODELS, DOUBAO_IMAGE_MODELS[0])!,
    videoModel: choice(env, "DOUBAO_DEFAULT_VIDEO_MODEL", DOUBAO_VIDEO_MODELS, DOUBAO_VIDEO_MODELS[0])!,
  };
}

export function geminiDefaults(env: Environment = process.env) {
  return {
    model: model(env, "GEMINI_DEFAULT_MODEL"),
    imageModel: model(env, "GEMINI_DEFAULT_IMAGE_MODEL"),
    videoModel: model(env, "GEMINI_DEFAULT_VIDEO_MODEL"),
    thinkingLevel: choice(env, "GEMINI_DEFAULT_THINKING_LEVEL", ["low", "medium", "high"]),
  };
}
