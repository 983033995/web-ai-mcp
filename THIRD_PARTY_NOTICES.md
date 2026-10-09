# Third-party source and provenance

Upstream research: https://github.com/booleamu/deepseek-mcp-server

Pinned commit: **f29e0de85fbe433c6d371b2649df9f0366f007f8** (2026-03-19).

Local import performed by npm run setup:upstream:
- src/web-client.ts
- src/config.ts
- src/types.ts
- src/errors.ts
- src/sha3_wasm_bg.wasm

The official API client (client.ts), upstream MCP tool handlers and MCP entry point are **not** imported. The new project composes its own Web-only provider and MCP tools.

The runtime now uses project-owned transport, error handling and SSE parsing. The imported TypeScript files remain local protocol references rather than runtime dependencies. `src/providers/deepseek/pow.ts` uses the WASM ABI observed in the pinned Web client; the actual WASM stays excluded from Git. This change does not resolve upstream/WASM licensing or grant redistribution rights.

The upstream README claims MIT. A repository-root LICENSE file was not present in review, and bundled WASM redistribution rights were not independently verified. Keep imported code out of this public GitHub repository until copyright and provenance are confirmed. Local setup only; do not imply a license grant.

DeepSeek website access may be subject to contractual limitations. This project is not endorsed by DeepSeek or any other website AI provider.

## npm distribution

Project-owned code is MIT licensed; see LICENSE. This grant does not cover the third-party WASM or imply website authorization.

The npm package includes only project-owned compiled JavaScript and documentation; it excludes imported TypeScript, all WASM, source maps, credentials and session data. No install/postinstall download hook runs. First server initialization or `web-ai-mcp --setup` obtains the WASM directly from the pinned upstream source and stores it in the user's local cache. An explicit WEB_AI_WASM_PATH can supply the same verified file offline.

- URL: https://raw.githubusercontent.com/booleamu/deepseek-mcp-server/f29e0de85fbe433c6d371b2649df9f0366f007f8/src/sha3_wasm_bg.wasm
- SHA-256: b3fca8cc072c1defbd60c02266a8e48bd307a1804aaff4314900aea720e72f7d
- Default cache: `<XDG_CACHE_HOME or ~/.cache>/web-ai-mcp/<pinned commit>/sha3_wasm_bg.wasm`

Downloads are bounded, do not send website credentials, reject redirects and must match the hash before compilation or cache writes. Checksum mismatches preserve the file and fail closed. Hash verification is not a provenance, licensing or security audit. WASM redistribution remains unapproved; do not add it to npm tarballs, releases or CI artifacts.
