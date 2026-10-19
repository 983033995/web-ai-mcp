import { DoubaoWebError, businessError } from "./errors.js";
import type { GeneratedMedia } from "../../core/provider.js";
import { creationMedia } from "./media.js";

export interface DoubaoWebReply {
  content: string;
  reasoning?: string;
  conversationId?: string;
  sectionId?: string;
  messageId?: string;
  messageIndex?: number;
  localConversationId?: string;
  media?: GeneratedMedia[];
}

type JsonObject = Record<string, any>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const malformed = () => new DoubaoWebError("malformed_sse", "Invalid or incomplete Doubao Web SSE response", true);
const id = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw malformed();
  return value;
};

export async function parseSSE(body: ReadableStream<Uint8Array>, signal: AbortSignal, expectedConversationId?: string): Promise<DoubaoWebReply> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const blocks = new Map<string, { type: number; text: string; parent?: string; container: boolean }>();
  const mediaBlocks = new Map<string, GeneratedMedia[]>();
  let pending = "";
  let finished = false;
  let accepted = false;
  let event = "";
  let data: string[] = [];
  let bytes = 0;
  let conversationId: string | undefined;
  let sectionId: string | undefined;
  let messageId: string | undefined;
  let messageIndex: number | undefined;
  let deltaBlockId: string | undefined;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });

  function metadata(json: JsonObject): void {
    if (json.message_id !== undefined) {
      const next = id(json.message_id);
      if (messageId && next !== messageId) throw malformed();
      messageId = next;
    }
    const index = json.message_index ?? json.index_in_conv;
    if (index !== undefined) {
      if (!Number.isSafeInteger(index) || index < 0) throw malformed();
      messageIndex = index;
    }
  }

  function apply(value: unknown, operation: "set" | "append" | "remove"): void {
    if (!Array.isArray(value)) throw malformed();
    for (const block of value) {
      if (!object(block) || !Number.isInteger(block.block_type)) throw malformed();
      if (block.block_type === 2074) {
        const key = id(block.block_id);
        if (blocks.has(key)) throw malformed();
        if (operation === "remove") {
          if (!mediaBlocks.delete(key)) throw malformed();
        } else {
          if (!object(block.content)) throw malformed();
          mediaBlocks.set(key, creationMedia(block.content.creation_block));
        }
        continue;
      }
      if (![10000, 10040, 10101].includes(block.block_type)) continue;
      const key = id(block.block_id);
      if (mediaBlocks.has(key)) throw malformed();
      const previous = blocks.get(key);
      if (previous && previous.type !== block.block_type) throw malformed();
      if (operation === "remove") {
        if (!previous) throw malformed();
        blocks.delete(key);
        if (deltaBlockId === key) deltaBlockId = undefined;
        continue;
      }
      if (!object(block.content)) throw malformed();
      const parent = block.parent_id === undefined ? previous?.parent : block.parent_id === "" ? undefined : id(block.parent_id);
      if (parent === key || (previous && parent !== previous.parent)) throw malformed();
      const container = (block.block_type === 10040 && object(block.content.thinking_block)) || block.block_type === 10101;
      if (!container && !object(block.content.text_block)) throw malformed();
      if (previous && previous.container !== container) throw malformed();
      const text = container ? undefined : block.content.text_block.text;
      if (text !== undefined && typeof text !== "string") throw malformed();
      blocks.set(key, { type: block.block_type, parent, container,
        text: text === undefined ? previous?.text ?? "" : operation === "append" ? (previous?.text ?? "") + text : text });
    }
  }

  function dispatch(): void {
    const payload = data.join("\n");
    const kind = event;
    data = [];
    event = "";
    if (!payload && kind !== "STREAM_ERROR" && kind !== "gateway-error") return;
    let json: unknown;
    try { json = JSON.parse(payload || "{}"); } catch { throw malformed(); }
    if (!object(json)) throw malformed();
    const failure = businessError(json, accepted);
    if (failure) throw failure;
    if (kind === "STREAM_ERROR" || kind === "gateway-error") {
      throw new DoubaoWebError("stream_error", "Doubao Web reported a stream error; upstream details suppressed", true);
    }
    if (kind === "SSE_HEARTBEAT") return;
    if (kind === "DOWNLINK_CMD") {
      const info = json.downlink_body?.chunk_update_downlink_body?.interrupt_info;
      if (json.cmd !== 310 || !object(info) || typeof info.no_interrupt !== "boolean" ||
          !["string", "number"].includes(typeof info.chat_id)) throw malformed();
      return;
    }
    if (kind === "DOWNSTREAM_VERBOSE_INFO") {
      if (typeof json.verbose_type !== "string" || typeof json.verbose_payload !== "string") throw malformed();
      return;
    }
    if (kind === "SSE_ACK") {
      if (!object(json.ack_client_meta)) throw malformed();
      const next = id(json.ack_client_meta.conversation_id);
      if ((expectedConversationId && next !== expectedConversationId) || (conversationId && next !== conversationId)) throw malformed();
      conversationId = next;
      sectionId = id(json.ack_client_meta.section_id);
      accepted = true;
      return;
    }
    if (kind === "FULL_MSG_NOTIFY") return;
    if (kind === "STREAM_MSG_NOTIFY") {
      accepted = true;
      if (json.meta !== undefined) {
        if (!object(json.meta) || json.meta.conversation_id !== conversationId || json.meta.section_id !== sectionId) throw malformed();
        metadata(json.meta);
      } else metadata(json);
      if (!object(json.content)) throw malformed();
      apply(json.content.content_block, "set");
      return;
    }
    if (kind === "STREAM_CHUNK") {
      accepted = true;
      metadata(json);
      if (!Array.isArray(json.patch_op)) throw malformed();
      for (const op of json.patch_op) {
        if (!object(op) || !object(op.patch_value)) throw malformed();
        if (op.patch_value.content_block !== undefined) {
          if (op.patch_object !== 1 || ![1, 2, 3].includes(op.patch_type)) throw malformed();
          apply(op.patch_value.content_block, op.patch_type === 1 ? "append" : op.patch_type === 2 ? "set" : "remove");
        } else if (![3, 50, 111].includes(op.patch_object)) {
          throw malformed();
        }
      }
      // Website deltas inherit the last single content-block patch, even across TTS/metadata patches.
      if (json.patch_op.length === 1 && json.patch_op[0].patch_object === 1 &&
          json.patch_op[0].patch_value.content_block?.length === 1) {
        const block = json.patch_op[0].patch_value.content_block[0];
        const key = id(block.block_id);
        deltaBlockId = blocks.has(key) && !blocks.get(key)!.container ? key : undefined;
      }
      return;
    }
    if (kind === "CHUNK_DELTA") {
      const block = deltaBlockId ? blocks.get(deltaBlockId) : undefined;
      if (!block || typeof json.text !== "string") throw malformed();
      block.text += json.text;
      return;
    }
    if (kind === "SSE_REPLY_END") {
      if (![1, 2, 3].includes(json.end_type)) throw malformed();
      const attr = json.msg_finish_attr;
      if (attr !== undefined) {
        if (!object(attr)) throw malformed();
        if (attr.msgid !== undefined) metadata({ message_id: attr.msgid });
      }
      if (json.end_type === 3) finished = true;
      return;
    }
    throw malformed();
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
      bytes += value?.byteLength ?? 0;
      if (bytes > 8 * 1024 * 1024) throw malformed();
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
    let content = "";
    let reasoning = "";
    for (const [key, block] of blocks) {
      if (block.container) continue;
      let thinking = block.type === 10040;
      let parent = block.parent;
      const ancestors = new Set([key]);
      while (parent) {
        const ancestor = blocks.get(parent);
        if (!ancestor || ancestors.has(parent)) throw malformed();
        ancestors.add(parent);
        thinking ||= ancestor.type === 10040;
        parent = ancestor.parent;
      }
      if (thinking) reasoning += block.text;
      else if (block.type === 10000) content += block.text;
    }
    const media = [...mediaBlocks.values()].flat();
    if (!finished || (!content && !media.length)) throw malformed();
    return { content, reasoning: reasoning || undefined, conversationId, sectionId, messageId, messageIndex,
      ...(media.length ? { media } : {}) };
  } catch (error) {
    if (error instanceof DoubaoWebError || signal.aborted) throw error;
    throw malformed();
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
