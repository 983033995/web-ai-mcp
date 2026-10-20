# Architecture: Provider-first Web AI MCP

## Decision
Use MCP as the **external consultation interface**, not an OpenAI-compatible model/provider adapter. Each website has its own server-side conversation state. Do not force different sites through fabricated stateless inference semantics.

## Diagram

    MCP Client (Codex / Claude Code / Cursor)
                    |
            Stdio MCP Server
                    |
     +--------------+-----------------+
     |                                |
 DeepSeek tools                  webai_providers
     |                                |
 SessionStore / mutex             ProviderRegistry
     |                                |
     +----------------+---------------+
                      |
                WebAIProvider
                      |
       +--------------+-----------------+
       |              |                 |
   DeepSeek Web    Doubao slot      other slots
     active       not callable     not callable
       |
    DeepSeekWebClient (project-owned website transport)
       |
   userToken / PoW / session / SSE / upload
       |
   chat.deepseek.com

## Flow: multi-turn chat
1. Tool validates user text and optional conversation_id/session_key or conversation_name; otherwise uses a project default if selected.
2. SessionStore looks up key; if missing/expired, return a definitive error.
3. Lock the private project store across processes, reload committed state, and persist pending state before the website write to prevent parent-ID races and unsafe crash recovery.
4. Provider translates the request to website thinking toggles and calls its website transport.
5. Website client handles session creation when absent, PoW challenge, request and SSE parsing. The locally imported WASM runs in a cancellable worker.
6. On successful result with response message ID, atomically commit sessionId and parent message ID and optionally select the project default.
7. Return answer and local session_key; do not leak raw credentials or upstream web IDs.
8. On ambiguous completion failure, retain a blocked local key/name. A complete answer missing its response ID is returned with a warning and no resumable key. Never retry a website write automatically.

## Shared contracts
- ProviderRegistry: explicit registration, no stubs registered.
- WebAIProvider: id, display name, capability flags, initialize(), chat(), optional analyzeFiles().
- RemoteSession: provider-owned session metadata; core treats content opaquely.
- SessionStore: stable local UUID/name -> provider ID + opaque remote lineage + opt-in TTL + project default + atomic disk commit and process lease. No credentials or dialogue are persisted.
- MCP tools: provider-specific command names; other sites add their own tool modules.

## Existing upstream implementation
Pin https://github.com/booleamu/deepseek-mcp-server commit **f29e0de85fbe433c6d371b2649df9f0366f007f8**. Setup imports only Web reference source and dependencies (config/types/errors/WASM); it does not copy the official API client or original MCP router. Runtime imports the WASM only and uses project-owned TypeScript transport/parser. See THIRD_PARTY_NOTICES.md. SSE is aggregated into a final response and web search remains disabled.

## Extension boundary
Current source includes an experimental Doubao HTTP adapter under src/providers/doubao. It requires an own-account Cookie, complete captured /chat/completion URL and User-Agent; it never invents device fingerprints, chat signatures or bypasses website restrictions. Expert model parameters and parent-linked thinking containers are supported. TXT files use the common allowed-path reader, website temporary upload grants, scoped storage authentication, CRC and commit verification before chat; webpage Cookies stay on the website origin. Deterministic fixtures cover HTTP/SSE, local lineage, upload and stdio restart. Own-account Node HTTP complete replies, same-conversation recall and actual MCP expert thinking passed on 2026-10-14. CAPTCHA blocks subsequent client writes until restart, and its internal risk trigger remains unknown. See DOUBAO_RISK_INVESTIGATION.md and DOUBAO_CAPABILITY_VALIDATION.md for live-validation limits. Search remains disabled; incomplete or regressed lineage never yields a resumable local key.

Doubao image/video generation additionally uses website `chat_ability` parameters on the same `/chat/completion` transport. `2074/creation_block` snapshots carry actual media results. Model, ratio, style and duration choices are validated in the provider; the video default is Seedance 2.0 Fast. Reference images use the common allowed-path reader and existing scoped storage uploader with image grants, confirmed image metadata and separate attachment/text messages. Video may be delivered asynchronously as a later assistant message; `doubao_media_status` performs one bounded, read-only `/im/chain/single` request and advances confirmed reply lineage under the existing session lease. It does not submit, retry or automatically confirm generation. Prompts, replies, image bytes and signed media URLs are never stored in the session mapping. The explicit download tool refreshes history, selects a stable creation ID and writes a bounded, validated file under WEB_AI_MEDIA_DIR without credential forwarding or redirects. Official image watermark-free resolution remains in the Doubao provider and must return permission plus the same resource URI; unverified video removal is rejected. Download failures never invalidate generation lineage or resubmit. Generic optional generation contracts live in core; Doubao abilities, status values and URL validation stay in its provider. See [media validation](DOUBAO_MEDIA_VALIDATION.md).

## Transport decision

The source Gemini adapter isolates the own-account StreamGenerate transport in src/providers/gemini. It refreshes the authenticated website request context before each turn and binds resumable lineage to an account hash, never persisting cookies, request tokens, email, prompts or replies. Only default-model chat is enabled; model selection, thinking, files, search, media and the browser's newer processSession channel are not exposed. The three Gemini tools reuse the existing session lease, pending/uncertain protection and background job manager. Redirects never forward credentials; failed or uncertain website writes are not retried. No browser fallback, automatic cookie rotation, API-key transport or AGPL runtime dependency is included.
v0.3.0 adds process-local background jobs for the four chat/reasoner tools. Submission returns immediately and polling only reads a cached result. The existing session lease and pending/uncertain transitions still span the website operation; job cancellation aborts that operation and never retries it. Jobs/results are bounded in memory, not written to the session store and not recovered after process exit. Request ID digests prevent replays within the same process even after result expiry. Server instructions, webai_usage and parameter descriptions expose lifecycle rules; synchronous calls can emit waiting progress without claiming client timeout extension.

v0.1 uses local stdio only; shared/remote HTTP would require authentication, origin policy, rate control and user isolation.

## npm entry and runtime assets
The npm executable is dist/index.js. --help and --version need no account; --setup verifies a local PoW file or downloads pinned bytes into the user's cache. --env-file explicitly loads local configuration before provider creation; environment variables already present take precedence. Source imports remain local, while npm's files allowlist excludes upstream files, WASM and source maps.

Provider initialization uses the explicit WEB_AI_WASM_PATH first, then a source checkout's imported WASM, then a verified cache. Missing cache triggers one bounded download from the fixed upstream URL without website credentials. Hash mismatches or explicit missing files fail closed, never switching silently to another artifact. See THIRD_PARTY_NOTICES.md for the pin/hash and licensing boundary.
