import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
const source = resolve("src/providers/deepseek/upstream/sha3_wasm_bg.wasm");
const target = resolve("dist/providers/deepseek/upstream/sha3_wasm_bg.wasm");
// TypeScript does not delete outputs of removed sources. Do not package the retired browser transport.
for (const name of ["browser-chat", "browser-runtime"]) {
  for (const extension of ["js", "js.map", "d.ts"]) rmSync(resolve(`dist/providers/gemini/${name}.${extension}`), { force: true });
}
if (!existsSync(source)) throw new Error("Missing upstream WASM; run npm run setup:upstream");
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.error("Copied pinned upstream WASM file to dist.");
