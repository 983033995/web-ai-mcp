# 豆包 HTTP 风控与回复解析调查

2026-10-14（Asia/Shanghai），续接 Qoder 会话 `0dc4d6b2-07b0-48c1-9f38-e39ecc095918`。此记录只包含脱敏结论，原始请求、Cookie、签名、挑战和回复保存在被 Git 忽略的本机私有目录中。

## 已确认的事实

| 对照 | 实际结果 | 能证明什么 |
| --- | --- | --- |
| 早先保存的失败流 | HTTP 200，`SSE_HEARTBEAT → STREAM_ERROR → SSE_REPLY_END`，`error_code=710022004`；没有 `SSE_ACK` | 请求在会话受理确认前被网站风险服务要求验证，不能归因于错误的续聊父消息 |
| 失败流的 decision | `code=10000`、`from=shark_admin`、`type=verify`、`subtype=slide`、`verify_scene=doubao_message_web`；没有直接验证 URL | 官方滑块挑战；响应没有解释命中了哪条风险规则 |
| 登录网页普通聊天及同会话追问 | 两轮均得到测试标记，页面无可见验证码 | 网页登录与网页对话正常；单独这一项不能证明 Node HTTP 恢复 |
| 当前网页请求与旧配置 | `sessionid` 与 CSRF 值一致；`a_bogus`、`msToken`、`web_tab_id` 和部分 Cookie 有变化 | 存在请求上下文变化，不能单凭这些差异确定触发项 |
| 当前配置，产品 Node HTTP 首轮 | `SSE_ACK` 后收到完整答案与结束事件，但原解析器报 `malformed_sse` | 网站已经受理；客户端缺少 `CHUNK_DELTA` 支持 |
| 修复后回放同一真实响应 | 精确还原首轮标记及完整回复 lineage | 修复了真实协议缺陷，无需再次发送首轮问题 |
| 产品 Node HTTP 同会话追问 | 精确回忆首轮标记，conversation ID 保持一致，回复可续聊 | 真实 HTTP 续聊成功 |
| 原来的完整配置，单次独立 HTTP 对照 | 也得到完整答案与可续聊状态 | 不能认定旧 Cookie、URL 或签名必然失效；“刷新参数才恢复”的解释不成立 |

没有修改代理、账号、地区、设备指纹或网站限制，也没有完成或绕过验证码。早先触发、后来恢复的服务器内部原因无法由这些客户端记录确定；账号/IP 风险、频率窗口或签名绑定正文都没有足够证据。不要把相关性写成根因。

## 已定位并修复的代码问题

请求声明 `sse_recv_event_options.support_chunk_delta=true`，解析器却把 `CHUNK_DELTA` 当成未知事件。这会将已经成功的请求报成失败，并阻止提交可续聊状态。早先排查连续发送新消息，但是否由此触发网站风控仍未证实。

官网客户端的 `writeChunkDelta` 使用上一次单个 content-block 补丁确定消息与块；TTS 或元数据补丁不会替换这个上下文。项目现在按这一语义追加文本，并保持缺失上下文、坏字段和截断流的失败保护。测试只使用合成数据，没有复制官网代码或私有回复。

收到 `captcha_required` 后，HTTP 客户端会阻断后续所有聊天请求，直到 MCP 重启并重新创建客户端。第一轮若已经收到 ACK，原有会话仍标记为不确定；本地阻断的新请求没有网站写入。错误提示明确说明原网页不一定显示 Node 请求的挑战，不再要求用户盲找验证码。

## 再次遇到风控时

1. 停止发送消息；不要自动重试或循环测试新会话。
2. 在官方验证界面出现挑战时由本人手动处理。已加载的官网 VerifyCenter 使用 `autoRender({ verify_data: decision, ... })` 显示服务端挑战；项目尚未实现挑战移交接口，不会伪造验证 URL，也不会承诺重开网页就能解除 Node 请求的挑战。
3. 若需要更新配置，从本人同一次正常网页 `POST /chat/completion` 请求取得完整 Cookie、URL 和 User-Agent，仅保存到本机私有文件并重启 MCP。旧配置和当前配置应分别保留，避免丢失对照证据。
4. 通过一次明确授权的产品 HTTP 探测确认恢复。网页正常、类型检查或本地 fixture 通过都不能替代这一验证。

本次成功只证明当前账号、当前网络与当前接口下的完整回复和续聊；不保证后续风控不会再次触发。

## 本轮验收

本机 Node.js `v26.7.0`：`npm install`、`npm run setup:upstream`、strict 类型检查、构建、85 项确定性测试、本地双 Provider 冒烟、真实 npm tarball 隔离安装冒烟及 `git diff --check` 均通过。MCP Inspector 通过 stdio 发现豆包聊天、列出会话、关闭会话及 provider 列表四个工具。

最终 `scripts/probe-doubao.ts --live` 直接调用修复后的产品 Provider，两条真实 HTTP 消息验证完整首轮答案、可续聊状态和同会话随机标记回忆，退出码为 0。没有实测思考、文件上传或网页搜索。未运行 Node.js 20/22/24 CI，未提交、推送或发布。
