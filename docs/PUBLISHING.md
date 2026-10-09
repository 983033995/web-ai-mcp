# 发布到 MCP Registry 或插件市场

核对日期：2026-10-08。以下是发布路径说明，本次没有向任何市场提交、上传或发布。

| 目标 | 当前 stdio 服务器是否适合 | 做什么 |
| --- | --- | --- |
| GitHub 源码分发 | 适合本机开发者安装 | 提供 README、版本及安装/凭据配置说明；上游参考源/WASM 仍在用户本机导入 |
| npm + 官方 MCP Registry | 适合本地 stdio MCP | 先发布可安装 npm 包，再用 server.json 向 Registry 登记元数据与环境变量 |
| Codex 本地/仓库市场 | 适合本地分发 | 将 MCP 连接和使用说明打成插件，加入仓库市场目录；它与公共插件目录不同 |
| ChatGPT/Codex 公共插件目录 | 当前 stdio 无法直接按常规流程提交 | 官方要求提交远程 HTTPS MCP；本地 MCP 支持需联系 OpenAI。HTTP transport、用户隔离和远程认证尚未实现 |

## 当前发布阻塞

- `package.json` 仍为 `private: true`、`UNLICENSED`，没有可执行包入口及发布文件白名单。本次不擅自更改许可或取消 private。
- PoW WASM 的来源与再分发许可没有完成独立审查；不能把当前 `dist/`（含 WASM）直接公开打包。当前构建还会编译被忽略的参考源，应在发布打包时剔除无运行时用途的第三方代码。
- 这是用户本人 DeepSeek 网站账号的私有接口适配器。市场上架不等于获得网站官方 API 授权；公开材料须明确它不是官方 API，并说明凭据、数据流和限制。

## 推荐：先 npm，再 MCP Registry

在解决许可和打包问题后：

1. 确定公开包名称、版本和发布账号。在 `package.json` 配置 bin、files、许可和 `mcpName`。GitHub 验证命名空间示例为 `io.github.983033995/web-ai-mcp`，最终值以发布账号验证结果为准。
2. 用文件白名单只包含运行所需文件和说明；排除 `.env`、`.web-ai-mcp/`、`.validation-*/`、测试素材、上游参考源及未经授权再分发的 WASM。
3. 验证干净安装、构建、测试、MCP 工具发现以及 stdio 纯 JSON-RPC；检查 npm tarball 的每一个文件。
4. 发布 npm 包。Registry 本身只托管元数据，不托管代码或二进制包。
5. 按官方 quickstart 使用 `mcp-publisher init`、GitHub 身份验证和 `mcp-publisher publish`，生成/验证 `server.json`，登记 npm 包版本、stdio transport 和需要用户配置的环境变量。
6. `DEEPSEEK_USER_TOKEN` 必须声明为用户提供的秘密变量；不能包含发布者 token。公开配置同时说明 `WEB_AI_PROJECT_ROOT`、`WEB_AI_SESSION_TTL_MINUTES=0`、允许上传的根目录，以及私有会话存储。

官方 Registry 文档：

- https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx
- https://github.com/modelcontextprotocol/registry/blob/main/docs/design/ecosystem-vision.md

## Codex 仓库市场

官方当前支持 root `plugin.json` 和 `mcp.json` 的可移植 Agent Plugins 包，以及兼容的 `.codex-plugin/plugin.json` 结构。仓库市场位于 `.agents/plugins/marketplace.json`，插件路径相对于市场根目录。打包后通过 `codex plugin marketplace add <owner/repo>` 分发给使用该仓库市场的用户。这里的占位目录/仓库不是本项目已有的发布产物。

不要把本地/团队市场成功安装误写成已进入公共目录；也不要将任何用户凭据打入插件 ZIP。插件的会话使用说明应引导 agent 保存本地 conversation_id，或使用命名会话与 make_default。

官方文档：

- https://developers.openai.com/plugins/build/plugins

## OpenAI 公共插件目录

官方当前流程：验证开发者身份 → 上传插件 ZIP → 连接并扫描 MCP → 提供测试账号、5 个正向测试、3 个反向测试和演示录像 → 提交审核 → 通过后自行选择发布。

普通 MCP 提交需要远程 HTTPS 地址、域名验证、认证与隐私/支持/服务条款页面。本项目没有远程 transport；要走这条路线，需要另立远程、多用户、凭据保护与许可审查任务。当前不能拿本机 `node dist/index.js` 当成公共 HTTPS MCP 地址。

官方文档：

- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks
