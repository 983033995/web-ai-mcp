import { ProviderError } from "../../core/provider.js";

export class DoubaoWebError extends ProviderError {
  constructor(code: string, message: string, sessionUncertain = false) {
    super(message, code, sessionUncertain);
    this.name = "DoubaoWebError";
  }
}

export function authenticationError(sessionUncertain = false): DoubaoWebError {
  return new DoubaoWebError("authentication_error",
    "豆包登录凭据无效或已过期；请在本人账号重新登录并在本机更新 DOUBAO_COOKIE。不要在聊天中发送 Cookie。", sessionUncertain);
}

export function captchaError(sessionUncertain = false): DoubaoWebError {
  return new DoubaoWebError("captcha_required",
    "豆包 HTTP 响应要求人机验证，原网页不一定会显示挑战。此客户端已停止发送消息；通过官方验证界面手动处理后，在本机刷新同一网页请求的完整配置并重启 MCP。网页聊天正常不代表 HTTP 挑战已解除。", sessionUncertain);
}

export function httpError(status: number): DoubaoWebError {
  if (status === 401) return authenticationError();
  const code = status === 403 ? "access_denied" : status === 429 ? "rate_limit_error" : "http_error";
  return new DoubaoWebError(code, `Doubao Web HTTP ${status}; no automatic retry was performed`, status >= 500);
}

export function businessError(value: unknown, accepted = false): DoubaoWebError | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const json = value as Record<string, unknown>;
  const nested = json.error && typeof json.error === "object" && !Array.isArray(json.error)
    ? json.error as Record<string, unknown> : undefined;
  let code = nested?.code ?? json.code ?? json.error_code;
  if (code === "Internal" && typeof json.message === "string") {
    code = json.message.match(/\bcode=(710012001|710012000|710022004)\b/)?.[1] ?? code;
  }
  if ([710012001, 710012000, "710012001", "710012000"].includes(code as number | string)) return authenticationError(accepted);
  if (code === 710022004 || code === "710022004") return captchaError(accepted);
  if (code !== undefined && code !== 0 && code !== "0") {
    return new DoubaoWebError("website_error", "Doubao Web rejected the request; upstream details suppressed", true);
  }
  return undefined;
}
