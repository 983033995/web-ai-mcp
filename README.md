# Web AI MCP

**DeepSeek Web-first MCP server with reserved extension points for Doubao and other web AI services.**

> Project status: v0.1 engineering scaffold. Build and live DeepSeek Web connectivity must be verified locally. This repository was previously named for CLIProxyAPI; its product direction is now MCP-only.

## Goal

Give Codex, Claude Code, Cursor, OpenCode, and other MCP clients access to **your own DeepSeek website conversation** for external analysis, thinking, file review, and multi-turn follow-ups. The first release implements **only DeepSeek Web**. Doubao and other providers are **topology placeholders**, not working integrations.

This is **not** a CLIProxyAPI plugin, OpenAI-compatible proxy, official DeepSeek API client, public free API gateway, or full autonomous coding agent.

## Topology

    Codex / Claude Code / other MCP Client
                    |
               MCP (stdio)
                    |
              MCP Tools
                    |
            ProviderRegistry
                    |
             WebAIProvider
                    |
        +-----------+-------------+
        |           |             |
      DeepSeek    Doubao       Other AI
      ACTIVE      RESERVED     RESERVED
        |
    DeepSeek Web Client
      /   |     |     \
    Auth  PoW  Session SSE/Files
        |
    chat.deepseek.com (private web interface)

**Capabilities, not provider count, drive extension.** A future provider must be implemented, tested, and explicitly registered before clients can call it.

## MVP tools

| Tool | Description |
| ---- | ----------- |
| deepseek_chat | Ask DeepSeek Web; optionally continue session_key |
| deepseek_reasoner | Invoke website thinking mode |
| deepseek_analyze_files | Analyze explicitly allowlisted local files via website upload |
| deepseek_sessions_list | List local sessions without exposing upstream IDs |
| deepseek_session_close | Forget local session only (does not delete web history) |
| webai_providers | Report active vs. not-implemented provider entries |

Website search is **not enabled**: pinned upstream's session call sets search_enabled to false. Function calling, API routing, browser-assisted login and multiple web services are not in MVP.

## Install (after local validation)

Requirements: Node.js >= 20, npm, Git, and a valid userToken from **your own** DeepSeek website login.

    npm install
    npm run setup:upstream
    npm run build
    npm test

The setup step fetches specific Web-only source files and PoW WASM from a **pinned upstream commit**. Vendored upstream files are intentionally excluded from this repository pending independent license/provenance review.

Set DEEPSEEK_USER_TOKEN securely in the shell, then add to Codex:

    codex mcp add web-ai --env DEEPSEEK_USER_TOKEN="$DEEPSEEK_USER_TOKEN" -- node /ABSOLUTE/PATH/web-ai-mcp/dist/index.js

Adjust the absolute path to where you cloned this repository. Never paste tokens in GitHub, chat messages or logs.

For local file upload, explicitly set WEB_AI_ALLOWED_ROOTS to directory paths separated by the OS path delimiter. Without this setting, file upload tools fail closed. MVP caps uploads to 5 files, 10 MiB each and 20 MiB total.

## Development state and security

- The source scaffold is **not yet a proven, build-verified, live-tested release**. Follow [Codex tasks](docs/CODEX_TASKS.md) before treating it as operational.
- The Web integration uses unsupported private interfaces that can change without notice; access restrictions, PoW, CAPTCHA or rate limiting may prevent operation.
- No bypass of access controls, CAPTCHA, WAF or account restrictions; no rotation of accounts to evade limits.
- Session keys are process-local and expire after 30 minutes by default; unknown/expired keys fail instead of silently opening a new web conversation.
- Web browser accounts can be free for normal UI use, but this project is **not** a sanctioned free developer API. Respect the service's terms and limits.

## Project documentation

- [Requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Provider extension contract](docs/PROVIDER_GUIDE.md)
- [Codex implementation plan](docs/CODEX_TASKS.md)
- [Security and known risks](docs/SECURITY.md)
- [Upstream code provenance](THIRD_PARTY_NOTICES.md)
- [Codex working rules](AGENTS.md)

Source research: https://github.com/booleamu/deepseek-mcp-server

## Repository naming

This existing GitHub repository retains the legacy URL **983033995/deepseek-web-cliproxy** to avoid breaking links. The application/package name is **web-ai-mcp**; repository renaming can be done separately in GitHub settings if desired.
