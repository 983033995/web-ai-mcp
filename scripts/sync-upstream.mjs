import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const revision = "f29e0de85fbe433c6d371b2649df9f0366f007f8";
const repository = "https://github.com/booleamu/deepseek-mcp-server.git";
const temp = mkdtempSync(join(tmpdir(), "deepseek-web-upstream-"));
const clone = join(temp, "repo");
const target = resolve("src/providers/deepseek/upstream");
try {
  console.error("Fetching upstream DeepSeek Web client at commit " + revision);
  execFileSync("git", ["clone", "--quiet", repository, clone], { stdio: "inherit" });
  execFileSync("git", ["-C", clone, "checkout", "--quiet", revision], { stdio: "inherit" });
  mkdirSync(target, { recursive: true });
  for (const file of ["web-client.ts", "config.ts", "types.ts", "errors.ts", "sha3_wasm_bg.wasm"]) {
    cpSync(join(clone, "src", file), join(target, file));
  }
  writeFileSync(join(target, "UPSTREAM_REVISION.txt"), repository + "\n" + revision + "\n");
  console.error("Imported website client dependencies only; official API client excluded.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
