# Codex engineering rules — Web AI MCP

## Mission
Build a safe, maintainable MCP server exposing **your own web AI conversations**. v0.1 has one implemented provider: DeepSeek Web. Doubao is an extension slot only. Do **not** implement CLIProxyAPI, OpenAI proxy endpoints, or official DeepSeek API access.

## Coding principles
- Keep changes minimal and incremental; validate each vertical slice before expanding.
- Provider-specific authentication, web endpoints, SSE parsing, cookies and session lineage remain inside src/providers/<id>/.
- Keep the shared MCP router/registry, session storage and tool definitions independent of DeepSeek-specific types.
- Never advertise unverified capabilities. Upstream Web Search is presently disabled.
- Use TypeScript strict checks and deterministic tests, with live web integration as explicit opt-in.
- stdout is reserved for MCP JSON-RPC; status logs go to stderr.

## Safety and data boundaries
- Never store or log userToken, browser cookies, documents or messages in Git.
- Never circumvent CAPTCHA/WAF/rate limiting or rotate user accounts to bypass platform restrictions.
- File uploads require WEB_AI_ALLOWED_ROOTS. Validate real paths against allowed roots before reading files.
- On unknown/expired session_key, **return an error**, never quietly start a new conversation.
- Preserve session/parent_message lineage atomically; guard concurrent calls to a session.
- Check upstream licensing and bundled WASM origin before redistributing copied code.

## Execution order
1. Read README, docs/ARCHITECTURE.md and docs/CODEX_TASKS.md.
2. Run npm install, npm run setup:upstream, npm run build, npm test.
3. Fix only real build/test failures. Do not claim live compatibility based on compilation.
4. Verify MCP Inspector tool discovery, then conduct authorized opt-in website smoke tests.
5. Do not implement Doubao or HTTP transport until explicit subsequent requirements.
