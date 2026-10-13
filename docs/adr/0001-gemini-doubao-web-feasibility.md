# ADR 0001：Gemini Web 与 Doubao Web 作为免费网页 Provider 的可行性

- **状态：** Accepted（研究结论）— **默认 no-go 实现**；仅在满足下文「放行条件」后才可改为实施。
- **日期：** 2026-10-13
- **关联：** [Issue #5](https://github.com/983033995/web-ai-mcp/issues/5)；用户目标为使用**网页版免费额度**，而非官方付费 API。
- **范围：** Gemini 网页登录态、豆包网页登录态；并附带 Issue #5 中 DeepSeek Web Search 的 go/no-go。  
  **不在范围：** Google AI Studio / Gemini API、火山方舟 ARK、DeepSeek 开放平台等官方付费或配额 API 接入评估（可另开 ADR）。

## Context

### 产品目标与约束

web-ai-mcp 的 MVP 只暴露**用户本人网页会话**给本地 MCP 客户端（见 [PRD](../PRD.md)、[ARCHITECTURE](../ARCHITECTURE.md)）。用户希望在 DeepSeek Web 之外，继续用 **Gemini 网页**与 **豆包网页**的免费聊天能力，而不是切换到官方付费 API。

本仓库的硬边界（[AGENTS.md](../../AGENTS.md)、[SECURITY](../SECURITY.md)）包括：

- 不自动登录、不刮取浏览器 Cookie、不做账号池 / 凭据轮换。
- 不绕过 CAPTCHA / WAF / 限流。
- 不明示注册未经验证的 MCP 工具；占位 provider 不可调用。
- Provider 私有鉴权、传输、会话 lineage 必须落在 `src/providers/<id>/`，且有确定性测试后再显式注册。

### DeepSeek Web 先例（可对照的「网页免费」路径）

当前唯一已实现 provider 依赖：

- 用户**手工**从本人浏览器 Local Storage 复制 `userToken`（`DEEPSEEK_USER_TOKEN`）。
- 纯 Node 传输 + 固定上游 PoW WASM（可取消的 worker），无常驻浏览器。
- 会话 fail-closed、路径白名单、凭据不落盘、不自动重试模糊写。

因此「网页免费」在本仓可行的前提是：**凭据形态简单、挑战可本地复现且许可清晰、不依赖常驻浏览器或对抗性签名**。DeepSeek 接近该形态；Gemini / 豆包公开与社区证据表明它们**显著偏离**该形态。

### 证据摘要（研究时点 2026-10）

| 对象 | 社区/公开路径概览 | 与本仓边界的冲突点 |
| --- | --- | --- |
| **Gemini 网页** | 非官方实现常见依赖 `__Secure-1PSID` 等多 Cookie；部分路径需 BotGuard / 常驻 Chrome；网页产品面变更频繁 | Cookie 多且易失效；常驻浏览器违背「纯 Node + 显式凭据」；`robots.txt` 对 `/app/`、`chat/` 等路径限制使合规模糊偏负面 |
| **豆包网页** | 仓库已有 `src/providers/doubao/` **拓扑占位**（未实现）；社区路径多为 Playwright 已登录页，或 `sessionid` + `a_bogus` / `msToken` 等签名 | 签名与反爬对抗性强，纯 Node 难稳；用户协议对逆向、外挂、抓取表述偏硬；与「不绕过 WAF/CAPTCHA」冲突风险高 |
| **DeepSeek Web Search** | 上游 pin 客户端将 `search_enabled` 固定为 `false`；私有合约未验证 | 在未验证真实网站行为与权限边界前启用工具或标志，会违反「不宣称未验证能力」 |

以上为 feasibility 研究结论所用的公开/社区对照，**不是**对本仓库实现某条逆向路径的授权或教程。

## Decision

### 总决策

对 **Gemini Web** 与 **Doubao Web** 作为「免费网页登录态 MCP provider」：**默认 no-go（不实现、不注册、不宣称支持）**，直到满足「放行条件」。  
官方付费 / 配额 API **不是**本 ADR 的替代交付目标；若将来改做官方 API，须另开 ADR，且不得伪装成「网页免费接口」。

### Gemini Web — **No-Go（默认）**

| 项 | 结论 |
| --- | --- |
| 是否实现 `src/providers/gemini/` 并注册 MCP 工具 | **否** |
| 是否承诺免费网页额度稳定可用 | **否** |
| 与 DeepSeek 路径的可比性 | **低**：多 Cookie + 可能的 BotGuard/浏览器依赖，无法复用「单 Bearer + 可控 PoW」模型 |
| 合规与 ToS 风险 | **高 / 模糊偏负**：网页自动化与未文档化接口风险大；不得以「免费」为由绕过平台限制 |

**仅允许的下一步：** 可选的**本人账号** DevTools 观察性 spike（见下），产出笔记不得提交真实 Cookie/token；不得把 spike 代码合入可发布路径或注册工具。

### Doubao Web — **No-Go（默认）**

| 项 | 结论 |
| --- | --- |
| 是否实现 `DoubaoWebProvider` 并注册 | **否** |
| `src/providers/doubao/` 目录含义 | 继续仅作**拓扑预留**与说明（见该目录 README）；保持 `not_implemented` |
| 与 DeepSeek 路径的可比性 | **低**：常见依赖浏览器会话或请求签名（如 `a_bogus`），与本仓安全边界冲突 |
| 合规与 ToS 风险 | **高**：协议对逆向/外挂/抓取表述偏硬；默认视为不可作为正式交付 |

**仅允许的下一步：** 同 Gemini——可选本人账号 DevTools spike；或另行评估**官方**火山方舟等（超出本 ADR「网页免费」目标，需新 ADR）。

### DeepSeek Web Search（Issue #5 附带）— **No-Go（保持关闭）**

- 继续固定 `search_enabled=false`；**不**新增 search MCP 工具或配置开关。
- 仅在有**可复现的本人账号证据**（真实请求/响应形态、错误码、权限边界）并另开或更新 ADR 后，才可考虑启用。

### 放行条件（若未来要将某网页 provider 从 no-go 改为实施）

须**全部**满足后，才能开实施 PR（仍须显式注册、测试与评审）：

1. **凭据模型**可文档化，且符合本仓惯例：用户手工粘贴、不落盘到 Git、可轮换；不引入账号池或自动刮 Cookie。
2. **传输**可在无常驻浏览器、不绕过 CAPTCHA/WAF 的前提下稳定复现；若必须浏览器，须证明与 SECURITY/AGENTS 边界兼容并获维护者书面接受（默认不接受）。
3. **ToS / 许可**：维护者确认「本人账号、本地工具、非公共服务」路径可接受；不得依赖对抗性签名逆向作为唯一路径。
4. **合约证据**：会话 ID、父消息、错误码、限流行为有脱敏 fixture；能力标志只申报已验证项。
5. **工程**：通过 `WebAIProvider` 契约测试；在 `src/providers/index.ts` / MCP 工具处**显式**注册；README/PROVIDER 列表区分 active 与 not_implemented。

未满足任一条 → 保持 no-go。

## Consequences

### 正面

- MVP 与发行叙事保持「DeepSeek Web-only」，避免过早承诺免费多站能力。
- 与现有安全边界一致，降低 ToS、封号、凭据泄漏与维护崩塌风险。
- Issue #5 的研究交付物落地：有书面 go/no-go，而不是「以后再说」。

### 负面 / 代价

- 用户无法通过本 MCP **正式**使用 Gemini / 豆包网页免费额度；短期只能继续用浏览器或官方 API（后者非本 ADR 范围）。
- 社区非官方客户端可能「看起来能接」，但本仓主动选择不跟进，需在文档中解释原因，避免被理解为技术无能。
- Doubao 目录长期为空实现，需靠 README + 本 ADR 防止贡献者直接发明 endpoint。

### 风险（明确记录）

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| ToS / 封号 | 网页未文档化接口与自动化易触犯平台条款 | 默认 no-go；禁止合入绕过逻辑 |
| BotGuard（Gemini） | 可能迫使常驻 Chrome 或脆弱指纹模拟 | 视为与架构不兼容，除非放行条件 2 被显式接受 |
| `a_bogus` / `msToken`（豆包） | 签名算法变更即全断；属对抗性维护 | 不作为正式依赖；spike 不得产品化 |
| Cookie 寿命与多字段 | 运维成本远高于单 `userToken` | 不实现自动刷新/刮取 |
| 被当成「公共免费 API」 | 与 README 边界冲突 | 继续强调本人账号、本地 stdio、非公共服务 |

## 允许的下一步

1. **本文档合入 `main`**，并在 Issue #5 评论中挂链接（研究结论 Accepted）。
2. **可选 spike（非默认、不入库实现）：**
   - 仅维护者或贡献者**本人账号**；
   - 使用浏览器 DevTools 观察请求形态，笔记脱敏；
   - 可放在私人 gist / 本地笔记，**不得**向本仓库提交 Cookie、token、HAR 原件或可复现绕过脚本；
   - spike 结论若要改变本 ADR，须新 PR 更新 Status 与证据表。
3. **更新交叉引用：** `PROVIDER_GUIDE`、`CODEX_TASKS`、`src/providers/doubao/README.md` 指向本 ADR。
4. 若目标改为官方 API：新开 ADR，勿复用「网页免费」叙事。

## 明确非目标（Non-goals）

- 绕过 WAF / CAPTCHA / 限流或伪造官方客户端指纹。
- Cookie / Local Storage **自动刮取**、浏览器扩展静默导出、账号池、共享 token 服务。
- 将 Gemini / 豆包注册为可调用 MCP 工具，或在 `webai_providers` 中标为 active。
- 发明未文档化 endpoint、模型名映射或「兼容 OpenAI tool_calls」的假适配。
- 提供公共、多租户、免登录的「免费网页中转 API」。
- 以 CLIProxyAPI / 常驻浏览器农场作为本仓默认架构。

## 参考

- [docs/ARCHITECTURE.md](../ARCHITECTURE.md) — Provider-first 与 Doubao 预留槽
- [docs/PROVIDER_GUIDE.md](../PROVIDER_GUIDE.md) — `WebAIProvider` 合约与 Doubao 接入步骤
- [docs/SECURITY.md](../SECURITY.md) — 凭据与网站使用边界
- [docs/PRD.md](../PRD.md) / [docs/CODEX_TASKS.md](../CODEX_TASKS.md) — 范围与 P3 研究项
- [src/providers/doubao/README.md](../../src/providers/doubao/README.md) — 未实现声明
- [AGENTS.md](../../AGENTS.md) — 工程与安全执行规则
