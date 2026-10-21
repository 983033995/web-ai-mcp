import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, isAbsolute } from "node:path";
import { ProviderError, type ChatRequest, type MediaGenerationRequest, type ProviderResult, type RemoteSession, type WebAIProvider } from "../../core/provider.js";
import { validGeminiAccountId, type GeminiAccountConfig } from "./accounts.js";
import type { GeminiModelCatalog } from "./selection.js";
import { GeminiMediaQuotaError } from "./errors.js";

export type GeminiMediaKind = "image" | "video";

/** Only the Gemini transport should throw this for a definitive pre-acceptance quota rejection. */
export class GeminiQuotaError extends ProviderError {
  readonly kind: GeminiMediaKind;
  readonly resetAtMs?: number;

  constructor(kind: GeminiMediaKind, resetAtMs?: number) {
    super(`Gemini ${kind} generation quota is exhausted`, "quota_exhausted", false);
    this.name = "GeminiQuotaError";
    this.kind = kind;
    if (Number.isSafeInteger(resetAtMs) && resetAtMs! > 0) this.resetAtMs = resetAtMs;
  }
}

export class GeminiCooldownStoreError extends ProviderError {
  constructor() {
    super("Gemini media cooldown state is unavailable; generation is blocked until the local state can be read safely", "cooldown_state_error");
    this.name = "GeminiCooldownStoreError";
  }
}

interface CooldownRecord {
  accountId: string;
  kind: GeminiMediaKind;
  recordedAtMs: number;
  blockedUntilMs: number | null;
  source: "website" | "configured_backoff" | "unknown";
}

interface CooldownFile {
  version: 1;
  records: CooldownRecord[];
}

export interface GeminiCooldownStatus {
  coolingDown: boolean;
  blockedUntilMs: number | null;
  remainingSeconds: number | null;
  source?: CooldownRecord["source"];
}

const MAX_COOLDOWN_FILE_BYTES = 1024 * 1024;
const MAX_LOCK_WAIT_MS = 5000;
const EMPTY_STATE: CooldownFile = { version: 1, records: [] };
const validKind = (value: unknown): value is GeminiMediaKind => value === "image" || value === "video";

function storeError(): GeminiCooldownStoreError { return new GeminiCooldownStoreError(); }

/** Persistent local quota cooldowns. Reads are side-effect free; writes use a cross-process lock and atomic rename. */
export class GeminiCooldownStore {
  constructor(private readonly filePath: string, private readonly now: () => number = Date.now) {
    if (!isAbsolute(filePath)) throw storeError();
  }

  async status(accountId: string, kind: GeminiMediaKind): Promise<GeminiCooldownStatus> {
    const state = await this.readState();
    const record = state.records.find(entry => entry.accountId === accountId && entry.kind === kind);
    if (!record) return { coolingDown: false, blockedUntilMs: null, remainingSeconds: null };
    if (record.blockedUntilMs === null) {
      return { coolingDown: true, blockedUntilMs: null, remainingSeconds: null, source: record.source };
    }
    const remainingMs = record.blockedUntilMs - this.now();
    if (remainingMs <= 0) return { coolingDown: false, blockedUntilMs: record.blockedUntilMs, remainingSeconds: 0, source: record.source };
    return { coolingDown: true, blockedUntilMs: record.blockedUntilMs, remainingSeconds: Math.ceil(remainingMs / 1000), source: record.source };
  }

  async recordQuota(
    accountId: string,
    kind: GeminiMediaKind,
    resetAtMs?: number,
    fallbackMinutes?: number,
  ): Promise<GeminiCooldownStatus> {
    if (!validGeminiAccountId(accountId) || !validKind(kind)) throw storeError();
    return this.withWriteLock(async () => {
      const state = await this.readState();
      const recordedAtMs = this.now();
      const websiteReset = Number.isSafeInteger(resetAtMs) && resetAtMs! > recordedAtMs ? resetAtMs! : undefined;
      const fallbackReset = Number.isFinite(fallbackMinutes) && fallbackMinutes! > 0 &&
        Number.isSafeInteger(recordedAtMs + fallbackMinutes! * 60_000)
        ? recordedAtMs + fallbackMinutes! * 60_000 : undefined;
      const blockedUntilMs = websiteReset ?? fallbackReset ?? null;
      const record: CooldownRecord = {
        accountId, kind, recordedAtMs, blockedUntilMs,
        source: websiteReset ? "website" : fallbackReset ? "configured_backoff" : "unknown",
      };
      const records = state.records.filter(entry => !(entry.accountId === accountId && entry.kind === kind));
      records.push(record);
      await this.writeState({ version: 1, records });
      return this.statusFromRecord(record);
    });
  }

  private statusFromRecord(record: CooldownRecord): GeminiCooldownStatus {
    if (record.blockedUntilMs === null) {
      return { coolingDown: true, blockedUntilMs: null, remainingSeconds: null, source: record.source };
    }
    const remainingMs = record.blockedUntilMs - this.now();
    return {
      coolingDown: remainingMs > 0,
      blockedUntilMs: record.blockedUntilMs,
      remainingSeconds: Math.max(0, Math.ceil(remainingMs / 1000)),
      source: record.source,
    };
  }

  private async readState(): Promise<CooldownFile> {
    let before;
    try { before = await lstat(this.filePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_STATE, records: [] };
      throw storeError();
    }
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_COOLDOWN_FILE_BYTES ||
        (process.platform !== "win32" && (before.mode & 0o077) !== 0)) throw storeError();
    let handle;
    try {
      handle = await open(this.filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch { throw storeError(); }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_COOLDOWN_FILE_BYTES ||
          (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
        throw storeError();
      }
      const data = Buffer.alloc(MAX_COOLDOWN_FILE_BYTES + 1);
      let size = 0;
      while (size < data.length) {
        const { bytesRead } = await handle.read(data, size, data.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > MAX_COOLDOWN_FILE_BYTES) throw storeError();
      const decoded: unknown = JSON.parse(data.subarray(0, size).toString("utf8"));
      if (!this.validState(decoded)) throw storeError();
      return decoded;
    } catch (error) {
      if (error instanceof GeminiCooldownStoreError) throw error;
      throw storeError();
    } finally {
      await handle.close();
    }
  }

  private validState(value: unknown): value is CooldownFile {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const state = value as Partial<CooldownFile>;
    if (Object.keys(value).some(key => key !== "version" && key !== "records") || state.version !== 1 || !Array.isArray(state.records)) return false;
    const seen = new Set<string>();
    for (const item of state.records) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const record = item as CooldownRecord;
      const key = `${record.accountId}/${record.kind}`;
      const validReset = record.source === "unknown"
        ? record.blockedUntilMs === null
        : Number.isSafeInteger(record.blockedUntilMs) && record.blockedUntilMs! > record.recordedAtMs;
      if (Object.keys(item).some(field => !["accountId", "kind", "recordedAtMs", "blockedUntilMs", "source"].includes(field)) ||
          !validGeminiAccountId(record.accountId) || !validKind(record.kind) || !Number.isSafeInteger(record.recordedAtMs) || record.recordedAtMs < 0 ||
          !validReset ||
          !["website", "configured_backoff", "unknown"].includes(record.source) || seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  }

  private async writeState(state: CooldownFile): Promise<void> {
    let tempPath: string | undefined;
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const content = JSON.stringify(state, null, 2) + "\n";
      tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      const handle = await open(tempPath, "wx", 0o600);
      try { await handle.writeFile(content, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(tempPath, this.filePath);
      tempPath = undefined;
    } catch {
      throw storeError();
    } finally {
      if (tempPath) await unlink(tempPath).catch(() => undefined);
    }
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    try { await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 }); }
    catch { throw storeError(); }
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + MAX_LOCK_WAIT_MS;
    let lock;
    while (!lock) {
      try {
        const candidate = await open(lockPath, "wx", 0o600);
        try {
          await candidate.writeFile(JSON.stringify({ pid: process.pid }) + "\n", "utf8");
          await candidate.sync();
          lock = candidate;
        } catch {
          await candidate.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
          throw storeError();
        }
      }
      catch (error) {
        if (error instanceof GeminiCooldownStoreError || (error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw storeError();
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try { return await operation(); }
    finally {
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

export interface GeminiAccountStatus {
  id: string;
  order: number;
  imageGeneration: boolean;
  videoGeneration: boolean;
  cooldown: Record<GeminiMediaKind, GeminiCooldownStatus>;
}

export interface GeminiMediaGenerationRequest extends MediaGenerationRequest {
  /** Persist validated pending lineage while the original generation operation owns follow-up. */
  onPendingSession?: (session: RemoteSession) => void;
}

/** Multi-account adapter. Only a typed, definitive quota rejection may advance the ordered media route. */
export class GeminiAccountProvider implements WebAIProvider {
  readonly id = "gemini";
  readonly displayName = "Gemini Web (experimental HTTP)";
  readonly capabilities;
  private readonly providers = new Map<string, WebAIProvider>();

  constructor(
    private readonly accounts: readonly GeminiAccountConfig[],
    private readonly createProvider: (account: GeminiAccountConfig) => WebAIProvider,
    private readonly cooldowns: GeminiCooldownStore,
    private readonly mediaWait: { timeoutMs: number; pollMs: number } = { timeoutMs: 600_000, pollMs: 10_000 },
  ) {
    if (!accounts.length) throw new ProviderError("Gemini account configuration is empty", "configuration_error");
    if (!Number.isSafeInteger(mediaWait.timeoutMs) || mediaWait.timeoutMs <= 0 || mediaWait.timeoutMs > 600_000 ||
        !Number.isSafeInteger(mediaWait.pollMs) || mediaWait.pollMs <= 0) throw new ProviderError("Invalid Gemini media wait", "configuration_error");
    this.capabilities = this.getProvider(accounts[0]).capabilities;
  }

  async initialize(): Promise<void> {
    await Promise.all(this.accounts.map(account => this.getProvider(account).initialize()));
  }

  async chat(request: ChatRequest, previous?: RemoteSession): Promise<ProviderResult> {
    const account = this.accountFor(previous);
    const result = await this.getProvider(account).chat(request, previous);
    return this.bindSession(result, account);
  }

  async getModels(previous?: RemoteSession, signal?: AbortSignal): Promise<GeminiModelCatalog> {
    const provider = this.getProvider(this.accountFor(previous)) as WebAIProvider & {
      getModels?: (previous?: RemoteSession, signal?: AbortSignal) => Promise<GeminiModelCatalog>;
    };
    if (!provider.getModels) throw new ProviderError("Gemini model discovery is unavailable", "unsupported_capability");
    return provider.getModels(previous, signal);
  }

  async generateMedia(request: GeminiMediaGenerationRequest, previous?: RemoteSession): Promise<ProviderResult> {
    const pinned = previous ? this.accountFor(previous) : undefined;
    const candidates = pinned ? [pinned] : this.accounts;
    const deadline = Date.now() + this.mediaWait.timeoutMs;
    for (const account of candidates) {
      request.signal?.throwIfAborted();
      const cooldown = await this.cooldowns.status(account.id, request.kind);
      if (cooldown.coolingDown) {
        if (pinned) throw new GeminiQuotaError(request.kind, cooldown.blockedUntilMs ?? undefined);
        continue;
      }
      const provider = this.getProvider(account);
      if (!provider.generateMedia) throw new ProviderError("Gemini media generation is unavailable", "unsupported_capability");
      try {
        const result = await provider.generateMedia(request, previous);
        return this.bindSession(await this.awaitMedia(provider, account, request, result, deadline), account);
      } catch (error) {
        if (error instanceof GeminiMediaQuotaError) {
          await this.cooldowns.recordQuota(account.id, error.kind, error.resetAtMs, account.cooldownMinutes?.[error.kind]);
          if (pinned || error.kind !== request.kind || error.sessionUncertain || error.cause || request.signal?.aborted || Date.now() >= deadline) throw error;
          continue;
        }
        if (!(error instanceof GeminiQuotaError) || error.kind !== request.kind || error.sessionUncertain) throw error;
        await this.cooldowns.recordQuota(account.id, request.kind, error.resetAtMs, account.cooldownMinutes?.[request.kind]);
        if (pinned) throw error;
      }
    }
    const earliest = await this.earliestCooldown(candidates, request.kind);
    throw new GeminiQuotaError(request.kind, earliest);
  }

  private async awaitMedia(provider: WebAIProvider, account: GeminiAccountConfig, request: GeminiMediaGenerationRequest,
    initial: ProviderResult, deadline: number): Promise<ProviderResult> {
    let result = this.bindSession(initial, account);
    while (result.remoteSession && result.media?.length &&
        result.media.every(item => item.status === "pending" && !item.url && !item.resourceId) && provider.getMedia) {
      request.onPendingSession?.(result.remoteSession);
      if (Date.now() >= deadline) return { ...result, remoteSession: { ...result.remoteSession, mediaReadOnly: true },
        warning: [result.warning, "The bounded generation wait ended with media still pending. Query this existing key; no further generation or account switch was scheduled."].filter(Boolean).join(" ") };
      try {
        const refreshed = await provider.getMedia(result.remoteSession, request.signal);
        result = this.bindSession(refreshed, account);
        if (!result.media?.length || result.media.some(item => item.status !== "pending" || item.url || item.resourceId)) return result;
      } catch (error) {
        if (error instanceof GeminiMediaQuotaError) throw error;
        if (!(error instanceof ProviderError) || error.code !== "history_not_found") {
          throw new ProviderError("Gemini media confirmation failed; the pending lineage was preserved and no account switch was performed",
            error instanceof ProviderError ? error.code : request.signal?.aborted ? "cancelled" : "network_error", true);
        }
      }
      try { await delay(Math.min(this.mediaWait.pollMs, Math.max(1, deadline - Date.now())), undefined, { signal: request.signal }); }
      catch { throw new ProviderError("Gemini media wait cancelled; no account switch was performed", "cancelled", true); }
    }
    return result;
  }

  async getMedia(previous: RemoteSession, signal?: AbortSignal): Promise<ProviderResult> {
    const account = this.accountFor(previous);
    const provider = this.getProvider(account);
    if (!provider.getMedia) throw new ProviderError("Gemini media status is unavailable", "unsupported_capability");
    try { return this.bindSession(await provider.getMedia(previous, signal), account); }
    catch (error) {
      if (error instanceof GeminiMediaQuotaError) await this.cooldowns.recordQuota(account.id, error.kind, error.resetAtMs, account.cooldownMinutes?.[error.kind]);
      throw error;
    }
  }

  async recoverMedia(conversationId: string, kind: GeminiMediaKind, accountId?: string, signal?: AbortSignal): Promise<ProviderResult> {
    const account = this.accountFor(accountId ? { accountId } : undefined);
    const provider = this.getProvider(account) as WebAIProvider & {
      recoverMedia?: (conversationId: string, kind: GeminiMediaKind, accountId?: string, signal?: AbortSignal) => Promise<ProviderResult>;
    };
    if (!provider.recoverMedia) throw new ProviderError("Media recovery unavailable", "unsupported_capability");
    try { return this.bindSession(await provider.recoverMedia(conversationId, kind, undefined, signal), account); }
    catch (error) {
      if (error instanceof GeminiMediaQuotaError) await this.cooldowns.recordQuota(account.id, error.kind, error.resetAtMs, account.cooldownMinutes?.[error.kind]);
      throw error;
    }
  }

  async fetchMediaForSession(previous: RemoteSession, url: string, init?: RequestInit): Promise<Response> {
    const account = this.accountFor(previous);
    const provider = this.getProvider(account) as WebAIProvider & {
      fetchMedia?: (url: string, init?: RequestInit) => Promise<Response>;
    };
    if (!provider.fetchMedia) throw new ProviderError("Gemini media download is unavailable", "unsupported_capability");
    return provider.fetchMedia(url, init);
  }

  async accountStatus(): Promise<GeminiAccountStatus[]> {
    return Promise.all(this.accounts.map(async (account, index) => {
      const provider = this.getProvider(account);
      const [image, video] = await Promise.all([
        this.cooldowns.status(account.id, "image"), this.cooldowns.status(account.id, "video"),
      ]);
      return {
        id: account.id, order: index + 1,
        imageGeneration: Boolean(provider.capabilities.imageGeneration),
        videoGeneration: Boolean(provider.capabilities.videoGeneration),
        cooldown: { image, video },
      };
    }));
  }

  private getProvider(account: GeminiAccountConfig): WebAIProvider {
    let provider = this.providers.get(account.id);
    if (!provider) {
      provider = this.createProvider(account);
      if (provider.id !== "gemini") throw new ProviderError("Gemini account factory returned an incompatible provider", "configuration_error");
      this.providers.set(account.id, provider);
    }
    return provider;
  }

  private accountFor(session?: RemoteSession): GeminiAccountConfig {
    const accountId = session?.accountId;
    if (typeof accountId === "string") {
      const account = this.accounts.find(candidate => candidate.id === accountId);
      if (!account) throw new ProviderError("Gemini session is bound to an unavailable account; close it explicitly", "session_state_error");
      return account;
    }
    if (session && this.accounts.length !== 1) {
      throw new ProviderError("Gemini session has no account binding; close it explicitly before continuing", "session_state_error");
    }
    return this.accounts[0];
  }

  private bindSession(result: ProviderResult, account: GeminiAccountConfig): ProviderResult {
    return result.remoteSession ? {
      ...result,
      remoteSession: { ...result.remoteSession, accountId: account.id },
    } : result;
  }

  private async earliestCooldown(accounts: readonly GeminiAccountConfig[], kind: GeminiMediaKind): Promise<number | undefined> {
    const statuses = await Promise.all(accounts.map(account => this.cooldowns.status(account.id, kind)));
    const expirations = statuses.filter(status => status.coolingDown && status.blockedUntilMs !== null)
      .map(status => status.blockedUntilMs!);
    return expirations.length ? Math.min(...expirations) : undefined;
  }
}
