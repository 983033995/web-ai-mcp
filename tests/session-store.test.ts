import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SessionStore } from "../src/core/session-store.js";

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
