# Future Web AI Provider guide

## Contract
Source of truth: src/core/provider.ts.

    interface WebAIProvider {
      readonly id: string;
      readonly displayName: string;
      readonly capabilities: ProviderCapabilities;
      initialize(): Promise<void>;
      chat(request: ChatRequest, session?: RemoteSession): Promise<ProviderResult>;
      analyzeFiles?(files: FileInput[], instruction: string, thinking: boolean): Promise<ProviderResult>;
    }

Providers own their upstream authentication, response parsing, challenge logic and session IDs. The core only maps local keys to **opaque provider-owned remote sessions**.

## To add Doubao someday
1. Research whether Doubao provides an authorized interface and whether web automation is permitted; record terms and limitations.
2. Implement src/providers/doubao/index.ts (only when there is real access and tests).
3. Keep Doubao cookies, authentication, web transport and session fields inside that directory.
4. Explicitly register in src/providers/index.ts and register proven MCP tools from src/index.ts.
5. Report accurate per-provider capability flags. Incomplete providers must not appear active.
6. Write deterministic unit/fixture tests and opt-in smoke tests.

## Non-goals
Never force website model results into fabricated OpenAI tool_calls. Do not assume DeepSeek, Doubao and Kimi share session schemas. Avoid premature plugin discovery, configuration DSLs or a universal browser scraping framework.
