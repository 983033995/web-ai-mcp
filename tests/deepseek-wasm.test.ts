import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPowWasm, wasmUrl } from "../src/providers/deepseek/wasm.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(resolve(".validation-wasm-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = await readFile(new URL("../src/providers/deepseek/upstream/sha3_wasm_bg.wasm", import.meta.url));
  return { bytes, path: join(directory, "explicit.wasm"), cachePath: join(directory, "cache/pow.wasm"),
    localPath: pathToFileURL(join(directory, "missing.wasm")) };
}

test("WASM bootstrap downloads only pinned bytes without credentials and reuses verified cache", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const request: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, wasmUrl);
    assert.equal(options?.redirect, "error");
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.headers, undefined);
    return new Response(f.bytes);
  };
  const first = await loadPowWasm({ ...f, path: undefined, fetch: request });
  assert.ok(first instanceof WebAssembly.Module);
  assert.deepEqual(await readFile(f.cachePath), f.bytes);
  await loadPowWasm({ ...f, path: undefined, fetch: request });
  assert.equal(calls, 1);
});

test("explicit WASM and damaged caches fail closed without network fallback", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const request: typeof fetch = async () => { calls++; throw new Error("should not download"); };
  await assert.rejects(loadPowWasm({ ...f, fetch: request }), /file is missing/);
  await writeFile(f.path, "corrupted");
  await assert.rejects(loadPowWasm({ ...f, fetch: request }), /checksum mismatch/);
  assert.equal(await readFile(f.path, "utf8"), "corrupted");
  await assert.rejects(loadPowWasm({ ...f, path: undefined, cachePath: f.path, fetch: request }), /checksum mismatch/);
  assert.equal(calls, 0);
  await writeFile(f.path, f.bytes);
  assert.ok(await loadPowWasm({ ...f, fetch: request }) instanceof WebAssembly.Module);
});

test("WASM download rejects HTTP errors, corrupt bytes and oversized bodies without caching", async (t) => {
  const f = await fixture(t);
  for (const response of [new Response("forbidden", { status: 403 }), new Response("invalid wasm"),
    new Response(new Uint8Array(1024 * 1024 + 1))]) {
    await assert.rejects(loadPowWasm({ ...f, path: undefined, fetch: async () => response }), /download failed|checksum mismatch/);
    await assert.rejects(access(f.cachePath));
  }
});
