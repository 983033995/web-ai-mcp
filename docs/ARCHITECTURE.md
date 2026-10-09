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
Doubao is reserved under src/providers/doubao, with a README explaining the adapter requirements. No invented Doubao endpoints, cookies, or model mappings. Future adapters must pass contract tests before registration.

## Transport decision
v0.1 uses local stdio only; shared/remote HTTP would require authentication, origin policy, rate control and user isolation.
