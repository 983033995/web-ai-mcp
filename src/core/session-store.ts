import { randomUUID } from "node:crypto";
import type { RemoteSession } from "./provider.js";

export interface SessionRecord {
  key: string;
  providerId: string;
  remote: RemoteSession;
  title: string;
  createdAt: number;
  lastUsedAt: number;
}

/** In-memory, local-process session state; no credentials are stored here. */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly busy = new Set<string>();
  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  put(input: Omit<SessionRecord, "key" | "createdAt" | "lastUsedAt">): SessionRecord {
    const time = this.now();
    const result: SessionRecord = {
      ...input, key: randomUUID(), createdAt: time, lastUsedAt: time
    };
    this.sessions.set(result.key, result);
    return result;
  }

  require(key: string, providerId: string): SessionRecord {
    const record = this.sessions.get(key);
    if (!record || this.now() - record.lastUsedAt > this.ttlMs) {
      this.sessions.delete(key);
      throw new Error("Session missing or expired: start a new chat without session_key");
    }
    if (record.providerId !== providerId) throw new Error("Session belongs to another provider");
    return record;
  }

  update(key: string, remote: RemoteSession): void {
    const record = this.sessions.get(key);
    if (!record) throw new Error("Session was removed during request");
    record.remote = remote;
    record.lastUsedAt = this.now();
  }

  /** Fail rather than create multiple competing parent-message pointers. */
  async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(key)) throw new Error("Session is busy; retry later");
    this.busy.add(key);
    try { return await fn(); }
    finally { this.busy.delete(key); }
  }

  list(): Array<Omit<SessionRecord, "remote">> {
    for (const [key, record] of this.sessions) {
      if (this.now() - record.lastUsedAt > this.ttlMs) this.sessions.delete(key);
    }
    return Array.from(this.sessions.values(), ({ remote: _remote, ...safe }) => safe);
  }

  delete(key: string): boolean {
    if (this.busy.has(key)) throw new Error("Session is busy; cannot remove");
    return this.sessions.delete(key);
  }
}
