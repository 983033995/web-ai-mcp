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
    DeepSeekWebClient (pinned upstream)
       |
   userToken / PoW / session / SSE / upload
       |
   chat.deepseek.com

## Flow: multi-turn chat
1. Tool validates user text and optional session_key.
2. SessionStore looks up key; if missing/expired, return a definitive error.
3. Lock existing conversation to prevent concurrent parent-ID races.
4. Provider translates a request to DeepSeek website model/toggles and calls webChatWithSession.
5. Upstream client handles session creation when absent, PoW challenge, request, SSE parsing.
6. On successful result with response message ID, commit sessionId and parent message ID.
7. Return answer and local session_key; do not leak raw credentials or upstream web IDs.

## Shared contracts
- ProviderRegistry: explicit registration, no stubs registered.
- WebAIProvider: id, display name, capability flags, initialize(), chat(), optional analyzeFiles().
- RemoteSession: provider-owned session metadata; core treats content opaquely.
- SessionStore: local key -> provider ID + remote session + TTL + concurrency guard.
- MCP tools: provider-specific command names; other sites add their own tool modules.

## Existing upstream implementation
Pin https://github.com/booleamu/deepseek-mcp-server commit **f29e0de85fbe433c6d371b2649df9f0366f007f8**. Import only the Web client and its dependencies (config/types/errors/WASM); do not copy official API client or original MCP router. See THIRD_PARTY_NOTICES.md. Upstream currently aggregates SSE into a final response and its session call disables web search. Those limits must be documented.

## Extension boundary
Doubao is reserved under src/providers/doubao, with a README explaining the adapter requirements. No invented Doubao endpoints, cookies, or model mappings. Future adapters must pass contract tests before registration.

## Transport decision
v0.1 uses local stdio only; shared/remote HTTP would require authentication, origin policy, rate control and user isolation.
