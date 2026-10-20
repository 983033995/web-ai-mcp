# Codex engineering rules — Web AI MCP

## Mission
Build a safe, maintainable MCP server exposing **your own web AI conversations**. Source includes DeepSeek Web and the explicitly requested experimental Doubao and Gemini HTTP providers; earlier npm v0.1.2 supports DeepSeek only. Do **not** implement CLIProxyAPI, OpenAI proxy endpoints, or official DeepSeek API access.

## Coding principles
- Keep changes minimal and incremental; validate each vertical slice before expanding.
- Provider-specific authentication, web endpoints, SSE parsing, cookies and session lineage remain inside src/providers/<id>/.
- Keep the shared MCP router/registry, session storage and tool definitions independent of DeepSeek-specific types.
- Never advertise unverified capabilities. Upstream Web Search is presently disabled.
- Use TypeScript strict checks and deterministic tests, with live web integration as explicit opt-in.
- stdout is reserved for MCP JSON-RPC; status logs go to stderr.

## Safety and data boundaries
- Never store or log userToken, browser cookies, documents or messages in Git.
- Never circumvent CAPTCHA/WAF/rate limiting. The user explicitly requested ordered own-account generation-quota routing on 2026-10-20: switch only after a definitive, unaccepted media quota rejection; never switch or replay on CAPTCHA, authentication failure, generic rate limits or uncertain acceptance.
- File uploads require WEB_AI_ALLOWED_ROOTS. Validate real paths against allowed roots before reading files.
- On unknown/expired session_key, **return an error**, never quietly start a new conversation.
- Preserve session/parent_message lineage atomically; guard concurrent calls to a session.
- Check upstream licensing and bundled WASM origin before redistributing copied code.

## Execution order
1. Read README, docs/ARCHITECTURE.md and docs/CODEX_TASKS.md.
2. Run npm install, npm run setup:upstream, npm run build, npm test.
3. Fix only real build/test failures. Do not claim live compatibility based on compilation.
4. Verify MCP Inspector tool discovery, then conduct authorized opt-in website smoke tests.
5. Doubao chat, expert thinking and TXT files were explicitly requested on 2026-10-14. Do not add other providers or remote MCP HTTP transport without subsequent requirements.
6. Doubao text-to-image and text-to-video were explicitly requested on 2026-10-19. Treat website clarification, acknowledgement and completed media as different outcomes; asynchronous result queries must not submit generation.
7. Long-chat/background jobs were requested on 2026-10-19 after Qoder's 60-second control timeout. Preserve pending/uncertain protection; job status never submits writes. Job IDs are not session keys, process restart never silently replays work, and progress notifications do not guarantee client timeout extension.
8. Gemini integration was requested on 2026-10-20 after default-model StreamGenerate preflight. Enable only proven default chat/session/background capabilities. Model selection, thinking, files, media, Cookie rotation and processSession remain disabled until separately verified; never infer HTTP support from a website menu.
9. Gemini image/video, ordered multi-account configuration and automatic quota cooldown expiry were explicitly requested on 2026-10-20. Keep account-bound conversations pinned, persist only secret-free cooldowns, use authoritative reset times or clearly labelled configured backoff, and never submit generation from status queries or cooldown expiry.
10. Gemini model discovery/selection, three thinking levels, authorized files, image/video references and native aspect-ratio selection were requested on 2026-10-20. Keep account-specific model discovery read-only, inherit omitted selections on continuation, and separate MP4 analysis from experimental video-reference generation. Never claim that every model/level/reference combination has been live-verified.

## GitHub maintenance
- Use a task branch and a pull request; do not push ordinary changes directly to protected main. Codex branch names use codex/.
- Follow CONTRIBUTING.md. Required checks are the CI jobs Node 20, Node 22 and Node 24; merge only after they pass and review conversations are resolved.
- CI uses local fixtures without website credentials. Do not publish imported upstream files or WASM. The npm release workflow may publish only the inspected package of project-owned compiled JavaScript and documentation.
