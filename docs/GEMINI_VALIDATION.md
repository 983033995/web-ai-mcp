# Gemini 网页默认聊天接入与验证

日期：2026-10-20。Gemini 为当前源码中的实验性 provider，尚未包含在已发布的 `web-ai-mcp@0.4.0` 中。仅连接本人获准使用的 `gemini.google.com` 账号，不是官方 Gemini API 或 OpenAI 兼容代理。

## 实现范围

- `gemini_chat`：网站默认模型、普通文字聊天、命名/默认会话、`session_key` / `conversation_id`、后台任务和正常重启续聊。`system_prompt` 仅作为文字前缀。
- `gemini_sessions_list` / `gemini_session_close`：只读列出或忘记本地映射，不删除网站历史。
- 每轮先读取网站登录上下文，确认邮箱与请求 token 后才提交一条消息；账号哈希不匹配时拒绝旧会话。仅持久化会话、回复、候选标识和账号哈希。
- 只有配置本人 Cookie 和正常 User-Agent 时才注册 Gemini。Gemini-only 启动不需要 DeepSeek token 或 PoW WASM，工具发现不访问网站。

不支持指定模型、思考开关/思考文本、文件、网站搜索控制、图片、视频、Deep Research 或 Gems。没有 `gemini_reasoner`。当前浏览器模型菜单中的项目不构成 HTTP 能力证明。

## 证据与边界

### 接入前的 HTTP 验证

本人账号的三次独立 Node 进程验证了 `StreamGenerate` 路径：首轮完整回复约 14.5 秒、续聊约 8.5 秒、关闭浏览器后再次启动进程续聊约 5.2 秒。三轮网站会话标识一致，回复及候选标识推进；后两轮仅发送会话信息和本轮问题，没有重传前文。

浏览器使用的较新 `processSession` 通道只在独立 Node 探测中完成握手、消息提交和控制帧接收，未确认完整答案；未重放该消息或继续使用那条不确定会话。本实现不使用该通道，也不自动回退浏览器。

### 确定性验收

测试全部使用合成 HTML、Cookie、会话标识和响应，不含真实账号、网站回复或导入的第三方源码。

| 位置 | 验证内容 |
| --- | --- |
| `tests/gemini-client.test.ts` | 默认聊天与续聊、每轮刷新请求上下文、登录失效/匿名页面、账号变化、重定向、验证码、401/403/429/500、单次写入、取消/超时及响应大小限制 |
| `tests/gemini-stream.test.ts` | UTF-8 分块与长度帧、完整终止、缺失会话标识、错误/截断/冲突数据、超限和取消 |
| `tests/gemini-tools.test.ts` | 参数拒绝、会话隔离、名称/默认与重启恢复、未知/关闭/不确定 key、缺少 ID 时不可续聊、错误脱敏 |
| `tests/long-tools.test.ts` | Gemini 后台任务、幂等提交、只读查询、取消保护，沿用原有两种 provider 的验证 |
| `scripts/smoke-gemini.mjs` | 本地 HTTP → 实际 stdio MCP，7 个工具、后台续聊、重启、凭据/消息不落会话存储，以及不完整流在重启后仍阻断续聊 |
| `scripts/smoke-package.mjs` | npm tarball 包含 Gemini 编译模块；隔离安装后的真实 CLI 和三种 provider 的本地 fixture |

### 本人账号实际 MCP

使用 `scripts/probe-gemini.ts --env-file /private/path/.env --live` 验证实际构建后的 stdio 入口。该脚本显式授权三条普通故事消息，覆盖后台首轮、同会话回忆、MCP 进程重启后的回忆；不向网站发送测试、MCP 或技术标记，不自动重发。

本人账号实际构建后的 MCP stdio 已完成三轮验收：后台首轮成功；第二轮准确回忆要求的颜色与地点；关闭客户端并启动新的 MCP 进程后，第三轮正确回忆人物、物品、颜色和地点。三轮网站会话一致，回复及候选标识各自推进；会话文件不含消息、Cookie、请求 token 或邮箱。浏览器在这组三轮开始前已关闭。只测试网站默认模型，没有推断具体模型名称。

接入过程中，另有四条消息暴露了客户端解析器的兼容差异：实际长度为 UTF-16 JSON 长度加两侧换行，终止帧后有 `e` 统计帧，`af.httprm` 数字会随轮次变化且其时间值不必与 `di` 相等。全部捕获响应经离线解析确认完整；没有重发这些消息或恢复不确定映射，而是通过本地关闭工具明确结束对应映射，网站历史不变。只采用合成的同结构 fixture 做回归，原始响应不提交。

最终验收的第二条提问只询问颜色和地点，最初脚本却额外断言物品名称，导致脚本报 `context_not_preserved`；实际回复正确回答了两个被问到的要点。没有重发首轮或第二轮，而是修正后续可复用脚本的提问，并在新进程的第三轮显式询问人物、物品、颜色和地点，验收通过。这是验收断言修正，不是会话恢复或网站请求重试。

本机 `npm run typecheck`、`npm run build`、`npm test`（192 项）、三种 provider 的 `npm run smoke:local`、Gemini-only MCP Inspector 和三者组合的 21 工具发现、`npm run smoke:package` 均已通过。隔离安装实际 tarball 也通过三种 provider 的本地 fixture 与后台任务验证，不包含 WASM、凭据或私有验证文件。CI 结果以对应 PR 的 Node 20/22/24 为准。

## 错误与数据处理

- 不重试网站聊天写入。失败可能推进网站状态时标记 uncertain；未知、关闭、被中断或不确定的本地 key 不会悄悄变成新会话。
- 缺少完整回复标识时，仅返回有用文字和不可续聊警告，不返回可用 key。流截断或错误帧不能当作完整答案。
- 验证码使该客户端停止后续网站调用，直至用户通过官网处理并显式更新配置/重启；不伪造身份、解挑战或切换账号。
- Cookie、请求 token、邮箱、原始响应与消息不写入产品会话存储或 Git。网站验证输出仅为脱敏步骤摘要。临时凭据在验收结束后清除。
- 不强制过期本人凭据或刻意触发网站验证码/限流。相关故障由确定性 fixture 验证；匿名只读页面对照验证了缺少账号字段和请求 token，不发送匿名消息。

## 运行与许可限制

实测环境为 macOS、Node 26.7.0，使用本机已有代理。Node `fetch` 不自动使用系统代理；需要代理时建议 Node 24+，显式设置 `NODE_USE_ENV_PROXY=1` 和 `HTTPS_PROXY`。不修改系统设置或关闭 TLS 校验。CI 的 Node 20/22/24 仅使用本地 fixture，不能证明这些版本上的实时账号兼容性。

本版本重新取得每轮请求上下文，但不自动轮换 Google Cookie，尚未验证跨天续期或 Chromium 设备绑定凭据的长期稳定性。凭据失效应通过本人正常浏览器登录更新。

参考项目 `HanaokaYuzu/Gemini-API` 使用 AGPL-3.0；本项目没有安装、导入或分发该 Python 包，新增 TypeScript 和合成 fixture 均属于本项目。协议参考与许可边界见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
