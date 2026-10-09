import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DeepSeekWebError } from "./errors.js";

export const wasmRevision = "f29e0de85fbe433c6d371b2649df9f0366f007f8";
export const wasmSha256 = "b3fca8cc072c1defbd60c02266a8e48bd307a1804aaff4314900aea720e72f7d";
export const wasmUrl = `https://raw.githubusercontent.com/booleamu/deepseek-mcp-server/${wasmRevision}/src/sha3_wasm_bg.wasm`;
const maxBytes = 1024 * 1024;
const unavailable = (detail: string) => new DeepSeekWebError("pow_unavailable",
  `${detail}; run web-ai-mcp --setup or set WEB_AI_WASM_PATH to the pinned local WASM. See THIRD_PARTY_NOTICES.md.`);

interface WasmOptions {
  path?: string;
  cachePath?: string;
  localPath?: URL;
  fetch?: typeof fetch;
}

async function verify(bytes: Uint8Array): Promise<WebAssembly.Module> {
  if (bytes.length > maxBytes || createHash("sha256").update(bytes).digest("hex") !== wasmSha256) {
    throw unavailable("Pinned PoW WASM checksum mismatch (file preserved)");
  }
  return WebAssembly.compile(new Uint8Array(bytes));
}

async function local(path: string | URL): Promise<WebAssembly.Module | undefined> {
  try {
    if ((await stat(path)).size > maxBytes) throw unavailable("PoW WASM exceeds size limit");
    return await verify(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof DeepSeekWebError) throw error;
    throw unavailable("Cannot read or compile local PoW WASM");
  }
}

/** Download to the user's cache, never into the installed npm package or Git. */
export async function loadPowWasm(options: WasmOptions = {}): Promise<WebAssembly.Module> {
  const explicit = options.path ?? process.env.WEB_AI_WASM_PATH;
  if (explicit) {
    const module = await local(resolve(explicit));
    if (!module) throw unavailable("Configured PoW WASM file is missing");
    return module;
  }
  // Source checkouts retain their locally imported file; npm packages exclude it.
  const imported = await local(options.localPath ?? new URL("./upstream/sha3_wasm_bg.wasm", import.meta.url));
  if (imported) return imported;
  const cachePath = options.cachePath ?? join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "web-ai-mcp", wasmRevision, "sha3_wasm_bg.wasm"
  );
  const cached = await local(cachePath);
  if (cached) return cached;

  console.error("[web-ai-mcp] Downloading pinned PoW WASM to local cache (not bundled in npm). SHA-256 will be verified.");
  let bytes: Uint8Array;
  try {
    const response = await (options.fetch ?? fetch)(wasmUrl, {
      redirect: "error", credentials: "omit", signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok || !response.body) throw new Error("Download failed");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error("Size limit exceeded");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    bytes = Buffer.concat(chunks, size);
  } catch { throw unavailable("PoW WASM download failed; check access to raw.githubusercontent.com"); }
  const module = await verify(bytes);
  const temporary = cachePath + "." + randomUUID() + ".tmp";
  try {
    await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, cachePath);
  } catch { throw unavailable("Cannot save verified PoW WASM to local cache"); }
  finally {
    try { await unlink(temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable("Cannot clean up temporary WASM cache file"); }
  }
  return module;
}
