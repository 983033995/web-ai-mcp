# Requirements: Web AI MCP (DeepSeek-only MVP)

## Objective
Expose the user's own **DeepSeek web conversations** to MCP-aware coding agents for second opinions, deep thinking, and file analysis, while keeping a clean WebAIProvider extension topology for future Doubao and other website AI integrations.

## Users
- Primary: developer using Codex Desktop / Codex CLI.
- Secondary: Claude Code, Cursor, OpenCode, and other compliant MCP clients.

## P0 scope
1. Start one local MCP server using stdio.
2. Connect only DeepSeek Web via user-provided DEEPSEEK_USER_TOKEN (no official API backend).
3. deepseek_chat: normal chat, returns a session_key for future turns.
4. deepseek_reasoner: turn on upstream website thinking, optional reasoning text if available.
5. Continue a chat via session_key and real website parent-message lineage, not reconstructed OpenAI messages.
6. Local session list and close; unknown or expired keys fail clearly.
7. File analysis of explicit user-selected, path-allowlisted files with total-byte and per-file limits.
8. Provider listing distinguishes active DeepSeek and planned Doubao (not callable).
9. Credential redaction, typed errors, deterministic fixtures, and local Codex smoke steps.

## Out of scope
- CLIProxyAPI plugin or OpenAI Chat/Responses proxy.
- Full agent loop, client tool calling, function calling synthesis.
- Official DeepSeek API / paid API keys.
- Doubao/Kimi/Tongyi real protocol implementations.
- Browser auto-login, automatic account rotation, multi-tenant/public service.
- Claims of stable or unlimited website API quotas.

## Future work (after empirical validation)
- Opt-in persistent sessions with secret-safe storage and cleanup.
- DeepSeek Web Search only after verifying the private web contract and acceptability.
- Streamable HTTP MCP with explicit client authentication, TLS and origins.
- Additional providers after separate technical/security feasibility study.

## Acceptance criteria
- MCP Inspector discovers six tools; provider listing reports only DeepSeek active.
- One successful chat followed by continuation must stay on the same upstream remote lineage.
- Thinking mode and file uploads work as declared in authorized manual tests.
- Token expiration, HTTP 401/403/429, network failures, malformed SSE and unknown session keys are reported.
- Never silently retry ambiguous writes or evade access controls.
- Code builds/tests on a developer machine and produces reproducible evidence; no fictitious pass claims.
