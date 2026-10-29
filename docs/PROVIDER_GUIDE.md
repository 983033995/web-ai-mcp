# Web AI Provider guide

## Contract
Source of truth: `src/core/provider.ts`.

    interface WebAIProvider {
      readonly id: string;
      readonly displayName: string;
      readonly capabilities: ProviderCapabilities;
      initialize(): Promise<void>;
      chat(request: ChatRequest, session?: RemoteSession): Promise<ProviderResult>;
      analyzeFiles?(files: FileInput[], instruction: string, thinking: boolean, signal?: AbortSignal): Promise<ProviderResult>;
    }

Providers own their upstream authentication, response parsing, challenge logic and session IDs. The core only maps local keys to **opaque provider-owned remote sessions**.

Only secret-free lineage belongs in `RemoteSession`: it may now be persisted. Never include credentials, dialogue or uploaded content. Use `ProviderError.sessionUncertain` for ambiguous writes; explicit rejections leave the last committed parent intact. `ChatRequest.signal` propagates MCP cancellation.

## Current providers (source vs npm)

| Provider | Registration | Product stance | npm `web-ai-mcp@0.5.0` |
| --- | --- | --- | --- |
| DeepSeek Web | `DEEPSEEK_USER_TOKEN` (or alone when no Doubao/Gemini credentials) | **Stable** | Included |
| Doubao Web HTTP | `DOUBAO_COOKIE` (+ chat URL / User-Agent) | **Experimental** | Included |
| Gemini Web HTTP | `GEMINI_COOKIE` + UA, or private `GEMINI_ACCOUNTS_FILE` | **Experimental** | Included since 0.5.0 |

`webai_providers` reports only registered providers. Incomplete providers must not appear active. Search stays disabled (`search_enabled=false`).

Issue [#5](https://github.com/983033995/web-ai-mcp/issues/5) was a **research-only** go/no-go for Doubao (and related web-search). That research was **superseded** by later explicit own-account Doubao/Gemini HTTP work ([#12](https://github.com/983033995/web-ai-mcp/pull/12)–[#24](https://github.com/983033995/web-ai-mcp/pull/24)). See [ADR 0001](adr/0001-issue-5-superseded-by-web-http.md).

## Adding another website provider
1. Confirm an authorized own-account path and record terms / risk limits (prefer a short ADR).
2. Implement `src/providers/<id>/` with real transport, tests and capability flags—no stubs.
3. Keep cookies, tokens, web transport and remote session fields inside that directory.
4. Register explicitly in `src/providers/index.ts` and wire proven MCP tools from `src/index.ts` / `src/tools/`.
5. Report accurate capability flags. Do not register placeholders as callable.
6. Add deterministic unit/fixture tests; live website probes remain opt-in and redacted.

## Non-goals
Never force website model results into fabricated OpenAI `tool_calls`. Do not assume DeepSeek, Doubao and Gemini share session schemas. Avoid premature plugin discovery, configuration DSLs, a universal browser scraping framework, automatic login/cookie scraping, CAPTCHA/WAF bypass, or public free-proxy hosting.
