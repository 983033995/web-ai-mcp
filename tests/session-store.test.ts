import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SessionStore } from "../src/core/session-store.js";
import { sessionTtlMs } from "../src/core/session-store.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

test("session expiry and provider ownership", () => {
  let now = 1000;
  const store = new SessionStore(100, () => now);
  const session = store.put({
    providerId: "deepseek",
    remote: { sessionId: "s1", lastMessageId: 9 },
    title: "test"
  });
  assert.equal(store.require(session.key, "deepseek").remote.lastMessageId, 9);
  assert.throws(() => store.require(session.key, "doubao"), /another provider/);
  now += 101;
  assert.throws(() => store.require(session.key, "deepseek"), /expired/);
});

test("concurrent calls to same session are rejected", async () => {
  const store = new SessionStore();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = store.exclusive("key", async () => { await gate; return 1; });
  await assert.rejects(store.exclusive("key", async () => 2), /busy/);
  release();
  assert.equal(await first, 1);
  assert.equal(await store.exclusive("key", async () => 3), 3);
});

test("listing cannot evict a busy session whose TTL expires during a turn", async () => {
  let now = 0;
  const store = new SessionStore(10, () => now);
  const session = store.put({ providerId: "deepseek", remote: { lastMessageId: 1 }, title: "test" });
  await store.exclusive(session.key, async () => {
    store.require(session.key, "deepseek");
    now = 11;
    assert.equal(store.list().length, 1);
    assert.throws(() => store.delete(session.key), /busy/);
    store.update(session.key, { lastMessageId: 2 });
  });
  assert.equal(store.require(session.key, "deepseek").remote.lastMessageId, 2);
});

test("default and zero TTL never expire; invalid settings fail explicitly", () => {
  assert.equal(sessionTtlMs(undefined), 0);
  assert.equal(sessionTtlMs("0"), 0);
  assert.equal(sessionTtlMs("60"), 3_600_000);
  for (const value of ["-1", "bad", "Infinity"]) assert.throws(() => sessionTtlMs(value), /TTL/);
  let now = 0;
  const store = new SessionStore(0, () => now);
  const session = store.put({ providerId: "deepseek", remote: { sessionId: "s", lastMessageId: 1 }, title: "not persisted" });
  now = 100 * 365 * 24 * 60 * 60_000;
  assert.equal(store.require(session.key, "deepseek").key, session.key);
});

test("disk lineage and project default survive restart without storing messages", async (t) => {
  const dir = mkdtempSync(resolve(".validation-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "sessions.json");
  const store = new SessionStore(0, Date.now, path);
  const session = store.put({ providerId: "deepseek", remote: { sessionId: "upstream-id", lastMessageId: 2 }, name: "project-discussion", title: "private message that must not be saved" });
  store.selectDefault(session.key, "deepseek");
  const restart = new SessionStore(0, Date.now, path);
  assert.equal(restart.defaultKey(), session.key);
  assert.equal(restart.named("project-discussion", "deepseek")?.key, session.key);
  assert.equal(restart.require(session.key, "deepseek").remote.lastMessageId, 2);
  assert.ok(!readFileSync(path, "utf8").includes("private message"));
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  await store.exclusive(session.key, async () => {
    store.beginTurn(session.key);
    await assert.rejects(restart.exclusive(session.key, async () => 1), /locked/);
    assert.throws(() => restart.delete(session.key), /locked/);
    assert.throws(() => store.delete(session.key), /busy/);
    store.update(session.key, { sessionId: "upstream-id", lastMessageId: 3 });
  });
  assert.equal(restart.require(session.key, "deepseek").remote.lastMessageId, 3);
  restart.delete(session.key);
  assert.equal(new SessionStore(0, Date.now, path).defaultKey(), undefined);
});

test("interrupted pending turns and invalidated names remain blocked across restart", async (t) => {
  const dir = mkdtempSync(resolve(".validation-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "sessions.json");
  const store = new SessionStore(0, Date.now, path);
  const record = store.put({ providerId: "deepseek", remote: { sessionId: "s", lastMessageId: 1 }, name: "fixed", title: "test" });
  store.beginTurn(record.key);
  const restart = new SessionStore(0, Date.now, path);
  assert.throws(() => restart.require(record.key, "deepseek"), /invalidated/);
  assert.throws(() => restart.named("fixed", "deepseek"), /invalidated/);
  restart.delete(record.key);
  assert.equal(restart.named("fixed", "deepseek"), undefined);
  const invalid = restart.put({ providerId: "deepseek", remote: { lastMessageId: 1 }, name: "invalid", title: "test" });
  restart.invalidate(invalid.key);
  assert.throws(() => new SessionStore(0, Date.now, path).named("invalid", "deepseek"), /invalidated/);
});

test("default private store protects itself from accidental Git inclusion", (t) => {
  const dir = mkdtempSync(resolve(".validation-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, ".web-ai-mcp", "sessions.json");
  const store = new SessionStore(0, Date.now, path);
  store.put({ providerId: "deepseek", remote: { sessionId: "s", optional: undefined }, title: "private" });
  assert.equal(readFileSync(join(dir, ".web-ai-mcp", ".gitignore"), "utf8"), "*\n");
  assert.equal(new SessionStore(0, Date.now, path).list().length, 1);
});

test("corrupt session files are preserved and never replaced with an empty store", (t) => {
  const dir = mkdtempSync(resolve(".validation-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "sessions.json");
  writeFileSync(path, "broken fixture");
  assert.throws(() => new SessionStore(0, Date.now, path), /Invalid session store/);
  assert.equal(readFileSync(path, "utf8"), "broken fixture");
});
