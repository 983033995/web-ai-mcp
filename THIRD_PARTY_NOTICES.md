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

The upstream README claims MIT. A repository-root LICENSE file was not present in review, and bundled WASM redistribution rights were not independently verified. Keep imported code out of this public GitHub repository until copyright and provenance are confirmed. Local setup only; do not imply a license grant.

DeepSeek website access may be subject to contractual limitations. This project is not endorsed by DeepSeek or any other website AI provider.
