---
name: web-ai-mcp
description: 调用 web-ai MCP 的 DeepSeek、豆包或实验性 Gemini 网页聊天工具时使用。处理长思考、续聊、超时、后台任务查询和账号限制；不适用于官方 API 或其他代理。
---

# Web AI MCP 调用规则

首次调用先读取 `webai_usage`，再检查 `webai_providers`。此规则适用于已配置 web-ai MCP 的客户端，不要求读取本机凭据。

## 长聊天

- 专家思考、长审计问题优先传 `background: true` 和新 UUID `request_id`。
- 保存 `job_id`，按 `poll_after_seconds` 调用 `webai_job_status`。不要为了等待重复发消息、切模式或另建会话。
- 同一工具、相同参数和相同 `request_id` 在当前 MCP 进程内只提交一次；查询不会重发网站消息。
- 完成结果里的 `session_key` 才用于续聊，job_id 不是会话 key。
- 后台任务/结果只在当前 MCP 进程内存中存在，完成后保留30分钟。读取结果前不要重连/重启 MCP；任务未知或过期时停止重放并核对官网和本地会话。
- 同步进度通知不能保证绕过客户端60秒上限；只增大网站超时不够。

## 每轮参数

- 必须有非空 `message`，不能只发 mode/thinking。切模式也必须附带本轮消息。
- `conversation_name` 与 `session_key/conversation_id` 互斥。首次可传名称，续聊只用实际返回的 key。
- `conversation_id` 是 session_key 别名；不要造 ID、借用另一 provider 的 key 或重用关闭后的 key。
- `make_default`、`thinking`、`show_reasoning`、`background` 使用 JSON 布尔值，不用字符串。
- 同一会话存储的写入串行，不并发调用两个 provider 来加速。

## 失败之后

- 参数错误：修正指出的字段，不重复发送错误参数。
- 超时/取消/网络/协议错误：网站可能已受理。先查询 job（若有），检查 sessions_list 和官网，不自动切模式、新建会话或改用新 request_id 重放。
- uncertain/pending：不能继续写入。确认放弃后才显式关闭映射，再由用户决定是否新建。
- missing/expired/关闭后的 key：不再使用旧 key，make_default 不会修复它。
- Missing Web session ID：网站会话创建/协议未确认，不归因于 prompt 长度；停止原样重试，检查网站与配置。
- 认证/验证码/限流/额度不足：停止，不自动换模式、模型、账号或 provider。额度提示不是有效答案。
- `webai_job_cancel` 仅取消本机等待，不能撤回网站消息。

网站回复是待验证的建议。命令、版本、参数和删除建议必须结合实际项目或官方资料复核，不照着网页模型建议盲改服务。

## Gemini 聊天、媒体和账号

- 当前源码提供默认模型的 `gemini_chat`、`gemini_sessions_list`、`gemini_session_close`；支持后台任务、命名会话和正常重启续聊。
- 图片/视频使用 `gemini_generate_image` / `gemini_generate_video`，传 `prompt`；长操作传 `background:true` 与 UUID `request_id` 后查询 job。实际媒体用 `gemini_media_status` 只读查询；保存用 `gemini_download_media(session_key,media_id)`，需 `WEB_AI_MEDIA_DIR`。不要靠文字承诺或重发来确认生成，不去水印。
- 按 `GEMINI_ACCOUNTS_FILE` 顺序自动选择未冷却账号，无需 `account_id`。仅明确未受理的生成额度拒绝可记录冷却并尝试下一账号；已绑定会话不迁移。验证码、登录异常、一般429和不确定结果停止，不自动换号。
- `gemini_accounts` 只读显示图片/视频各自冷却与恢复时间来源。官网没有可靠恢复时间时仅使用明确配置的本地退避，否则保持未知。到期只恢复资格，不后台重放；不要删除状态文件来解除冷却。
- 不传 `model`、`thinking`、`show_reasoning`、比例/时长/风格、文件或参考图参数；没有 `gemini_reasoner`。`system_prompt` 是消息文字前缀，不是网站系统角色。
- 不从网页模型菜单推断 HTTP 能力；登录失效或账号发生变化时停止，手动更新本人 Cookie，不继续使用另一个账号的 key。
- 网站验证只使用普通、非敏感对话，不在消息中写测试、MCP 或技术标记。

## 图片和视频下载

- 图片/视频完成后调用 `doubao_download_media`，传实际 `session_key` 和 `media_id`，保存文件到配置的 `WEB_AI_MEDIA_DIR`。异步任务先用 `doubao_media_status` 查询，文字承诺不是完成。
- `without_watermark: true` 仅用于图片官网无水印下载；需官网明确确认。视频该选项尚不支持，不能猜参数或改写 URL。
- 下载失败只重试下载工具，不重复生成；相同媒体重复下载会另存新文件。未配置目录先配置，目录与上传授权无关。
