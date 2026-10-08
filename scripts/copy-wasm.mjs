import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
const source = resolve("src/providers/deepseek/upstream/sha3_wasm_bg.wasm");
const target = resolve("dist/providers/deepseek/upstream/sha3_wasm_bg.wasm");
if (!existsSync(source)) throw new Error("Missing upstream WASM; run npm run setup:upstream");
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.error("Copied pinned upstream WASM file to dist.");
