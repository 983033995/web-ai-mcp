import { randomBytes, randomUUID } from "node:crypto";
import type { ChatRequest, FileInput, MediaGenerationRequest, ProviderResult, RemoteSession } from "../../core/provider.js";
import { DoubaoWebError, businessError, captchaError, httpError } from "./errors.js";
import { parseSSE, type DoubaoWebReply } from "./sse.js";
import { DoubaoUploader, type DoubaoAttachment } from "./upload.js";
import { creationAbility, creationMedia } from "./media.js";

export interface DoubaoClientOptions {
  chatUrl?: string;
  userAgent?: string;
  timeout?: number;
  fetch?: typeof fetch;
}

const configuration = () => new DoubaoWebError("configuration_error",
  "Configure DOUBAO_COOKIE, DOUBAO_CHAT_URL and DOUBAO_USER_AGENT from your own website request; never share credentials.");
const sessionError = () => new DoubaoWebError("session_state_error", "Invalid Doubao remote session; close it explicitly before starting another conversation");
const remoteId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 256;
function validateSession(previous: RemoteSession): void {
  if (!remoteId(previous.conversationId) || !remoteId(previous.sectionId) || !remoteId(previous.lastMessageId) ||
      !remoteId(previous.localConversationId) || !Number.isSafeInteger(previous.lastMessageIndex) || Number(previous.lastMessageIndex) < 0) throw sessionError();
}

export class DoubaoWebClient {
  private readonly url: URL;
  private readonly timeout: number;
  private readonly request: typeof fetch;
  private readonly cookie: string;
  private readonly csrf: string;
  private readonly userAgent: string;
  private verificationBlocked = false;
  private readonly uploader: DoubaoUploader;

  constructor(cookie: string, options: DoubaoClientOptions = {}) {
    if (!cookie.trim() || /[\r\n]/.test(cookie)) throw configuration();
    const cookies = new Map(cookie.split(";").map(part => {
      const index = part.indexOf("=");
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }));
    const session = cookies.get("sessionid") || cookies.get("sessionid_ss");
    const csrf = cookies.get("passport_csrf_token") || cookies.get("passport_csrf_token_default");
    if (!session || !csrf || !cookies.get("s_v_web_id")) throw configuration();
    this.cookie = cookie.trim();
    this.csrf = csrf;
    const rawUrl = options.chatUrl ?? process.env.DOUBAO_CHAT_URL;
    try { this.url = new URL(rawUrl ?? ""); } catch { throw configuration(); }
    const website = this.url.origin === "https://www.doubao.com";
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(this.url.hostname) && this.url.protocol === "http:";
    if ((!website && !local) || this.url.pathname !== "/chat/completion" || this.url.username || this.url.password || this.url.hash) throw configuration();
    for (const key of ["aid", "device_id", "web_id", "tea_uuid", "fp", "pc_version", "region", "sys_region", "web_tab_id"]) {
      if (!this.url.searchParams.get(key)?.trim() || this.url.searchParams.getAll(key).length !== 1) throw configuration();
    }
    if (this.url.searchParams.get("aid") !== "497858" || this.url.searchParams.get("fp") !== cookies.get("s_v_web_id")) throw configuration();
    if (Array.from(this.url.searchParams.keys()).some(key => /cookie|sessionid|csrf/i.test(key))) throw configuration();
    this.userAgent = options.userAgent ?? process.env.DOUBAO_USER_AGENT ?? "";
    if (!this.userAgent.trim() || /[\r\n]/.test(this.userAgent)) throw configuration();
    this.timeout = options.timeout ?? Number(process.env.DOUBAO_TIMEOUT || "60000");
    if (!Number.isSafeInteger(this.timeout) || this.timeout <= 0 || this.timeout > 2_147_483_647) throw configuration();
    this.request = options.fetch ?? fetch;
    this.uploader = new DoubaoUploader(this.cookie, { chatUrl: this.url, userAgent: this.userAgent, fetch: this.request });
  }

  async initialize(): Promise<void> {}

  async chat(request: ChatRequest, previous?: RemoteSession): Promise<DoubaoWebReply> {
    return this.send(request, previous);
  }

  async generateMedia(request: MediaGenerationRequest, previous?: RemoteSession): Promise<DoubaoWebReply> {
    const ability = creationAbility(request);
    const message = request.kind === "image" ? `生成图片：${request.prompt}` : `生成视频：${request.prompt}，${request.durationSeconds ?? 4}s`;
    return this.send({ message, thinking: false, signal: request.signal }, previous, [], ability);
  }

  /** Read the same website history endpoint used by a page reload; never submits a generation. */
  async getMedia(previous: RemoteSession, signal?: AbortSignal): Promise<ProviderResult> {
    validateSession(previous);
    if (this.verificationBlocked) throw captchaError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      controller.signal.throwIfAborted();
      const url = new URL(this.url); url.pathname = "/im/chain/single";
      const response = await this.request(url, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json; encoding=utf-8", "Agw-Js-Conv": "str", Cookie: this.cookie,
          "User-Agent": this.userAgent, "x-tt-passport-csrf-token": this.csrf, Origin: this.url.origin, Referer: "https://www.doubao.com/chat" },
        body: JSON.stringify({ cmd: 3100, uplink_body: { pull_singe_chain_uplink_body: {
          conversation_id: previous.conversationId, anchor_index: Number.MAX_SAFE_INTEGER, conversation_type: 3, direction: 1,
          limit: 20, ext: {}, filter: { index_list: [] }, evaluate_ab_params: "", evaluate_common_params: "", option: { lazy_load_strategy: 0 }
        } }, sequence_id: String(Date.now()), channel: 2, version: "1" }) });
      if (!response.ok) { await response.body?.cancel(); throw httpError(response.status); }
      if (!response.headers.get("content-type")?.startsWith("application/json")) {
        await response.body?.cancel(); throw new DoubaoWebError("invalid_response", "Expected Doubao history JSON");
      }
      const payload = await this.readJSON(response, controller.signal, 2 * 1024 * 1024) as Record<string, any>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new DoubaoWebError("invalid_response", "Invalid Doubao history JSON");
      const failure = businessError(payload);
      if (failure) throw failure;
      if (payload.status_code !== 0 && payload.status_code !== "0") {
        throw businessError({ code: payload.status_code }) ?? new DoubaoWebError("website_error", "Doubao history request failed");
      }
      const messages = payload.downlink_body?.pull_singe_chain_downlink_body?.messages;
      if (!Array.isArray(messages) || messages.length > 20) throw new DoubaoWebError("invalid_response", "Invalid Doubao history");
      const media = [];
      const remote = { ...previous };
      for (const message of messages) {
        if (!message || message.conversation_id !== previous.conversationId) throw new DoubaoWebError("invalid_response", "History conversation mismatch");
        if (message.user_type !== 2) continue;
        const index = typeof message.index_in_conv === "string" && /^\d+$/.test(message.index_in_conv) ? Number(message.index_in_conv) : message.index_in_conv;
        if (!Number.isSafeInteger(index) || index < 0 || !remoteId(message.message_id) || !remoteId(message.section_id) ||
            !Array.isArray(message.content_block)) throw new DoubaoWebError("invalid_response", "Invalid history reply");
        for (const block of message.content_block) {
          if (block?.block_type === 2074) media.push(...creationMedia(block.content?.creation_block));
        }
        if (index > Number(remote.lastMessageIndex)) {
          remote.lastMessageId = message.message_id; remote.lastMessageIndex = index; remote.sectionId = message.section_id;
        } else if (index === remote.lastMessageIndex && message.message_id !== remote.lastMessageId) {
          throw new DoubaoWebError("invalid_response", "Conflicting history reply lineage");
        }
      }
      return { content: "Media from the latest 20 messages in this conversation.", media, remoteSession: remote };
    } catch (error) {
      if (controller.signal.aborted) throw new DoubaoWebError(signal?.aborted ? "cancelled" : "timeout_error", "Doubao history request interrupted");
      if (error instanceof DoubaoWebError) {
        if (error.code === "captcha_required") this.verificationBlocked = true;
        throw new DoubaoWebError(error.code, error.message);
      }
      throw new DoubaoWebError("network_error", "Doubao history transport failed; no automatic retry was performed");
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }

  async analyzeFiles(files: FileInput[], instruction: string, thinking: boolean, signal?: AbortSignal): Promise<DoubaoWebReply> {
    if (!files.length || files.length > 5 || files.reduce((size, file) => size + file.buffer.length, 0) > 20 * 1024 * 1024) {
      throw new DoubaoWebError("invalid_request", "Select up to five TXT files totaling at most 20 MiB");
    }
    if (files.some(file => !/\.txt$/i.test(file.name) || !file.buffer.length || file.buffer.length > 10 * 1024 * 1024)) {
      throw new DoubaoWebError("invalid_file", "Select nonempty TXT files, each at most 10 MiB");
    }
    return this.send({ message: instruction, thinking, signal }, undefined, files);
  }

  private async send(request: ChatRequest, previous?: RemoteSession, files: FileInput[] = [], ability?: ReturnType<typeof creationAbility>): Promise<DoubaoWebReply> {
    if (this.verificationBlocked) throw captchaError();
    if (!request.message.trim()) throw new DoubaoWebError("invalid_request", "Message must not be empty");
    if (previous) validateSession(previous);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const abort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    let sent = false;
    try {
      controller.signal.throwIfAborted();
      const attachments: DoubaoAttachment[] = [];
      for (const file of files) attachments.push(await this.uploader.upload(file, controller.signal));
      const localConversationId = previous ? previous.localConversationId as string : `local_${randomBytes(8).toString("hex")}`;
      const deepThink = request.thinking ? 3 : 0;
      const body = {
        ...(ability ? { chat_ability: ability } : {}),
        client_meta: {
          bot_id: "7338286299411103781", conversation_id: previous?.conversationId ?? "",
          last_message_index: previous?.lastMessageIndex ?? null, last_section_id: previous?.sectionId ?? "",
          local_conversation_id: localConversationId
        },
        messages: [{ local_message_id: randomUUID(), message_status: 0, content_block: [
          ...(attachments.length ? [{ block_type: 10052, block_id: randomUUID(), parent_id: "", meta_info: [], append_fields: [], extra_info: {},
            content: { attachment_block: { attachments }, pc_event_block: "" } }] : []), {
          block_type: 10000, block_id: randomUUID(), parent_id: "", meta_info: [], append_fields: [], extra_info: {},
          content: { pc_event_block: "", text_block: { text: request.systemPrompt ? `${request.systemPrompt}\n\n${request.message}` : request.message,
            icon_url: "", icon_url_dark: "", summary: "" } }
        }] }],
        option: {
          ...(ability ? { general_task_param: { server_do_compare: true } } : { agent_mode: 2 }),
          need_create_conversation: !previous, need_deep_think: deepThink,
          model_config: { model_item_key: ability ? "" : request.thinking ? "3" : "0", model_extra_params: {}, ...(ability ? {} : { reasoning_effort: 4 }) },
          conversation_init_option: { need_ack_conversation: true },
          unique_key: randomUUID(), sse_recv_event_options: { support_chunk_delta: true }
        },
        ext: ability ? { general_task_param: JSON.stringify({ server_do_compare: true }), commerce_credit_config_enable: "0" }
          : { agent_mode: "2", use_deep_think: String(deepThink) }
      };
      sent = true;
      const response = await this.request(this.url, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { Accept: "text/event-stream", "Content-Type": "application/json", Cookie: this.cookie,
          "x-tt-passport-csrf-token": this.csrf, "User-Agent": this.userAgent, "Agw-Js-Conv": "str",
          Origin: "https://www.doubao.com", Referer: "https://www.doubao.com/chat" },
        body: JSON.stringify(body)
      });
      if (!response.ok) { await response.body?.cancel(); throw httpError(response.status); }
      const type = response.headers.get("content-type")?.split(";")[0].trim();
      if (type === "application/json") {
        const payload = await this.readJSON(response, controller.signal);
        throw businessError(payload) ?? new DoubaoWebError("invalid_response", "Expected Doubao SSE, received JSON", true);
      }
      if (type !== "text/event-stream" || !response.body) {
        await response.body?.cancel();
        throw new DoubaoWebError("invalid_response", "Expected Doubao SSE response", true);
      }
      const reply = await parseSSE(response.body, controller.signal, previous?.conversationId as string | undefined);
      if (previous && ((reply.messageIndex !== undefined && reply.messageIndex <= Number(previous.lastMessageIndex)) ||
          (reply.messageId !== undefined && reply.messageId === previous.lastMessageId))) {
        throw new DoubaoWebError("session_state_error", "Doubao reply lineage did not advance; close this conversation explicitly", true);
      }
      return { ...reply, localConversationId };
    } catch (error) {
      if (controller.signal.aborted) throw new DoubaoWebError(request.signal?.aborted ? "cancelled" : "timeout_error",
        request.signal?.aborted ? "Doubao Web request cancelled" : "Doubao Web request timed out", sent);
      if (error instanceof DoubaoWebError) {
        if (error.code === "captcha_required") this.verificationBlocked = true;
        throw error;
      }
      throw new DoubaoWebError("network_error", "Doubao Web transport failed; no automatic retry was performed", sent);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
    }
  }

  private async readJSON(response: Response, signal: AbortSignal, limit = 64 * 1024): Promise<unknown> {
    if (!response.body) throw new DoubaoWebError("invalid_response", "Empty Doubao JSON response", true);
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    let size = 0;
    let text = "";
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new DoubaoWebError("invalid_response", "Oversized Doubao JSON response", true);
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text);
    } catch (error) {
      if (signal.aborted || error instanceof DoubaoWebError) throw error;
      throw new DoubaoWebError("invalid_response", "Invalid Doubao JSON response", true);
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
