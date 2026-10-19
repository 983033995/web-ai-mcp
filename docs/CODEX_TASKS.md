# Codex local development checklist

## P0: Verify scaffold and source attribution
- [x] npm install
- [x] npm run setup:upstream (imports only Web reference source + WASM at pinned revision)
- [x] npm run build, npm run typecheck, npm test
- [ ] Verify source provenance / license and WASM redistribution status before public releases
- [x] Inspect MCP tool listing; webai_providers must report DeepSeek active, Doubao not_implemented
**Done:** compile/tests and six tools discoverable; no claim of live success yet.

## P1: Authorized DeepSeek live tests
- [x] Use an own-account userToken from local secret storage; never commit/log it
- [x] Single chat: actual answer and session_key
- [x] Second turn with key: same remote session and valid parent message ID
- [x] Reasoner: validate website thinking option and response separation
- [x] File upload: use explicit WEB_AI_ALLOWED_ROOTS with a non-sensitive test file
- [ ] Explicit errors for expired key/token, 403, 429, malformed SSE, timeout
**Done:** documented smoke-test evidence, with all sensitive fields redacted.

2026-10-08: own-account happy paths and unknown local session keys passed. Expired credentials, HTTP 401/403/429, malformed SSE and timeout behavior are covered by deterministic fixtures; these failure conditions were not deliberately induced against the live website. See [local validation](LOCAL_VALIDATION.md).

## P2: Reliability
- [x] Retry policy must never duplicate a website chat turn after ambiguous network failures
- [x] Provider error types and SSE fixture tests
- [x] Cancellation/timeouts from tools to transport
- [x] Safe session mutation and locking
- [x] Missing response message IDs return useful content with a nonresumable warning

## P3: Extensions (not required now)
- [ ] Research DeepSeek Web Search: actual behavior and permission boundaries
- [x] Project-private lineage persistence, stable IDs/names, default binding and non-expiring local sessions (requested 2026-10-08)
- [ ] Consider Streamable HTTP MCP with authentication
- [x] Implement requested experimental Doubao pure HTTP transport with deterministic error/session tests and stdio/package fixtures
- [x] Observe an authenticated Node HTTP complete text reply and verify captured SSE replay (2026-10-14; private credentials not committed)
- [x] Verify Doubao product HTTP same-conversation follow-up (2026-10-14; earlier CAPTCHA ceased without bypass; original and current configurations both succeeded, exact risk rule unknown)
- [x] Parse inherited CHUNK_DELTA and block further client writes after CAPTCHA; document that Node HTTP challenges do not automatically appear in the original browser tab
- [x] Implement requested Doubao expert parameters, separate real thinking containers, and bounded TXT upload/commit/file tools with deterministic tests
- [x] Verify actual MCP stdio expert answer, separate reasoning and expert-to-quick same-conversation recall
- [x] Complete actual MCP expert thinking, TXT analysis and restart follow-up after manual website verification and fresh request capture (2026-10-14; four-message product stdio probe passed without bypass)

- [x] Implement requested Doubao text-to-image and text-to-video generation, actual creation-card results and bounded read-only asynchronous result lookup (requested 2026-10-19)
- [x] Verify actual MCP image generation, four-second video request and result retrieval after MCP restart; result URL range requests return image/png and video/mp4 (2026-10-19; see DOUBAO_MEDIA_VALIDATION.md)
- [x] Add per-call selection of the four observed image and video models, default video to Seedance 2.0 Fast, and validate model-specific durations before HTTP dispatch (requested 2026-10-19)
- [x] Add observed image ratios and 32 styles plus allowed local PNG/JPEG/WebP reference uploads; verify actual MCP reference generation at 3:4 and default Fast video (requested 2026-10-19)

## Codex kickoff prompt
Read AGENTS.md, README.md, docs/ARCHITECTURE.md, docs/PRD.md, and docs/CODEX_TASKS.md. This is an own-account stdio Web AI MCP, not CLIProxyAPI. DeepSeek is released; Doubao source integration was explicitly requested and remains experimental. Respect credential confidentiality, WEB_AI_ALLOWED_ROOTS and live-validation limits. Do not invent capabilities or bypass access controls.
