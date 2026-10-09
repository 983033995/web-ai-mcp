# 本地验证记录

## 2026-10-09：npm 包验收

- 项目自身代码选择 MIT；npm bin 和文件白名单已配置，版本为 0.1.1。
- strict 类型检查、构建及 35 项确定性测试通过，包括固定 WASM 下载、哈希校验、缓存复用、损坏文件保留和失败时不落盘。
- 真实 tarball 含 30 个白名单文件，没有上游源码、WASM、source maps、凭据或会话数据。
- 在临时目录安装 tarball，通过 npm exec 检查 help/version/env-file/setup，并使用安装后的 bin 完成六工具发现、聊天、续聊、重启恢复、思考、文件与会话管理的本地 smoke。
- [PR #7](https://github.com/983033995/web-ai-mcp/pull/7) 的 Node.js 20/22/24 CI 均通过，包括隔离安装 npm 包。
- [发布工作流验证模式](https://github.com/983033995/web-ai-mcp/actions/runs/37926416687)通过：构建、35 项测试、本地与包 smoke、安装后首次 WASM 真实下载及哈希校验成功；Publish 步骤明确跳过。
- 本机首次真实下载受网络影响失败，GitHub-hosted runner 的真实下载验收通过。维护者随后完成 npm 首发和 trusted publisher 配置，registry 已验证 web-ai-mcp@0.1.1、MIT 与 tarball 哈希一致。0.1.2 将通过 GitHub Release 触发自动发布，最终结果以对应 Actions 运行及 registry 版本为准。

以下为此前网站及源码验证记录。

验证日期：2026-10-08（Asia/Shanghai）。运行环境：macOS、Node.js v26.7.0。

## 实际执行结果

| 检查 | 结果 | 证据范围 |
| --- | --- | --- |
| `npm install` | 通过 | 已生成依赖锁文件 |
| `npm run setup:upstream` | 通过 | 导入固定提交的 Web 参考源和 WASM，未导入官方 API client |
| `npm run build` | 通过 | TypeScript 编译及 WASM 复制成功 |
| `npm run typecheck` | 通过 | strict 类型检查 |
| `npm test` | 32 项通过 | SSE、PoW、transport、MCP 工具、文件边界、持久化与会话状态 |
| MCP Inspector `tools/list` | 通过 | 构建产物通过 stdio 暴露六个预期工具 |
| `npm run smoke:local` | 通过 | loopback Web fixture → 实际 HTTP/PoW → 构建产物 → MCP stdio |
| 本人账号网站 smoke | 通过 | 普通聊天、续聊、思考、文件上传及文件对话续聊 |
| Git 排除检查 | 通过 | `.env` 和上游 WASM 均被忽略 |
| 会话持久化与默认绑定 | 通过 | 本地和真实网站 smoke 均在 MCP 进程重启后续聊成功 |
| token 更新提示 | 通过 | 合成无效 token 的真实网站 MCP 调用返回认证错误和更新/重启提示；未输出用户凭据 |

网站验证从项目 `.env` 加载用户提供的凭据，未输出或保存 token、上游会话 ID、文件 ID、对话正文。上传对象仅为脚本自动生成的非敏感 `fixture.txt`，目录被临时显式 allowlist；测试结束后删除本地 fixture，网站测试对话保留在本人账号历史中。

## 真实网站验收

- 六个工具均可发现；DeepSeek 为 active，Doubao 为 not_implemented，搜索关闭。
- 普通聊天返回答案和本地 `session_key`。
- 后续调用沿用同一个 key，并成功回忆上一轮的随机测试标记。实现使用返回的真实 response message ID 作为下一轮父消息；本地 fixture 另行断言远程 session 和 parent 一致。
- 思考模式正确返回思考文本与最终答案，计算测试结果正确。
- 文件上传完成后才发送分析请求；文件分析返回 key，使用该 key 追问成功。
- 会话列表不暴露远程状态；本地关闭后及未知 key 均返回错误，不创建新网站对话。

实测发现当前网站的思考片段类型为 `THINK`，已与参考源的 `THINKING` 一起支持，并用合成内容补充回归 fixture。测试未将任何网站对话正文加入 Git。

后续长回复 MCP 讨论发现：网站压缩流中的路径与操作分别继承，切换至答案片段时即使出现新路径，省略的操作仍为上一条 `APPEND`。已修复默认 `SET` 导致答案反复覆盖的问题，并增加合成回归 fixture。思考 smoke 的数值检查也改为只检查最终答案段，避免思考文本中的正确数字掩盖正文问题；修复后构建、25 项测试、本地 smoke 及真实 MCP 长回复调用通过。

## 复现

安装、导入上游源并构建后运行：

```bash
npm run typecheck
npm test
npm run smoke:local
```

MCP Inspector 使用合成 token 检查工具发现，不联系网站：

```bash
npx -y @modelcontextprotocol/inspector --cli node dist/index.js \
  -e DEEPSEEK_USER_TOKEN=local-discovery-placeholder --method tools/list
```

明确授权的本人账号网站验证（凭据已保存在被忽略的 `.env`）：

```bash
node --env-file=.env scripts/smoke-mcp.mjs --live --files
```

`--files` 仅上传脚本创建的非敏感 fixture；省略该参数可只验证聊天与思考。服务器本身不自动加载 `.env`，正常接入由 MCP 客户端传入环境变量。脚本失败时只报告步骤和已知错误码，不打印敏感响应内容。

## 验证边界

HTTP 401/403/429/500、业务拒绝、坏 JSON、文件解析失败、损坏或截断 SSE、整轮超时、取消、失效会话、并发请求与路径/配额限制由确定性测试覆盖。未在真实网站上刻意制造凭据过期、限流、WAF 或 CAPTCHA。

持久化增量：默认 TTL 为0；原子存储不含 token、消息或消息派生标题；命名会话、项目默认、重启恢复、跨进程锁、pending/uncertain 阻断和损坏存储保护已覆盖。真实网站对合成无效 token 返回 HTTP200/code40003，现已通过 MCP 明确提示更新 `DEEPSEEK_USER_TOKEN` 后重启；HTTP401 也走同一提示。403/429 不误报为 token 过期。

网站 smoke 证明当前本人账号和当前网站接口可用，不保证后续私有接口稳定。上游源码及 WASM 的许可/再分发审查仍未完成；本次没有发布或提交这些文件。Doubao、网站搜索及 HTTP MCP transport 仍不在本次实现范围。
