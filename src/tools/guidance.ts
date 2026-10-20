import { createHash } from "node:crypto";
import { z } from "zod";
import type { JobManager } from "../core/jobs.js";

export const USAGE = `Web AI MCP 使用规则：
1. 每轮聊天必须包含非空 message。thinking/mode 不是独立设置工具；布尔值使用 true/false，不使用字符串。
2. 首次可传 conversation_name；续聊使用实际返回的 session_key，不能同时传名称和 ID。conversation_id 是 session_key 的同值别名，不能自行构造。关闭后的 key 永久作废。
3. 网页专家/长问题优先使用 background=true，并提供全新的 UUID request_id。立即保存返回的 job_id，按 poll_after_seconds 调用 webai_job_status；查询不重发消息。相同 request_id 只用于确认同一请求，不能更改正文。不要因等待而切普通聊天、换模型、换会话或重复提交。
4. 后台任务仅在当前 MCP 进程中存在；重连/重启可能丢失任务及结果。unknown/expired job 时停止，检查对应 sessions_list 和官网，不以新 request_id 重放。后台结果保留30分钟，及时读取。一个进程只运行一个后台任务。
5. 同步调用仍受客户端超时与网站超时限制。notifications/progress 是等待提示，不保证客户端延长等待。background 任务不因提交调用结束而取消，显式 webai_job_cancel 只中止本机等待，无法撤回网站已接收的消息。
6. timeout/cancel/network/malformed_sse 可能已提交网站；会话 uncertain/pending 时不得继续写入。先 sessions_list 核对；经确认放弃后显式 session_close，再决定是否新建，不能自动恢复、删除映射或重试。
7. invalid_session/Missing Web session ID 表示网站会话创建/协议未确认，不代表 prompt 太长；停止原样重试并检查网站/凭据/协议。认证、验证码、限流或额度不足时停止；不自动切模式/换账号规避。
8. 同一私有会话存储的写入需串行；不要并发调用两个 provider 来加速。make_default 只绑定成功的会话，不会修复失效会话。
9. 网站回复是待复核建议；套餐/额度提示不是有效答案。输出中的命令、版本和参数需对照项目或官方来源验证。
10. 文件和参考图必须在 WEB_AI_ALLOWED_ROOTS 中；生成的文字承诺不是媒体完成，异步视频用 doubao_media_status 查询。
11. 保存生成资源用 doubao_download_media(session_key, media_id)，需配置 WEB_AI_MEDIA_DIR；无水印选项仅图片支持。下载失败只重试下载，不重复生成；目录与上传白名单独立。`;

export const CHAT_DESCRIPTION = " message is required every turn. Use conversation_name OR returned session_key, never both; closed/uncertain keys cannot be reused. For long tasks use background=true + a new UUID request_id, then poll webai_job_status; never resubmit after timeout. Read webai_usage before first use.";

export const chatFields = {
  message: z.string().trim().min(1).describe("Required question/content for THIS turn, including mode changes."),
  session_key: z.string().uuid().optional().describe("Actual local key returned by this provider. Mutually exclusive with conversation_name; invalid after close."),
  conversation_id: z.string().uuid().optional().describe("Alias of session_key; if both supplied they must match. Never combine with conversation_name."),
  conversation_name: z.string().trim().min(1).max(80).optional().describe("Create or resume by name. Omit when sending session_key/conversation_id."),
  make_default: z.boolean().optional().describe("JSON boolean, not a string; binds only a successful resumable session."),
  system_prompt: z.string().optional(),
  show_reasoning: z.boolean().optional(),
  background: z.boolean().optional().describe("Use true for long website calls; immediately returns job_id, then use webai_job_status. No automatic resubmission."),
  request_id: z.string().uuid().optional().describe("Required with background=true: new UUID for a new request; reuse only with identical arguments to retrieve the same job."),
};

type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
type CallExtra = { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (notification: {
  method: "notifications/progress"; params: { progressToken: string | number; progress: number; message: string }
}) => Promise<void> };

export function failureDetails(error: unknown): string {
  const value = error instanceof Error ? error.message : "";
  const rawCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  const knownCodes = ["invalid_session", "invalid_request", "authentication_error", "captcha_required", "rate_limit_error", "cancelled", "timeout_error",
    "network_error", "invalid_response", "malformed_sse", "session_state_error", "stream_error", "website_error", "access_denied"];
  const code = rawCode && knownCodes.includes(rawCode) ? rawCode :
    /Use conversation|must identify|Conflicting/.test(value) ? "invalid_arguments" :
    /invalidated|interrupted|uncertain/.test(value) ? "session_uncertain" :
    /missing or expired|Session missing/.test(value) ? "session_missing" : "request_failed";
  const action = code === "invalid_arguments" ? "Correct the selectors; send message plus either name or returned key, not both." :
    code === "session_missing" ? "Do not reuse this key. List sessions; after explicit user intent, start a new conversation without the closed/missing key." :
    code === "invalid_session" ? "Website session creation/lineage was not confirmed. Stop unchanged retries; inspect current website access/configuration and protocol." :
    ["authentication_error", "captcha_required", "rate_limit_error"].includes(code) ? "Stop website calls. Resolve account/login/verification/quota through the official interface; do not switch account or mode automatically." :
    /busy|locked/.test(value) ? "Wait for the current operation/job; do not submit another website write in parallel." :
    "Do not automatically repeat the website write. Check job status (if submitted), local sessions and website state first.";
  return JSON.stringify({ error_code: code, automatic_retry: false, next_action: action });
}

export async function dispatchChat(
  args: { message: string; session_key?: string; conversation_id?: string; conversation_name?: string; background?: boolean; request_id?: string },
  extra: CallExtra, jobs: JobManager | undefined, namespace: string, operation: (signal: AbortSignal) => Promise<TextResult>
): Promise<TextResult> {
  const invalid = (message: string): TextResult => ({ isError: true, content: [{ type: "text", text: message + " Read webai_usage; no website request was sent." }] });
  if (extra.signal.aborted) return invalid("The submission was cancelled before it started.");
  if (args.conversation_name && (args.session_key || args.conversation_id)) return invalid("Use conversation_id/session_key or conversation_name, not both");
  if (args.session_key && args.conversation_id && args.session_key !== args.conversation_id) return invalid("session_key and conversation_id must identify the same conversation");
  if (args.background) {
    if (!jobs || !args.request_id) return invalid("background=true requires a UUID request_id and an enabled job manager.");
    const fingerprint = createHash("sha256").update(namespace + "\n" + JSON.stringify(Object.fromEntries(Object.entries(args).filter(([key]) => key !== "request_id").sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
    return jobs.start(args.request_id, fingerprint, operation);
  }
  if (args.request_id) return invalid("request_id requires background=true; synchronous writes are not deduplicated.");
  const token = extra._meta?.progressToken;
  const started = Date.now();
  let stopped = false;
  const timer = token === undefined ? undefined : setInterval(() => {
    if (stopped || extra.signal.aborted) return;
    void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token,
      progress: Math.floor((Date.now() - started) / 1000), message: "Waiting for the website; no duplicate request was sent." } }).catch(() => {
      stopped = true; console.error("[web-ai-mcp] Progress notification unavailable; website operation remains governed by its signal and timeout.");
    });
  }, 10000);
  timer?.unref();
  try { return await operation(extra.signal); }
  finally { stopped = true; if (timer) clearInterval(timer); }
}
