import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { RemoteSession } from "./provider.js";

export interface SessionRecord {
  key: string;
  providerId: string;
  remote: RemoteSession;
  title: string;
  name?: string;
  state?: "active" | "pending" | "uncertain";
  createdAt: number;
  lastUsedAt: number;
}

const recordSchema = z.object({
  key: z.string().uuid(), providerId: z.string().min(1),
  remote: z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.undefined()])),
  name: z.string().min(1).max(80).optional(), state: z.enum(["active", "pending", "uncertain"]),
  createdAt: z.number().finite().nonnegative(), lastUsedAt: z.number().finite().nonnegative()
}).strict();
const diskSchema = z.object({ version: z.literal(1), defaultSessionKey: z.string().uuid().optional(), sessions: z.array(recordSchema) }).strict();

export function sessionTtlMs(value: string | undefined): number {
  const minutes = value === undefined || value.trim() === "" ? 0 : Number(value);
  if (!Number.isFinite(minutes) || minutes < 0 || !Number.isFinite(minutes * 60_000)) {
    throw new Error("WEB_AI_SESSION_TTL_MINUTES must be 0 (no expiry) or a positive number");
  }
  return minutes * 60_000;
}

/** Disk stores lineage only: never tokens, messages, file contents or message-derived titles. */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly busy = new Set<string>();
  private diskLocked = false;
  private defaultSessionKey?: string;
  constructor(
    private readonly ttlMs = 0,
    private readonly now: () => number = Date.now,
    private readonly filePath?: string,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error("Invalid session TTL");
    if (filePath) {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      if (lstatSync(dirname(filePath)).isSymbolicLink()) throw new Error("Session directory must not be a symlink");
      if (basename(dirname(filePath)) === ".web-ai-mcp") {
        try { writeFileSync(join(dirname(filePath), ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      this.load();
    }
  }

  private expired(record: SessionRecord): boolean {
    return this.ttlMs > 0 && this.now() - record.lastUsedAt >= this.ttlMs;
  }

  private load(): void {
    if (!this.filePath) return;
    if (!existsSync(this.filePath)) { this.sessions.clear(); this.defaultSessionKey = undefined; return; }
    const stat = lstatSync(this.filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Session store must be an ordinary file");
    let data: z.infer<typeof diskSchema>;
    try { data = diskSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8"))); }
    catch { throw new Error("Invalid session store; preserve it and repair or choose another WEB_AI_SESSION_STORE_PATH"); }
    const keys = new Set<string>();
    const names = new Set<string>();
    for (const record of data.sessions) {
      const name = record.name ? record.providerId + ":" + record.name : undefined;
      if (keys.has(record.key) || (name && names.has(name))) throw new Error("Duplicate session IDs or names in session store");
      keys.add(record.key); if (name) names.add(name);
    }
    if (data.defaultSessionKey && !keys.has(data.defaultSessionKey)) throw new Error("Default conversation is missing from session store");
    this.sessions.clear();
    for (const record of data.sessions) this.sessions.set(record.key, { ...record, title: record.name ?? "Website conversation" });
    this.defaultSessionKey = data.defaultSessionKey;
  }

  private persist(): void {
    if (!this.filePath) return;
    const temporary = this.filePath + "." + randomUUID() + ".tmp";
    const sessions = Array.from(this.sessions.values(), ({ title: _title, ...record }) => ({ ...record, state: record.state ?? "active" }));
    const data = diskSchema.parse({ version: 1, defaultSessionKey: this.defaultSessionKey, sessions });
    try {
      writeFileSync(temporary, JSON.stringify(data, null, 2), { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.filePath);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }

  private acquire(): () => void {
    if (!this.filePath) return () => {};
    if (this.diskLocked) throw new Error("Project conversation store is busy; retry later");
    const lockPath = this.filePath + ".lock";
    let fd: number;
    try { fd = openSync(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Project conversation store is locked. If a previous MCP process crashed, confirm it has stopped before removing the .lock file");
      }
      throw error;
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); this.load(); }
    catch (error) { closeSync(fd); unlinkSync(lockPath); throw error; }
    this.diskLocked = true;
    return () => { this.diskLocked = false; closeSync(fd); unlinkSync(lockPath); };
  }

  private mutate<T>(fn: () => T): T {
    const release = this.diskLocked ? () => {} : this.acquire();
    try { const result = fn(); this.persist(); return result; }
    catch (error) { if (this.filePath) this.load(); throw error; }
    finally { release(); }
  }

  put(input: Omit<SessionRecord, "key" | "createdAt" | "lastUsedAt">): SessionRecord {
    return this.mutate(() => {
      if (input.name && Array.from(this.sessions.values()).some((r) => r.providerId === input.providerId && r.name === input.name)) {
        throw new Error("Conversation name already exists");
      }
      const time = this.now();
      const result: SessionRecord = { ...input, state: input.state ?? "active", key: randomUUID(), createdAt: time, lastUsedAt: time };
      this.sessions.set(result.key, result);
      return result;
    });
  }

  require(key: string, providerId: string): SessionRecord {
    if (!this.diskLocked) this.load();
    const record = this.sessions.get(key);
    if (!record || this.expired(record)) throw new Error("Session missing or expired: start a new chat without session_key/conversation_id");
    if (record.providerId !== providerId) throw new Error("Session belongs to another provider");
    if (record.state === "pending" || record.state === "uncertain") {
      throw new Error("Session invalidated after an interrupted or uncertain request; close it explicitly before starting another conversation");
    }
    return record;
  }

  named(name: string, providerId: string): SessionRecord | undefined {
    if (!this.diskLocked) this.load();
    const found = Array.from(this.sessions.values()).find((r) => r.providerId === providerId && r.name === name);
    return found ? this.require(found.key, providerId) : undefined;
  }

  defaultKey(): string | undefined { if (!this.diskLocked) this.load(); return this.defaultSessionKey; }
  selectDefault(key: string, providerId: string): void {
    this.mutate(() => { this.require(key, providerId); this.defaultSessionKey = key; });
  }

  beginTurn(key: string): void {
    this.mutate(() => {
      const record = this.sessions.get(key);
      if (!record) throw new Error("Session missing");
      record.state = "pending";
    });
  }
  cancelTurn(key: string): void {
    this.mutate(() => { const record = this.sessions.get(key); if (record) record.state = "active"; });
  }
  update(key: string, remote: RemoteSession): void {
    this.mutate(() => {
      const record = this.sessions.get(key);
      if (!record) throw new Error("Session was removed during request");
      record.remote = remote; record.state = "active"; record.lastUsedAt = this.now();
    });
  }

  /** The disk lease spans the upstream write, so separate MCP processes cannot branch lineage. */
  async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(key)) throw new Error("Session is busy; retry later");
    const release = this.acquire();
    this.busy.add(key);
    try { return await fn(); }
    finally { this.busy.delete(key); release(); }
  }

  list(): Array<Omit<SessionRecord, "remote">> {
    if (!this.diskLocked) this.load();
    return Array.from(this.sessions.values()).filter((r) => this.busy.has(r.key) || !this.expired(r))
      .map(({ remote: _remote, ...safe }) => safe);
  }
  delete(key: string): boolean {
    if (this.busy.has(key)) throw new Error("Session is busy; cannot remove");
    const inFlight = this.diskLocked || this.busy.size > 0;
    return this.mutate(() => {
      if (inFlight && this.sessions.get(key)?.state === "pending") throw new Error("Session is busy; cannot remove");
      if (this.defaultSessionKey === key) this.defaultSessionKey = undefined;
      return this.sessions.delete(key);
    });
  }
  invalidate(key: string): void {
    this.mutate(() => { const record = this.sessions.get(key); if (record) record.state = "uncertain"; });
  }
}
