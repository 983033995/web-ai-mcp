import { ProviderError } from "../../core/provider.js";

export class GeminiWebError extends ProviderError {
  constructor(code: string, message: string, sessionUncertain = false) {
    super(message, code, sessionUncertain);
    this.name = "GeminiWebError";
  }
}

/** Validated identifiers only; never includes the failed stream, prompt or resource URLs. */
export class GeminiMediaRecoveryError extends GeminiWebError {
  constructor(error: GeminiWebError, readonly lineage: { conversationId: string; replyId: string; candidateId?: string }) {
    super(error.code, error.message, true);
  }
}

/** Definitive completed quota rejection. Only the owning generation operation may route onward. */
export class GeminiMediaQuotaError extends GeminiWebError {
  constructor(readonly kind: "image" | "video", readonly resetAtMs?: number) {
    super("media_quota_exhausted", "The website explicitly ended this media reply without a resource because its generation quota is exhausted");
  }
}

export const configurationError = () => new GeminiWebError("configuration_error",
  "Configure GEMINI_COOKIE and GEMINI_USER_AGENT from your own Gemini Web session; never share credentials.");

export const authenticationError = (uncertain = false) => new GeminiWebError("authentication_error",
  "Gemini Web is not signed in with a usable account. Refresh the own-account login in a browser and update local credentials; do not send cookies in chat.", uncertain);

/** Exact website failure notice observed in an otherwise complete text candidate. */
export function assertGeminiAnswer(content: string): void {
  if (content.trim() === "Sorry, something went wrong. Please try your request again.") {
    throw new GeminiWebError("website_error", "Gemini returned its website failure notice instead of an answer; no automatic retry was performed", true);
  }
}

export const captchaError = (uncertain = false) => new GeminiWebError("captcha_required",
  "Gemini Web requested an account or traffic verification. This client has stopped sending messages; complete the official verification manually, refresh the local web session, and restart the MCP.", uncertain);

export function httpError(status: number, writeSent: boolean): GeminiWebError {
  if (status === 401) return authenticationError();
  const code = status === 403 ? "access_denied" : status === 429 ? "rate_limit_error"
    : status >= 300 && status < 400 ? "redirect_blocked" : "http_error";
  return new GeminiWebError(code, `Gemini Web HTTP ${status}; no automatic retry was performed`,
    writeSent && (status >= 500 || status >= 300 && status < 400));
}
