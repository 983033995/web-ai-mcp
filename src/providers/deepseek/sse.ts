import { DeepSeekWebError, authenticationError, isAuthenticationCode } from "./errors.js";

export interface WebReply {
  content: string;
  reasoning?: string;
  messageId?: number;
  totalTokens?: number;
}

type JsonObject = Record<string, any>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const malformed = () => new DeepSeekWebError("malformed_sse", "Invalid or incomplete DeepSeek Web SSE response", true);

/** Website snapshots and relative patches, including fragment type transitions. */
export async function parseSSE(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<WebReply> {
  const state: JsonObject = {};
  let messageId: number | undefined;
  let lastPath = "";
  let lastOperation = "SET";
  let finished = false;
  let event = "";
  let data: string[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });

  function patch(path: string, operation: string, value: unknown): void {
    if (operation === "BATCH") {
      if (!Array.isArray(value)) throw malformed();
      for (const item of value) {
        if (!object(item) || typeof item.p !== "string") throw malformed();
        patch([path, item.p].filter(Boolean).join("/"), item.o ?? "SET", item.v);
      }
      return;
    }
    const parts = path.replace(/^\//, "").split("/").filter(Boolean);
    if (!parts.length) {
      if (!object(value) || operation !== "SET") throw malformed();
      Object.assign(state, value);
      return;
    }
    if (parts.some((part) => ["__proto__", "prototype", "constructor"].includes(part))) throw malformed();
    let target: JsonObject = state;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i] === "-1" && Array.isArray(target)
        ? String(target.length - 1) : parts[i];
      if (target[part] == null) target[part] = parts[i + 1] === "-1" || /^\d+$/.test(parts[i + 1]) ? [] : {};
      if (typeof target[part] !== "object" || target[part] === null) throw malformed();
      target = target[part];
    }
    const key = parts.at(-1) === "-1" && Array.isArray(target)
      ? String(target.length - 1) : parts.at(-1)!;
    if (operation === "SET") target[key] = value;
    else if (operation === "APPEND") {
      if (typeof value === "string" && (target[key] == null || typeof target[key] === "string")) {
        target[key] = (target[key] ?? "") + value;
      } else if (Array.isArray(value) && (target[key] == null || Array.isArray(target[key]))) {
        target[key] = [...(target[key] ?? []), ...value];
      } else throw malformed();
    } else throw malformed();
  }

  function dispatch(): void {
    const payload = data.join("\n");
    data = [];
    const kind = event;
    event = "";
    if (!payload) return;
    if (payload === "[DONE]") { finished = true; return; }
    let chunk: unknown;
    try { chunk = JSON.parse(payload); } catch { throw malformed(); }
    if (!object(chunk)) throw malformed();
    if (isAuthenticationCode(chunk.code) || isAuthenticationCode(chunk.error?.code)) throw authenticationError();
    if (kind === "error" || chunk.error || (typeof chunk.code === "number" && chunk.code !== 0)) {
      throw new DeepSeekWebError("stream_error", "DeepSeek Web reported a stream error", true);
    }
    if (kind === "ready") {
      if (Number.isSafeInteger(chunk.response_message_id)) messageId = chunk.response_message_id;
      return;
    }
    if (kind === "close" || kind === "finish") { finished = true; return; }
    if (kind && kind !== "message") return;
    if (!("v" in chunk)) {
      if (!Object.keys(chunk).length) return;
      throw malformed();
    }
    if (chunk.p !== undefined && typeof chunk.p !== "string") throw malformed();
    const path = chunk.p ?? lastPath;
    // Website compression carries p and o independently. Changing the path does
    // not reset APPEND when the operation is omitted (notably THINK -> RESPONSE).
    const operation = chunk.o ?? lastOperation;
    patch(path, operation, chunk.v);
    lastPath = path;
    lastOperation = operation;
    if (state.response?.status === "FINISHED") finished = true;
  }

  function line(value: string): void {
    if (!value) { dispatch(); return; }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let text = colon < 0 ? "" : value.slice(colon + 1);
    if (text.startsWith(" ")) text = text.slice(1);
    if (field === "event") event = text;
    if (field === "data") data.push(text);
  }

  try {
    while (!finished) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, newline).replace(/\r$/, ""));
        pending = pending.slice(newline + 1);
        if (finished) break;
      }
      if (done) {
        if (pending) line(pending.replace(/\r$/, ""));
        dispatch();
        break;
      }
    }
    if (!finished || !object(state.response)) throw malformed();
    const response = state.response;
    if (Number.isSafeInteger(response.message_id)) messageId = response.message_id;
    let content = typeof response.content === "string" ? response.content : "";
    let reasoning = typeof response.thinking_content === "string" ? response.thinking_content : "";
    if (Array.isArray(response.fragments)) {
      content = "";
      reasoning = "";
      for (const fragment of response.fragments) {
        if (!object(fragment) || typeof fragment.content !== "string") throw malformed();
        if (fragment.type === "RESPONSE") content += fragment.content;
        else if (fragment.type === "THINK" || fragment.type === "THINKING") reasoning += fragment.content;
        else throw malformed();
      }
    }
    if (!content && !reasoning) throw malformed();
    return { content, reasoning: reasoning || undefined, messageId,
      totalTokens: typeof response.accumulated_token_usage === "number" ? response.accumulated_token_usage : undefined };
  } catch (error) {
    if (error instanceof DeepSeekWebError || signal.aborted) throw error;
    throw malformed();
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
