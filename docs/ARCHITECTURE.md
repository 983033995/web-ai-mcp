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
 Provider tools                  webai_providers
     |                                |
 SessionStore / mutex             ProviderRegistry
     |                                |
     +----------------+---------------+
                      |
                WebAIProvider
                      |
       +--------------+------------------+
       |              |                  |
   DeepSeek Web   Doubao Web HTTP   Gemini Web HTTP
     stable        experimental      experimental
       |              |              (source; not in npm 0.4.0)
       |              |                  |
 DeepSeek client  Doubao client     Gemini client
 userToken/PoW    Cookie/UA/URL     Cookie/UA or accounts file
 chat.deepseek    doubao.com        gemini.google.com

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

## Configured tool defaults

The tool layer reads optional startup selections from the MCP environment after `--env-file` loading. DeepSeek supports a default thinking boolean; Doubao supports quick/expert plus image/video model defaults; Gemini supports a general model, per-media model overrides and Low/Medium/High. Values are validated without echoing arbitrary input. Existing provider validators still check account-specific Gemini model access and model-specific media constraints before upstream dispatch. No website preference is changed.

Explicit call parameters take precedence. Gemini's saved session model/level comes before configured defaults, including after process restart; capability model defaults come before the general model. Other tools preserve their existing per-message behavior, using configured defaults only for omitted options. The dedicated reasoner tools always enable thinking. Zod's Doubao model defaults are derived at registration so tool discovery and runtime agree. Gemini selectors remain optional in the schema, since schema-injected defaults would incorrectly override saved conversation choices.

Tools remain registered by configured provider with their existing names. A multi-provider server has 28 tools; `tools/list` pagination is discovery transport, not a guarantee that a client will lazily load schemas into model context. Future capability profiles can reduce each client's visible surface while preserving typed tools and recovery controls; a generic untyped dispatcher is not required for startup defaults.

## Existing upstream implementation
Pin https://github.com/booleamu/deepseek-mcp-server commit **f29e0de85fbe433c6d371b2649df9f0366f007f8**. Setup imports only Web reference source and dependencies (config/types/errors/WASM); it does not copy the official API client or original MCP router. Runtime imports the WASM only and uses project-owned TypeScript transport/parser. See THIRD_PARTY_NOTICES.md. SSE is aggregated into a final response and web search remains disabled.

## Extension boundary
Current source includes an experimental Doubao HTTP adapter under src/providers/doubao. It requires an own-account Cookie, complete captured /chat/completion URL and User-Agent; it never invents device fingerprints, chat signatures or bypasses website restrictions. Expert model parameters and parent-linked thinking containers are supported. TXT files use the common allowed-path reader, website temporary upload grants, scoped storage authentication, CRC and commit verification before chat; webpage Cookies stay on the website origin. Deterministic fixtures cover HTTP/SSE, local lineage, upload and stdio restart. Own-account Node HTTP complete replies, same-conversation recall and actual MCP expert thinking passed on 2026-10-14. CAPTCHA blocks subsequent client writes until restart, and its internal risk trigger remains unknown. See DOUBAO_RISK_INVESTIGATION.md and DOUBAO_CAPABILITY_VALIDATION.md for live-validation limits. Search remains disabled; incomplete or regressed lineage never yields a resumable local key.

Doubao image/video generation additionally uses website `chat_ability` parameters on the same `/chat/completion` transport. `2074/creation_block` snapshots carry actual media results. Model, ratio, style and duration choices are validated in the provider; the video default is Seedance 2.0 Fast. Reference images use the common allowed-path reader and existing scoped storage uploader with image grants, confirmed image metadata and separate attachment/text messages. Video may be delivered asynchronously as a later assistant message; `doubao_media_status` performs one bounded, read-only `/im/chain/single` request and advances confirmed reply lineage under the existing session lease. It does not submit, retry or automatically confirm generation. Prompts, replies, image bytes and signed media URLs are never stored in the session mapping. The explicit download tool refreshes history, selects a stable creation ID and writes a bounded, validated file under WEB_AI_MEDIA_DIR without credential forwarding or redirects. Official image watermark-free resolution remains in the Doubao provider and must return permission plus the same resource URI; unverified video removal is rejected. Download failures never invalidate generation lineage or resubmit. Generic optional generation contracts live in core; Doubao abilities, status values and URL validation stay in its provider. See [media validation](DOUBAO_MEDIA_VALIDATION.md).

## Transport decision

The source Gemini adapter isolates own-account StreamGenerate chat and image/video generation in src/providers/gemini. It refreshes the authenticated request context before writes and binds lineage to a configured account ID and hash, never persisting cookies, request tokens, prompts, media URLs or replies. IDs may be local aliases or owner-chosen email addresses; selecting email as the ID explicitly makes it visible in private lineage/cooldown files and tool results. A shared ID validator covers account files, cooldown persistence and media-recovery selectors; email IDs are unique ignoring case. Renaming private IDs must preserve the same owner hash, session state and cooldowns, without treating duplicate browser logins as separate owners. Media status uses the read-only hNvQHb turns RPC; only generated rich-media fields count as outputs, not retrieved images or prose. Verified image redirects are limited to lh3.googleusercontent.com /gg or /rd-gg and the observed lh3.google.com /rd-gg intermediary; video uses contribution.usercontent.google.com/download. Only the two exact Google origins that require login receive cookies. The shared bounded media-file saver validates MIME, formats, size and directory integrity.

Gemini account credentials load from one private JSON file or legacy single-account environment variables. Before each website operation, file-backed credentials are revalidated and the selected owner's provider is replaced only when its Cookie or User-Agent changed. In-flight operations keep their provider; refresh never retries a failed operation. Missing/invalid files fail closed, account IDs/order remain fixed until reconnect, and email IDs must match the authenticated owner even for new conversations. This does not read browser credentials or refresh website login. New media requests select configured accounts in order. An empty first-record 1037 rejection, or an exact completed video-quota notice with no generated resource, definitively rejects the operation and permits the original generation job to proceed once to the next account with all options/reference buffers unchanged. Candidate IDs alone are not evidence that media was accepted. The owning operation follows resource-free pending results for a bounded ten-minute window and persists validated pending lineage under the existing session lease; background status only reads its cached state. A bounded read-only aPya6c lookup supplies a future reset when available; otherwise use a clearly configured local backoff or retain an unknown blocked time. If that lookup itself fails, routing stops conservatively. Independent image/video cooldowns survive restart; expiry and independent media status/recovery/download calls never submit work. Caller-supplied existing conversations remain on their bound account, and auth/CAPTCHA/general429/network/uncertain outcomes never trigger fallback. The tools retain background idempotency protections and never resume a generation after process exit.

All Gemini operations use the HTTP client. The former opt-in native-browser chat experiment was removed after its transient task-space binding failed across normal usage and the user explicitly rejected a browser runtime dependency. Legacy `browserChatSpaceId` configuration fails with a migration instruction rather than spawning or claiming a browser. Website credentials may need an explicit one-time refresh after expiration; that is separate from runtime browser control. Authentication, model discovery and completed chat remain independent acceptance criteria. Invalid credentials, missing website integrity context, or upstream failures never authorize browser fallback, replay, or account switching.

The read-only otAQ7b RPC discovers account model IDs/names/numbers and tier capacity. Explicit selections are resolved against that account before upload or generation; omitted model/level selections inherit from the bound conversation. Low/Medium/High remain distinct observed wire values. Local files pass the common real-path allowlist reader, then provider-local MIME/magic validation and a bounded, credential-free content-push multipart upload. Ephemeral attachment IDs and names are used only in the outgoing message. Every eligible fallback account gets a fresh upload. Image/video tools use the observed native tool and ratio fields; MP4 references remain experimental and a prose response is not successful media. Automatic browser fallback, duration/style selection, automatic login-cookie rotation requests, API-key transport and AGPL runtime dependencies are not included.

Video acknowledgements may finish with only conversation/reply IDs. When a media stream cannot provide a completed result, validated, non-conflicting identifiers permit a read-only lookup for that exact reply; the next candidate is never guessed from another turn. If history has not published it, retain a media-only handle with the observed c/r and pending status. Its persisted `mediaReadOnly` flag rejects all chat/generation writes, including after restart, while status resolves the exact candidate later. An owner-provided conversation URL can also recover existing media after a key was lost/closed. Recovery chooses only the original configured account, never searches across accounts, changes original uncertain records, replays generation or clears cooldowns. History framing and media URL validation remain mandatory.
v0.3.0 added process-local background jobs for the four chat/reasoner tools (still present in 0.4.0). Submission returns immediately and polling only reads a cached result. The existing session lease and pending/uncertain transitions still span the website operation; job cancellation aborts that operation and never retries it. Jobs/results are bounded in memory, not written to the session store and not recovered after process exit. Request ID digests prevent replays within the same process even after result expiry. Server instructions, webai_usage and parameter descriptions expose lifecycle rules; synchronous calls can emit waiting progress without claiming client timeout extension.

v0.1 uses local stdio only; shared/remote HTTP would require authentication, origin policy, rate control and user isolation.

## npm entry and runtime assets
The npm executable is dist/index.js. --help and --version need no account; --setup verifies a local PoW file or downloads pinned bytes into the user's cache. --env-file explicitly loads local configuration before provider creation; environment variables already present take precedence. Source imports remain local, while npm's files allowlist excludes upstream files, WASM and source maps.

Provider initialization uses the explicit WEB_AI_WASM_PATH first, then a source checkout's imported WASM, then a verified cache. Missing cache triggers one bounded download from the fixed upstream URL without website credentials. Hash mismatches or explicit missing files fail closed, never switching silently to another artifact. See THIRD_PARTY_NOTICES.md for the pin/hash and licensing boundary.
