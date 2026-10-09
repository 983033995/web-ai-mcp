import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const root = resolve(".");
const temporary = mkdtempSync(join(tmpdir(), "web-ai-mcp-package-"));
const run = (args, options = {}) => execFileSync(npm, args, {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000, ...options
});
try {
  // Build is an explicit prerequisite. The inspected tarball is also the one published.
  const [pack] = JSON.parse(run(["pack", "--ignore-scripts", "--json", "--pack-destination", temporary]));
  const paths = pack.files.map((file) => file.path);
  for (const path of paths) {
    assert.ok(!/(^|\/)(upstream|node_modules|tests|\.web-ai-mcp|\.github)(\/|$)/.test(path), path);
    assert.ok(!path.endsWith(".wasm") && !path.endsWith(".map") && !path.endsWith(".tgz"), path);
    assert.ok(!path.startsWith("src/") && !path.startsWith("scripts/"), path);
    assert.ok(!path.startsWith(".env") || path === ".env.example", path);
    assert.ok(path === "package.json" || path === ".env.example" || path.startsWith("dist/") ||
      path.startsWith("docs/") || ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "CONTRIBUTING.md", "AGENTS.md"].includes(path), path);
  }
  for (const path of ["dist/index.js", "dist/providers/deepseek/wasm.js", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    assert.ok(paths.includes(path), path);
  }
  const tarball = join(temporary, pack.filename);
  writeFileSync(join(temporary, "package.json"), JSON.stringify({ private: true, name: "package-smoke" }));
  run(["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", tarball], { cwd: temporary });
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(run(["exec", "--offline", "--", "web-ai-mcp", "--version"], { cwd: temporary }).trim(), manifest.version);
  assert.match(run(["exec", "--offline", "--", "web-ai-mcp", "--help"], { cwd: temporary }), /--env-file/);
  if (process.env.WEB_AI_PACKAGE_DOWNLOAD_SMOKE === "1") {
    run(["exec", "--offline", "--", "web-ai-mcp", "--setup"], {
      cwd: temporary, env: { ...process.env, WEB_AI_WASM_PATH: "", XDG_CACHE_HOME: join(temporary, "cache") }
    });
    console.log("[package smoke] First-start download and checksum verified from installed package.");
  }
  // Test local .env loading without ever using the developer's real credentials.
  const wasm = resolve("src/providers/deepseek/upstream/sha3_wasm_bg.wasm");
  const envFile = join(temporary, "fixture.env");
  writeFileSync(envFile, `WEB_AI_WASM_PATH=${wasm}\n`);
  run(["exec", "--offline", "--", "web-ai-mcp", "--env-file", envFile, "--setup"], { cwd: temporary });
  const env = { ...process.env, WEB_AI_WASM_PATH: wasm,
    WEB_AI_SMOKE_COMMAND: npm, WEB_AI_SMOKE_ARGS: JSON.stringify(["exec", "--offline", "--", "web-ai-mcp"]),
    WEB_AI_SMOKE_CWD: temporary };
  execFileSync(process.execPath, [join(root, "scripts/smoke-mcp.mjs")], { cwd: root, env, stdio: "inherit", timeout: 180_000 });
  if (process.env.WEB_AI_PACKAGE_TARBALL_DIR) {
    const { mkdirSync, copyFileSync } = await import("node:fs");
    const destination = resolve(process.env.WEB_AI_PACKAGE_TARBALL_DIR);
    mkdirSync(destination, { recursive: true });
    copyFileSync(tarball, join(destination, pack.filename));
  }
  console.log(`[package smoke] ${manifest.name}@${manifest.version}: ${paths.length} files checked; isolated npm exec, local env and MCP fixture passed; no bundled WASM.`);
} catch (error) {
  // npm and tool outputs may inherit local environment settings; don't dump them.
  console.error("[package smoke] Failed:", error instanceof assert.AssertionError ? error.message : "install or isolated CLI/MCP check failed");
  process.exitCode = 1;
} finally { rmSync(temporary, { recursive: true, force: true }); }
