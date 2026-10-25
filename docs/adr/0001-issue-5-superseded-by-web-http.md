# ADR 0001：Issue #5 研究结论已被后续 Doubao / Gemini 网页 HTTP 工作取代

- **状态：** Accepted
- **日期：** 2026-10-23
- **关联：** [Issue #5](https://github.com/983033995/web-ai-mcp/issues/5)；PR [#12](https://github.com/983033995/web-ai-mcp/pull/12)–[#24](https://github.com/983033995/web-ai-mcp/pull/24)；[PROVIDER_GUIDE](../PROVIDER_GUIDE.md)、[ARCHITECTURE](../ARCHITECTURE.md)

## Context

Issue #5（2026-10-08）要求**仅做研究**：评估 DeepSeek Web Search 与 Doubao 网页 Provider 的可行性，Done 条件是短 ADR 与 go/no-go；MVP 仍须 DeepSeek-only。

2026-10-13 曾在 Issue 评论中起草「默认 no-go」研究结论（对应未合入 main 的 ADR 草稿）。其后用户**明确要求**接入豆包 / Gemini 的**本人网页免费登录态 HTTP**能力，并经多轮 PR 落地：

- Doubao：专家思考与 TXT（#12）、图/视频生成与参数（#13）、媒体下载（#15）、参考图等后续修复（#20 等）
- 长聊天后台任务（#14）
- Gemini：StreamGenerate / 媒体 / 多账号冷却等（#16–#19、#22–#23），并去掉固定浏览器运行时依赖（#24）

因此 #5 原「研究后默认不实现」结论与当前源码事实不一致，需要正式收口，避免文档与 Issue 继续指向过时的 no-go。

## Decision

1. **Issue #5 的 Doubao /（延伸）Gemini 网页可行性研究视为已被后续显式实现工作取代**，不再以 2026-10-13 的默认 no-go 作为产品立场。
2. **当前产品立场：**
   - **DeepSeek Web**：稳定能力（npm 已发布路径的主路径）。
   - **Doubao Web HTTP**：实验性；需本人 Cookie / 捕获的 chat URL / User-Agent；受网站风控与私有接口变化影响。
   - **Gemini Web HTTP**：实验性；当前源码可用；**尚未**包含在已发布的 `web-ai-mcp@0.4.0` 中，须源码/`dist` 接入。
3. **DeepSeek Web Search**：仍保持关闭（`search_enabled=false`）；启用前须另开证据充分的 ADR / Issue，不受本 ADR「取代 #5 Doubao 部分」影响。
4. **硬边界不变：** 不自动登录、不刮 Cookie、不绕过 CAPTCHA/WAF、不公开免费中转；凭据不落盘到会话存储或 Git。

## Consequences

- 关闭或改名 Issue #5 时，应指向本 ADR 与 #12–#24，而不是重新执行「默认 no-go」研究 Done 条件。
- `docs/PROVIDER_GUIDE.md`、架构图与 README 版本说明须与上表一致；未配置凭据的实验性 provider 不得在 `webai_providers` 中伪装为已实现可用。
- 2026-10-13 Issue 评论中的 ADR 草稿路径（未合入 main）仅作历史记录，**不以**其 no-go 正文为准。
