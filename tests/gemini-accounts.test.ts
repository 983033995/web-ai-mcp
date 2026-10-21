import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderError, type MediaGenerationRequest, type ProviderResult, type RemoteSession, type WebAIProvider } from "../src/core/provider.js";
import { loadGeminiAccounts, validGeminiAccountId, type GeminiAccountConfig } from "../src/providers/gemini/accounts.js";
import { GeminiAccountProvider, GeminiCooldownStore, GeminiQuotaError, type GeminiMediaGenerationRequest } from "../src/providers/gemini/cooldown.js";
import { GeminiMediaQuotaError } from "../src/providers/gemini/errors.js";
import { registerProviders } from "../src/providers/index.js";
import { ProviderRegistry } from "../src/core/registry.js";

const account = (id: string, cooldownMinutes?: GeminiAccountConfig["cooldownMinutes"]): GeminiAccountConfig => ({
  id, cookie: `__Secure-1PSID=${id}-secret`, userAgent: "Fixture Browser/1.0", ...(cooldownMinutes ? { cooldownMinutes } : {}),
});

async function tempDir(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "gemini-account-test-"));
  t.after(async () => rm(path, { recursive: true, force: true }));
  return path;
}

function fakeProvider(id: string, calls: string[], script: (request: MediaGenerationRequest, previous?: RemoteSession) => Promise<ProviderResult> | ProviderResult = () => ({ content: "ok" }), chatFailure?: Error): WebAIProvider {
  return {
    id: "gemini", displayName: `fake-${id}`,
    capabilities: { chat: true, thinking: false, files: false, webSearch: false, sessionResume: true, imageGeneration: true, videoGeneration: true },
    async initialize() {},
    async chat(_request, previous) {
      calls.push(`chat:${id}:${String(previous?.accountId ?? "new")}`);
      if (chatFailure) throw chatFailure;
      return { content: `chat:${id}`, remoteSession: previous ?? { conversationId: `conversation-${id}`, accountHash: `${id}-hash` } };
    },
    async generateMedia(request, previous) {
      calls.push(`${request.kind}:${id}:${String(previous?.accountId ?? "new")}`);
      return script(request, previous);
    },
    async getMedia(previous) {
      calls.push(`status:${id}:${String(previous.accountId)}`);
      return { content: "status", remoteSession: previous };
    },
  };
}

function accountProvider(
  configs: GeminiAccountConfig[],
  cooldowns: GeminiCooldownStore,
  calls: string[],
  scripts: Record<string, (request: MediaGenerationRequest, previous?: RemoteSession) => Promise<ProviderResult> | ProviderResult> = {},
): GeminiAccountProvider {
  return new GeminiAccountProvider(configs, config => fakeProvider(config.id, calls, scripts[config.id]), cooldowns);
}

const request = (kind: "image" | "video"): MediaGenerationRequest => ({ kind, prompt: "ordinary fixture prompt" });

test("credential refresh is applied to the same account between operations without replay or cooldown loss", async t => {
  const root = await tempDir(t), calls: string[] = [], created: string[] = [];
  const store = new GeminiCooldownStore(join(root, "cooldowns.json"), () => 100000);
  await store.recordQuota("first", "video", 200000);
  let configs = [account("first"), account("second")];
  const provider = new GeminiAccountProvider(configs, config => {
    created.push(config.cookie);
    return fakeProvider(config.id, calls, undefined,
      config.cookie === account("first").cookie ? new ProviderError("expired", "authentication_error") : undefined);
  }, store, undefined, async id => configs.find(a => a.id === id)!);
  await provider.initialize();
  await assert.rejects(provider.chat({ message: "first", thinking: false }), (e: any) => e.code === "authentication_error");
  assert.deepEqual(calls, ["chat:first:new"]);
  configs = [{ ...configs[0], cookie: "__Secure-1PSID=refreshed-secret" }, configs[1]];
  const previous = { accountId: "first", conversationId: "existing", accountHash: "first-hash" };
  const result = await provider.chat({ message: "continue", thinking: false }, previous);
  assert.deepEqual(result.remoteSession, previous);
  await provider.getMedia(previous);
  assert.deepEqual(calls, ["chat:first:new", "chat:first:first", "status:first:first"]);
  assert.equal(created.length, 3); // Two startup accounts, then one replaced credential.
  assert.equal((await store.status("first", "video")).blockedUntilMs, 200000);
});

test("invalid credential refresh fails before upstream access and never uses stale credentials or another account", async t => {
  const root = await tempDir(t), calls: string[] = [];
  let fail = false;
  const provider = new GeminiAccountProvider([account("first"), account("second")], config => fakeProvider(config.id, calls),
    new GeminiCooldownStore(join(root, "cooldowns.json")), undefined, async () => {
      if (fail) throw new ProviderError("invalid private file", "configuration_error");
      return account("second");
    });
  for (fail of [false, true]) {
    await assert.rejects(provider.chat({ message: "hello", thinking: false }), (e: any) => e.code === "configuration_error");
    await assert.rejects(provider.getMedia({ accountId: "first" }), (e: any) => e.code === "configuration_error");
    await assert.rejects(provider.generateMedia(request("image")), (e: any) => e.code === "configuration_error");
  }
  assert.deepEqual(calls, []);
});

test("registered file-backed provider reloads private credentials and rejects unsafe files or reordered owners", async t => {
  const root = await tempDir(t), file = join(root, "accounts.json"), cookies: string[] = [];
  let configs = [account("first"), account("second")];
  await writeFile(file, JSON.stringify({ accounts: configs }), { mode: 0o600 });
  const settings = { GEMINI_ACCOUNTS_FILE: file, GEMINI_COOKIE: "", GEMINI_USER_AGENT: "", DEEPSEEK_USER_TOKEN: "", DOUBAO_COOKIE: "",
    GEMINI_WEB_BASE_URL: "http://127.0.0.1", WEB_AI_PROJECT_ROOT: root };
  const before = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, settings);
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.method, "GET");
    cookies.push(new Headers(init?.headers).get("Cookie")!);
    return new Response(null, { status: 401 });
  };
  const registry = new ProviderRegistry();
  await registerProviders(registry);
  const provider = registry.get("gemini") as GeminiAccountProvider;
  await assert.rejects(provider.getModels(), (e: any) => e.code === "authentication_error");
  configs = [{ ...configs[0], cookie: "__Secure-1PSID=new-credential" }, configs[1]];
  await writeFile(file, JSON.stringify({ accounts: configs }), { mode: 0o600 });
  await assert.rejects(provider.getModels(), (e: any) => e.code === "authentication_error");
  assert.deepEqual(cookies, [account("first").cookie, configs[0].cookie]);
  await writeFile(file, JSON.stringify({ accounts: [...configs].reverse() }), { mode: 0o600 });
  await assert.rejects(provider.getModels(), (e: any) => e.code === "configuration_error");
  await writeFile(file, "not JSON", { mode: 0o600 });
  await assert.rejects(provider.getModels(), (e: any) => e.code === "configuration_error");
  if (process.platform !== "win32") {
    await writeFile(file, JSON.stringify({ accounts: configs }), { mode: 0o600 });
    await chmod(file, 0o644);
    await assert.rejects(provider.getModels(), (e: any) => e.code === "configuration_error");
  }
  assert.equal(cookies.length, 2);
});

test("read-only quota lookup never generates, while the original new-generation operation can route onward", async t => {
  const root = await tempDir(t), calls: string[] = [];
  const store = new GeminiCooldownStore(join(root, "cooldowns.json"), () => 100000);
  const provider = new GeminiAccountProvider([account("first"), account("second")], config => ({
    ...fakeProvider(config.id, calls, () => { throw new GeminiMediaQuotaError("video", 200000); }),
    async getMedia() { calls.push("read:" + config.id); throw new GeminiMediaQuotaError("video", 200000); },
  }), store);
  await assert.rejects(provider.getMedia({ accountId: "first", mediaKind: "video" }), (e: any) => e instanceof GeminiMediaQuotaError);
  assert.deepEqual(calls, ["read:first"]);
  assert.equal((await store.status("first", "video")).blockedUntilMs, 200000);
  assert.equal((await store.status("first", "image")).coolingDown, false);
  assert.equal((await store.status("second", "video")).coolingDown, false);
  const freshStore = new GeminiCooldownStore(join(root, "fresh.json"), () => 100000);
  const generating = new GeminiAccountProvider([account("first"), account("second")], config => fakeProvider(config.id, calls,
    () => { if (config.id === "first") throw new GeminiMediaQuotaError("video", 200000); return { content: "second result" }; }), freshStore);
  assert.equal((await generating.generateMedia(request("video"))).content, "second result");
  assert.deepEqual(calls, ["read:first", "video:first:new", "video:second:new"]);
});

test("the original generation waits for a definitive late quota then routes unchanged references in order", async t => {
  const root = await tempDir(t), calls: string[] = [], captured: MediaGenerationRequest[] = [], progress: RemoteSession[] = [];
  const store = new GeminiCooldownStore(join(root, "cooldowns.json"));
  let firstReads = 0;
  const provider = new GeminiAccountProvider([account("first"), account("second"), account("third")], config => ({
    ...fakeProvider(config.id, calls),
    async generateMedia(value, previous) {
      assert.equal(previous, undefined); captured.push(value); calls.push("generate:" + config.id);
      return { content: "pending", remoteSession: { conversationId: "conversation-" + config.id, mediaKind: "video" }, media: [{ type: "video", status: "pending" }] };
    },
    async getMedia(previous) {
      calls.push("read:" + config.id);
      if (config.id === "first" && ++firstReads === 2) throw new GeminiMediaQuotaError("video");
      if (config.id === "first") return { content: "pending", remoteSession: previous, media: [{ type: "video", status: "pending" }] };
      return { content: "done", remoteSession: previous, media: [{ type: "video", status: "completed", url: "https://fixture.test/result.mp4" }] };
    },
  }), store, { timeoutMs: 2000, pollMs: 1 });
  const input: GeminiMediaGenerationRequest = { ...request("video"), ratio: "9:16", model: "selected", thinkingLevel: "high",
    referenceImages: Array.from({ length: 5 }, (_, i) => ({ name: `${i}.png`, buffer: Buffer.from(`fixture-${i}`) })),
    onPendingSession: session => { progress.push(session); } };
  const result = await provider.generateMedia(input);
  assert.equal(result.remoteSession?.accountId, "second"); assert.equal(result.media?.[0].status, "completed");
  assert.deepEqual(calls, ["generate:first", "read:first", "read:first", "generate:second", "read:second"]);
  assert.equal(captured.length, 2); assert.equal(captured[0], input); assert.equal(captured[1], input);
  assert.deepEqual(progress.map(s => s.accountId), ["first", "first", "second"]);
  assert.equal((await store.status("first", "video")).coolingDown, true);
  assert.equal((await store.status("first", "image")).coolingDown, false);
  assert.equal((await store.status("second", "video")).coolingDown, false);
});

test("pending confirmation errors, cancellation and bound conversations never trigger generation on another account", async t => {
  const root = await tempDir(t);
  for (const code of ["authentication_error", "captcha_required", "rate_limit_error", "network_error", "media_generation_failed", "cancelled"]) {
    const calls: string[] = [];
    const provider = new GeminiAccountProvider([account("first"), account("second")], config => ({
      ...fakeProvider(config.id, calls, () => ({ content: "pending", remoteSession: { mediaKind: "video" }, media: [{ type: "video", status: "pending" }] })),
      async getMedia() { throw new ProviderError("fixture", code); },
    }), new GeminiCooldownStore(join(root, code + ".json")), { timeoutMs: 2000, pollMs: 1 });
    await assert.rejects(provider.generateMedia(request("video")), (e: any) => e.code === code && e.sessionUncertain);
    assert.deepEqual(calls, ["video:first:new"]);
  }
  const calls: string[] = [];
  const provider = new GeminiAccountProvider([account("first"), account("second")], config => fakeProvider(config.id, calls,
    () => { throw new GeminiMediaQuotaError("video"); }), new GeminiCooldownStore(join(root, "pinned.json")));
  await assert.rejects(provider.generateMedia(request("video"), { accountId: "first" }), (e: any) => e instanceof GeminiMediaQuotaError);
  assert.deepEqual(calls, ["video:first:first"]);
});

test("the bounded wait returns the original pending handle and quota reset lookup errors prevent fallback", async t => {
  const root = await tempDir(t), calls: string[] = [];
  const provider = new GeminiAccountProvider([account("first"), account("second")], config => ({
    ...fakeProvider(config.id, calls, () => ({ content: "pending", remoteSession: { mediaKind: "video" }, media: [{ type: "video", status: "pending" }] })),
    async getMedia(previous) { return { content: "pending", remoteSession: previous, media: [{ type: "video", status: "pending" }] }; },
  }), new GeminiCooldownStore(join(root, "bounded.json")), { timeoutMs: 10, pollMs: 1 });
  const result = await provider.generateMedia(request("video"));
  assert.equal(result.remoteSession?.accountId, "first"); assert.ok(!calls.some(c => c.includes("second")));
  assert.equal(result.media?.[0].status, "pending"); assert.match(result.warning!, /bounded generation wait/);
  assert.equal(result.remoteSession?.mediaReadOnly, true);
  const failing = new GeminiAccountProvider([account("first"), account("second")], config => fakeProvider(config.id, calls,
    () => { const error = new GeminiMediaQuotaError("video"); error.cause = new ProviderError("fixture", "captcha_required"); throw error; }),
    new GeminiCooldownStore(join(root, "reset-error.json")));
  await assert.rejects(failing.generateMedia(request("video")), (e: any) => e instanceof GeminiMediaQuotaError);
  assert.ok(!calls.some(c => c.includes("second")));
});

test("loads ordered accounts from a private file and does not expose credentials in errors", async t => {
  const root = await tempDir(t);
  const path = join(root, "gemini-accounts.json");
  await writeFile(path, JSON.stringify({ accounts: [account("first", { image: 30 }), account("second")] }), { mode: 0o600 });
  await chmod(path, 0o600);
  const loaded = await loadGeminiAccounts({ GEMINI_ACCOUNTS_FILE: path });
  assert.deepEqual(loaded.map(item => item.id), ["first", "second"]);
  assert.equal(loaded[0].cooldownMinutes?.image, 30);
  assert.equal(loaded[0].cookie, "__Secure-1PSID=first-secret");

  await assert.rejects(loadGeminiAccounts({ GEMINI_ACCOUNTS_FILE: path, GEMINI_COOKIE: "__Secure-1PSID=secret-canary" }), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "configuration_error");
    assert.equal(error.message.includes("secret-canary"), false);
    assert.equal(error.message.includes(path), false);
    return true;
  });
});

test("browser chat requires an explicit positive space ID and an email owner", async t => {
  const root = await tempDir(t), file = join(root, "accounts.json");
  const owner = account("owner@example.test");
  await writeFile(file, JSON.stringify({ accounts: [{ ...owner, browserChatSpaceId: 15 }] }), { mode: 0o600 });
  assert.equal((await loadGeminiAccounts({ GEMINI_ACCOUNTS_FILE: file }))[0].browserChatSpaceId, 15);
  for (const value of [0, -1, 1.5, "15", null]) {
    await writeFile(file, JSON.stringify({ accounts: [{ ...owner, browserChatSpaceId: value }] }), { mode: 0o600 });
    await assert.rejects(loadGeminiAccounts({ GEMINI_ACCOUNTS_FILE: file }), (e: any) => e.code === "configuration_error");
  }
  await writeFile(file, JSON.stringify({ accounts: [{ ...account("alias"), browserChatSpaceId: 15 }] }), { mode: 0o600 });
  await assert.rejects(loadGeminiAccounts({ GEMINI_ACCOUNTS_FILE: file }), (e: any) => e.code === "configuration_error");
});

test("email account IDs load in order, preserve pinned media and persist independent cooldowns", async t => {
  const root = await tempDir(t), path = join(root, "accounts.json"), calls: string[] = [];
  const ids = ["owner.first@example.test", "owner+second@example.test"];
  for (const id of [...ids, "legacy-alias"]) assert.equal(validGeminiAccountId(id), true);
  for (const id of ["a@example.test\nsecret", "a@example.test\n", "alias\r\n", "a@-example.test", "a@example..test", "a@@example.test", "../a@example.test", "a b@example.test", "a".repeat(65) + "@example.test"]) {
    assert.equal(validGeminiAccountId(id), false);
  }
  await writeFile(path, JSON.stringify({ accounts: ids.map(id => account(id)) }), { mode: 0o600 });
  const loaded = await loadGeminiAccounts({ GEMINI_ACCOUNTS_FILE: path });
  assert.deepEqual(loaded.map(a => a.id), ids);
  const cooldownPath = join(root, "cooldowns.json");
  const cooldowns = new GeminiCooldownStore(cooldownPath, () => 100000);
  await cooldowns.recordQuota(ids[0], "video", 200000);
  const restored = new GeminiCooldownStore(cooldownPath, () => 100000);
  assert.equal((await restored.status(ids[0], "video")).coolingDown, true);
  assert.equal((await restored.status(ids[0], "image")).coolingDown, false);
  const provider = accountProvider(loaded, restored, calls, {
    [ids[1]]: () => ({ content: "accepted", remoteSession: { accountHash: "unchanged-second-owner-hash" } }),
  });
  assert.equal((await provider.generateMedia(request("video"))).remoteSession?.accountId, ids[1]);
  assert.deepEqual(calls, ["video:" + ids[1] + ":new"]);
  await provider.getMedia({ accountId: ids[0], mediaKind: "video", accountHash: "unchanged-owner-hash" });
  assert.equal(calls.at(-1), "status:" + ids[0] + ":" + ids[0]);
  await writeFile(path, JSON.stringify({ accounts: [account(ids[0]), account(ids[0].toUpperCase())] }), { mode: 0o600 });
  await assert.rejects(loadGeminiAccounts({ GEMINI_ACCOUNTS_FILE: path }), (e: any) => e.code === "configuration_error" && !e.message.includes(ids[0]));
});

test("legacy single-account configuration adapts to default and empty config stays empty", async () => {
  assert.deepEqual(await loadGeminiAccounts({}), []);
  const loaded = await loadGeminiAccounts({ GEMINI_COOKIE: "__Secure-1PSID=legacy-secret", GEMINI_USER_AGENT: "Fixture Browser/1.0" });
  assert.deepEqual(loaded.map(({ id }) => id), ["default"]);
  await assert.rejects(loadGeminiAccounts({ GEMINI_COOKIE: "__Secure-1PSID=legacy-secret" }), error =>
    error instanceof ProviderError && error.code === "configuration_error" && !error.message.includes("legacy-secret"));
});

test("account file rejects symlinks, broad permissions, duplicate IDs, malformed cookies, and oversized files", async t => {
  const root = await tempDir(t);
  const target = join(root, "target.json");
  const link = join(root, "link.json");
  await writeFile(target, JSON.stringify({ accounts: [account("one")] }), { mode: 0o600 });
  await chmod(target, 0o600);
  await symlink(target, link);
  await assert.rejects(loadGeminiAccounts({ GEMINI_ACCOUNTS_FILE: link }), error => error instanceof ProviderError && error.code === "configuration_error");

  await chmod(target, 0o644);
  await assert.rejects(loadGeminiAccounts({ GEMINI_ACCOUNTS_FILE: target }), error => error instanceof ProviderError && error.code === "configuration_error");
  await chmod(target, 0o600);
  await writeFile(target, JSON.stringify({ accounts: [account("same"), account("same")] }), { mode: 0o600 });
  await assert.rejects(loadGeminiAccounts({ GEMINI_ACCOUNTS_FILE: target }), error => error instanceof ProviderError && error.code === "configuration_error");
  await writeFile(target, JSON.stringify({ accounts: [{ ...account("one"), cookie: "not-a-session" }] }), { mode: 0o600 });
  await assert.rejects(loadGeminiAccounts({ GEMINI_ACCOUNTS_FILE: target }), error => error instanceof ProviderError && error.code === "configuration_error");
  await writeFile(target, " ".repeat(1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(loadGeminiAccounts({ GEMINI_ACCOUNTS_FILE: target }), error => error instanceof ProviderError && error.code === "configuration_error");
});

test("ordered media route switches only on a definitive quota rejection and records account/kind cooldown", async t => {
  const root = await tempDir(t);
  let now = 1_000_000;
  const store = new GeminiCooldownStore(join(root, "cooldowns.json"), () => now);
  const calls: string[] = [];
  const provider = accountProvider([account("first", { image: 10 }), account("second")], store, calls, {
    first: () => { throw new GeminiQuotaError("image", now + 60_000); },
    second: () => ({ content: "generated", remoteSession: { operationId: "job-2" } }),
  });
  const result = await provider.generateMedia(request("image"));
  assert.equal(result.remoteSession?.accountId, "second");
  assert.deepEqual(calls, ["image:first:new", "image:second:new"]);
  assert.deepEqual(await store.status("first", "image"), {
    coolingDown: true, blockedUntilMs: now + 60_000, remainingSeconds: 60, source: "website",
  });
  assert.equal((await store.status("first", "video")).coolingDown, false);
  assert.equal((await store.status("second", "image")).coolingDown, false);

  calls.length = 0;
  const next = accountProvider([account("first"), account("second")], store, calls);
  await next.generateMedia(request("image"));
  assert.deepEqual(calls, ["image:second:new"]);
});

test("cooldown survives store recreation and expiry is read-only eligibility", async t => {
  const root = await tempDir(t);
  const file = join(root, "private-state", "cooldowns.json");
  let now = 20_000;
  const first = new GeminiCooldownStore(file, () => now);
  await first.recordQuota("account1", "video", now + 5_000);
  const before = await readFile(file, "utf8");
  const statBefore = await lstat(file);
  now += 4_999;
  assert.equal((await new GeminiCooldownStore(file, () => now).status("account1", "video")).coolingDown, true);
  now += 1;
  const recovered = new GeminiCooldownStore(file, () => now);
  assert.deepEqual(await recovered.status("account1", "video"), {
    coolingDown: false, blockedUntilMs: 25_000, remainingSeconds: 0, source: "website",
  });
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal((await lstat(file)).mtimeMs, statBefore.mtimeMs);
});

test("unknown reset stays blocked across restart; explicit fallback records its source", async t => {
  const root = await tempDir(t);
  const file = join(root, "cooldowns.json");
  const store = new GeminiCooldownStore(file, () => 100);
  await store.recordQuota("unknown", "image");
  await store.recordQuota("fallback", "video", undefined, 2);
  const restarted = new GeminiCooldownStore(file, () => 101);
  assert.deepEqual(await restarted.status("unknown", "image"), {
    coolingDown: true, blockedUntilMs: null, remainingSeconds: null, source: "unknown",
  });
  assert.equal((await restarted.status("fallback", "video")).source, "configured_backoff");
  assert.equal((await restarted.status("fallback", "video")).blockedUntilMs, 120_100);
});

test("corrupt cooldown records fail closed instead of being treated as available", async t => {
  const root = await tempDir(t);
  const file = join(root, "cooldowns.json");
  const invalidRecords = [
    { accountId: "one", kind: "image", recordedAtMs: -1, blockedUntilMs: 1_000, source: "website" },
    { accountId: "one", kind: "image", recordedAtMs: 100, blockedUntilMs: null, source: "website" },
    { accountId: "one", kind: "image", recordedAtMs: 100, blockedUntilMs: 200, source: "unknown" },
    { accountId: "one", kind: "image", recordedAtMs: 200, blockedUntilMs: 200, source: "configured_backoff" },
  ];
  for (const record of invalidRecords) {
    const encoded = JSON.stringify({ version: 1, records: [record] });
    await writeFile(file, encoded, { mode: 0o600 });
    await assert.rejects(new GeminiCooldownStore(file).status("one", "image"), error =>
      error instanceof ProviderError && error.code === "cooldown_state_error");
    assert.equal(await readFile(file, "utf8"), encoded);
  }
});

test("all cooled accounts stop before generation and local status has aliases without querying websites", async t => {
  const root = await tempDir(t);
  const store = new GeminiCooldownStore(join(root, "cooldowns.json"), () => 50);
  await store.recordQuota("one", "video");
  await store.recordQuota("two", "video");
  const calls: string[] = [];
  const provider = accountProvider([account("one"), account("two")], store, calls);
  await assert.rejects(provider.generateMedia(request("video")), error => error instanceof GeminiQuotaError && error.kind === "video");
  assert.deepEqual(calls, []);
  const status = await provider.accountStatus();
  assert.deepEqual(status.map(({ id, order }) => ({ id, order })), [{ id: "one", order: 1 }, { id: "two", order: 2 }]);
  assert.equal(status[0].cooldown.video.source, "unknown");
  assert.deepEqual(calls, []);
});

test("earliest known reset is reported even if another account has an unknown reset", async t => {
  const root = await tempDir(t);
  const store = new GeminiCooldownStore(join(root, "cooldowns.json"));
  await store.recordQuota("unknown", "video");
  const knownReset = Date.now() + 60_000;
  await store.recordQuota("known", "video", knownReset);
  const calls: string[] = [];
  const provider = accountProvider([account("unknown"), account("known")], store, calls);
  await assert.rejects(provider.generateMedia(request("video")), error =>
    error instanceof GeminiQuotaError && error.resetAtMs === knownReset);
  assert.deepEqual(calls, []);
});

test("generic 429, authentication, CAPTCHA, and uncertain failures never switch accounts", async t => {
  const failures = [
    new ProviderError("rate limited", "rate_limit_error"),
    new ProviderError("login", "authentication_error"),
    new ProviderError("verification", "captcha_required"),
    new ProviderError("uncertain", "quota_exhausted", true),
  ];
  for (const failure of failures) {
    const root = await tempDir(t);
    const calls: string[] = [];
    const provider = accountProvider([account("one"), account("two")], new GeminiCooldownStore(join(root, "cooldowns.json")), calls, {
      one: () => { throw failure; },
    });
    await assert.rejects(provider.generateMedia(request("image")), error => error === failure);
    assert.deepEqual(calls, ["image:one:new"]);
  }
});

test("quota rejection on a bound session records cooldown but never migrates the remote session", async t => {
  const root = await tempDir(t);
  const now = 9_000;
  const store = new GeminiCooldownStore(join(root, "cooldowns.json"), () => now);
  const calls: string[] = [];
  const provider = accountProvider([account("one"), account("two")], store, calls, {
    one: () => { throw new GeminiQuotaError("image", now + 10_000); },
  });
  const previous = { accountId: "one", conversationId: "old-conversation", accountHash: "one-hash" };
  await assert.rejects(provider.generateMedia(request("image"), previous), error => error instanceof GeminiQuotaError);
  assert.deepEqual(calls, ["image:one:one"]);
  assert.equal((await store.status("one", "image")).coolingDown, true);
  await assert.rejects(provider.generateMedia(request("image"), previous), error => error instanceof GeminiQuotaError);
  assert.deepEqual(calls, ["image:one:one"]);

  calls.length = 0;
  await assert.rejects(provider.chat({ message: "continue", thinking: false }, { conversationId: "old", accountHash: "hash" }),
    error => error instanceof ProviderError && error.code === "session_state_error");
  assert.deepEqual(calls, []);
});

test("chat binds to configured first account and resumed chat remains pinned", async t => {
  const root = await tempDir(t);
  const calls: string[] = [];
  const provider = accountProvider([account("one"), account("two")], new GeminiCooldownStore(join(root, "cooldowns.json")), calls);
  const started = await provider.chat({ message: "hello", thinking: false });
  assert.equal(started.remoteSession?.accountId, "one");
  await provider.chat({ message: "continue", thinking: false }, started.remoteSession);
  assert.deepEqual(calls, ["chat:one:new", "chat:one:one"]);
});

test("media fetching stays pinned to the session account and never falls back", async t => {
  const root = await tempDir(t);
  const fetches: string[] = [];
  const provider = new GeminiAccountProvider([account("one"), account("two")], config => {
    const delegate = fakeProvider(config.id, []);
    return {
      ...delegate,
      async fetchMedia(url: string, init?: RequestInit) {
        fetches.push(`${config.id}:${url}:${init?.method ?? "GET"}`);
        return new Response(`fixture-${config.id}`);
      },
    };
  }, new GeminiCooldownStore(join(root, "cooldowns.json")));
  const response = await provider.fetchMediaForSession({ accountId: "two", accountHash: "two-hash" }, "https://media.example.test/file", { method: "GET" });
  assert.equal(await response.text(), "fixture-two");
  assert.deepEqual(fetches, ["two:https://media.example.test/file:GET"]);

  fetches.length = 0;
  const noFallback = new GeminiAccountProvider([account("one"), account("two")], config => {
    const delegate = fakeProvider(config.id, []);
    return config.id === "one" ? delegate : {
      ...delegate,
      async fetchMedia(url: string) { fetches.push(`${config.id}:${url}`); return new Response("wrong account"); },
    };
  }, new GeminiCooldownStore(join(root, "other-cooldowns.json")));
  await assert.rejects(noFallback.fetchMediaForSession({ accountId: "one", accountHash: "one-hash" }, "https://media.example.test/file"),
    error => error instanceof ProviderError && error.code === "unsupported_capability");
  assert.deepEqual(fetches, []);
});
