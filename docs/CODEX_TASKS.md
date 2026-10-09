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
- [ ] Evaluate Doubao feasibility separately **without implementing an adapter yet**

## Codex kickoff prompt
Read AGENTS.md, README.md, docs/ARCHITECTURE.md, docs/PRD.md, and docs/CODEX_TASKS.md. This is a DeepSeek-Web-only MCP, not CLIProxyAPI. Start with P0 compile/test validation. Only the DeepSeek provider may be active. Respect userToken confidentiality and WEB_AI_ALLOWED_ROOTS. Do not invent capabilities or bypass access controls.
