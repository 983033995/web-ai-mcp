# Codex local development checklist

## P0: Verify scaffold and source attribution
- [ ] npm install
- [ ] npm run setup:upstream (imports only Web source + WASM at pinned revision)
- [ ] npm run build, npm run typecheck, npm test
- [ ] Verify source provenance / license and WASM redistribution status before public releases
- [ ] Inspect MCP tool listing; webai_providers must report DeepSeek active, Doubao not_implemented
**Done:** compile/tests and six tools discoverable; no claim of live success yet.

## P1: Authorized DeepSeek live tests
- [ ] Use an own-account userToken from local secret storage; never commit/log it
- [ ] Single chat: actual answer and session_key
- [ ] Second turn with key: same remote session and valid parent message ID
- [ ] Reasoner: validate upstream thinking option and response separation
- [ ] File upload: use explicit WEB_AI_ALLOWED_ROOTS with a non-sensitive test file
- [ ] Explicit errors for expired key/token, 403, 429, malformed SSE, timeout
**Done:** documented smoke-test evidence, with all sensitive fields redacted.

## P2: Reliability
- [ ] Retry policy must never duplicate a website chat turn after ambiguous network failures
- [ ] Provider error types and SSE fixture tests
- [ ] Cancellation/timeouts from tools to transport
- [ ] Safe session mutation and locking
- [ ] Determine whether missing upstream message ID should produce a nonresumable result instead of dropping useful content

## P3: Extensions (not required now)
- [ ] Research DeepSeek Web Search: actual behavior and permission boundaries
- [ ] Decide if persistence is needed and design opt-in secret-safe storage
- [ ] Consider Streamable HTTP MCP with authentication
- [ ] Evaluate Doubao feasibility separately **without implementing an adapter yet**

## Codex kickoff prompt
Read AGENTS.md, README.md, docs/ARCHITECTURE.md, docs/PRD.md, and docs/CODEX_TASKS.md. This is a DeepSeek-Web-only MCP, not CLIProxyAPI. Start with P0 compile/test validation. Only the DeepSeek provider may be active. Respect userToken confidentiality and WEB_AI_ALLOWED_ROOTS. Do not invent capabilities or bypass access controls.
