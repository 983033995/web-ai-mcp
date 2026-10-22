import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ProviderError } from "../../core/provider.js";

export interface GeminiAccountConfig {
  id: string;
  cookie: string;
  userAgent: string;
  cooldownMinutes?: Partial<Record<"image" | "video", number>>;
}

const MAX_ACCOUNTS_FILE_BYTES = 1024 * 1024;
/** Local aliases remain supported; owners may explicitly use their account email as the ID. */
export const GEMINI_ACCOUNT_ID_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}|[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)(?![\s\S])/;
export const validGeminiAccountId = (value: unknown): value is string => typeof value === "string" &&
  value.length <= 254 && GEMINI_ACCOUNT_ID_PATTERN.test(value);
const ownSessionCookie = (value: string): boolean => !/[\r\n]/.test(value) && value.split(";").some(part => {
  const index = part.indexOf("=");
  return index > 0 && part.slice(0, index).trim() === "__Secure-1PSID" && part.slice(index + 1).trim().length > 0;
});

function configurationError(): ProviderError {
  return new ProviderError("Gemini account configuration is invalid; check the private account file or legacy cookie and user-agent settings", "configuration_error");
}

function validateAccount(value: unknown): GeminiAccountConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "browserChatSpaceId")) {
    throw new ProviderError("Gemini no longer uses browser task spaces; remove browserChatSpaceId from the private account file", "configuration_error");
  }
  if (Object.keys(record).some(key => !["id", "cookie", "userAgent", "cooldownMinutes"].includes(key))) return undefined;
  if (!validGeminiAccountId(record.id) || typeof record.cookie !== "string" || record.cookie.length > 64 * 1024 || !ownSessionCookie(record.cookie) ||
      typeof record.userAgent !== "string" || !record.userAgent.trim() || record.userAgent.length > 1024 || /[\r\n\u0000]/.test(record.userAgent)) return undefined;

  let cooldownMinutes: GeminiAccountConfig["cooldownMinutes"];
  if (record.cooldownMinutes !== undefined) {
    if (!record.cooldownMinutes || typeof record.cooldownMinutes !== "object" || Array.isArray(record.cooldownMinutes)) return undefined;
    const settings = record.cooldownMinutes as Record<string, unknown>;
    if (Object.keys(settings).some(key => key !== "image" && key !== "video")) return undefined;
    cooldownMinutes = {};
    for (const kind of ["image", "video"] as const) {
      const value = settings[kind];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 525_600) return undefined;
      cooldownMinutes[kind] = value;
    }
  }
  return { id: record.id, cookie: record.cookie, userAgent: record.userAgent, ...(cooldownMinutes ? { cooldownMinutes } : {}) };
}

async function readPrivateAccountsFile(filePath: string): Promise<unknown> {
  if (!isAbsolute(filePath)) throw configurationError();
  let before;
  try { before = await lstat(filePath); }
  catch { throw configurationError(); }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_ACCOUNTS_FILE_BYTES ||
      (process.platform !== "win32" && (before.mode & 0o077) !== 0)) throw configurationError();

  let handle;
  try { handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); }
  catch { throw configurationError(); }
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size > MAX_ACCOUNTS_FILE_BYTES ||
        (process.platform !== "win32" && (current.mode & 0o077) !== 0)) throw configurationError();
    const buffer = Buffer.alloc(MAX_ACCOUNTS_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_ACCOUNTS_FILE_BYTES) throw configurationError();
    try { return JSON.parse(buffer.subarray(0, size).toString("utf8")) as unknown; }
    catch { throw configurationError(); }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw configurationError();
  } finally {
    await handle.close();
  }
}

/** Load ordered own-account credentials from a private file or the single-account legacy environment. */
export async function loadGeminiAccounts(env: NodeJS.ProcessEnv = process.env): Promise<GeminiAccountConfig[]> {
  const filePath = env.GEMINI_ACCOUNTS_FILE;
  const legacyCookie = env.GEMINI_COOKIE;
  const legacyUserAgent = env.GEMINI_USER_AGENT;
  const hasLegacy = Boolean(legacyCookie || legacyUserAgent);
  if (filePath) {
    if (hasLegacy) throw configurationError();
    const decoded = await readPrivateAccountsFile(filePath);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || Object.keys(decoded).some(key => key !== "accounts")) {
      throw configurationError();
    }
    const rawAccounts = (decoded as { accounts?: unknown }).accounts;
    if (!Array.isArray(rawAccounts) || rawAccounts.length < 1 || rawAccounts.length > 32) throw configurationError();
    const accounts = rawAccounts.map(validateAccount);
    if (accounts.some(account => !account)) throw configurationError();
    const loaded = accounts as GeminiAccountConfig[];
    if (new Set(loaded.map(account => account.id.includes("@") ? account.id.toLowerCase() : account.id)).size !== loaded.length) throw configurationError();
    return loaded;
  }
  if (!legacyCookie && !legacyUserAgent) return [];
  if (!legacyCookie || !legacyUserAgent) throw configurationError();
  const account = validateAccount({ id: "default", cookie: legacyCookie, userAgent: legacyUserAgent });
  if (!account) throw configurationError();
  return [account];
}
