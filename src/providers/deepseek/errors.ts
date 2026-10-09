import { ProviderError } from "../../core/provider.js";

export class DeepSeekWebError extends ProviderError {
  constructor(code: string, message: string, sessionUncertain = false) {
    super(message, code, sessionUncertain);
    this.name = "DeepSeekWebError";
  }
}

export function httpError(status: number): DeepSeekWebError {
  const code = status === 401 ? "authentication_error"
    : status === 403 ? "access_denied"
    : status === 429 ? "rate_limit_error" : "http_error";
  // Do not echo upstream bodies: they may contain credentials, IDs or messages.
  if (status === 401) return authenticationError();
  return new DeepSeekWebError(code, `DeepSeek Web HTTP ${status}; check website access and own-account token`);
}

export function authenticationError(): DeepSeekWebError {
  return new DeepSeekWebError("authentication_error",
    "DeepSeek 登录凭据无效或已过期。请在本人账号重新登录 DeepSeek 网站，更新本机 DEEPSEEK_USER_TOKEN，然后重启 MCP 服务。不要在聊天中发送 token；已保存的 conversation_id 可在同一账号更新凭据后继续使用。");
}

/** 40003 was observed with an invalid token at chat_session/create (HTTP 200). */
export function isAuthenticationCode(code: unknown): boolean { return code === 40003; }
