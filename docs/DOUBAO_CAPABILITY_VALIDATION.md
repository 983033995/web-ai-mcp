# 豆包专家、思考与文件能力实测

日期：2026-10-14（Asia/Shanghai）。使用本人已登录网页与本机 Node.js，仅发送合成测试问题和临时生成的非敏感 TXT 文件。原始请求、Cookie、临时上传凭据、签名和回复保存在 Git 忽略目录 `.validation-doubao-capabilities/`，权限为目录 `0700`、私有文件 `0600`。

## 实际结果

| 能力 | 网页测试 | Node HTTP 诊断测试 | 当前 MCP 产品 |
| --- | --- | --- | --- |
| 专家模式 | 选择“豆包 专家”，正确计算 7560 的正因数个数为 64 | 采用网页实际参数，正确计算另一个数 9240 的正因数个数为 64；有 ACK、完整回复结束事件及答案 | 已接入 `mode=expert` 和 `doubao_reasoner`；真实 MCP 专家答案及切回快速模式后的标记回忆通过 |
| 可见思考 | 专家回复中显示思考内容；页面没有观察到单独的思考开关 | 实际响应包含 384 字的思考正文，能与最终答案分离 | 已解析真实思考容器与子块；`show_reasoning=true` 的真实 MCP 输出通过 |
| 文件上传与读取 | 上传合成 TXT，读出仅在文件中出现的标记，并正确计算三个项目的合计 89 | 先验证浏览器附件引用；再由 Node 独立申请上传位置、上传新标记文件并提交，HTTP 会话读出新标记及合计 89 | 授权目录读取、上传/CRC/提交、真实 MCP 文件读取及进程重启后的同会话追问均通过 |

最初诊断先接收完 Node 原始 SSE 再做离线结构检查，不是浏览器内 fetch，也没有拿网页答案当作 HTTP 成功证据。当时 `parseSSE` 返回 `malformed_sse`；工程接入后，同一批真实响应已经由产品解析器正确回放。最初三个诊断流均有 ACK、最终结束事件且没有 `STREAM_ERROR`；后续真实 MCP 接入验收又遇到验证码要求并停止。不要将诊断成功与最后产品验收混淆。

## 专家与思考的协议差异

网页实际专家请求：

```json
{
  "option": {
    "agent_mode": 2,
    "need_deep_think": 3,
    "model_config": {
      "model_item_key": "3",
      "model_extra_params": {},
      "reasoning_effort": 4
    }
  },
  "ext": {
    "agent_mode": "2",
    "use_deep_think": "3"
  }
}
```

网页切回快速模式后，`need_deep_think=0`、`model_item_key="0"`。这些是当次网站观察值，没有据此声称存在稳定、公开的模式映射。

真实专家回复先发送 `block_type=10040`，其内容是 `thinking_block` 容器与展示信息。可见思考正文位于以该容器为 `parent_id` 的 `10000/text_block` 子块，最终答案位于独立的顶层 `10000` 块。最初解析器要求 `10040` 也带 `text_block`，因此在首个专家 `STREAM_MSG_NOTIFY` 失败。当前实现已按父块关系分离思考与答案，并覆盖缺失、循环和重绑定父块的失败保护。

## 文件链路的协议差异

网页与 Node 实测涉及：

1. `/alice/resource/prepare_upload`：本人网页 Cookie 下返回临时上传授权及 service ID。
2. `/top/v1?Action=ApplyImageUpload`：使用该临时授权申请新的存储位置。
3. 服务端返回的上传域名 `/upload/v1/<object>`：发送合成文件字节及 CRC32；HTTP 200，业务码 `2000`。
4. `/top/v1?Action=CommitImageUpload`：提交同一次申请的 SessionKey；HTTP 200，UriStatus `2000`，返回 URI 与申请一致。
5. `/chat/completion`：通过 `10052/attachment_block` 引用新 URI，请求读取文件标记与合计。

上传只读取临时显式设置的 `WEB_AI_ALLOWED_ROOTS` 内文件，先检查真实路径。Node 上传文件使用不同于浏览器文件的标记，且聊天问题没有包含该标记；响应读出新标记，排除了只复用浏览器附件或猜测答案的情况。

上传鉴权采用网站授予的临时凭据和上传服务使用的 AWS4-HMAC-SHA256，属于正常存储权限认证；没有生成聊天的 `a_bogus`、伪造设备信息或绕过验证码。诊断签名最初误用根路径，收到 `SignatureDoesNotMatch`；根据官网上传器明确设置的 `/top/v1` 路径纠正后申请成功。这是诊断脚本错误，不是聊天风控证据。

文件聊天响应另含 `DOWNSTREAM_VERBOSE_INFO` 和 `patch_type=3` 删除占位块。最初解析器把它们当作未知事件与非法补丁，当前已修复并补充合成回归，真实 Node 文件响应回放通过。

## 验收边界

用户随后明确要求工程接入，已实现专家参数、思考分离、TXT 上传与三个调用入口。文件单次最多 5 个、每个 10 MiB、合计 20 MiB；先检查真实路径、普通文件及打开前后文件身份，再读入有界缓冲区。存储域名只接受网站返回的官方 `tos-*.snssdk.com`、`tos-*.douyin.com` 和 `*.vodupload.com` 节点；网页 Cookie 不外送，上传临时授权不落入会话存储。

文件验收曾发现地域存储节点别名被过度限制，修复后模块完成真实 storage 上传/CRC/提交；不需要私人 `X-Storage-U` 头。此前完整 MCP 验收遇到 `captcha_required` 即停止，并交由本人手动处理官网验证。

本人确认完成后，官网 SDK 回调显示 `passed`，随后网页正常回复配置测试标记。重新从同一次网页请求捕获完整配置，仅存到本机私有文件，再执行 `scripts/probe-doubao.ts --live --features`：实际 MCP stdio 四条消息全部通过，包括专家正确答案、独立思考输出、切回快速模式后的随机标记回忆、Node TXT 上传与文件标记/合计读取、MCP 进程重启后的同会话文件追问。脚本另外确认会话存储不含消息标记或 Cookie，退出码为 0。

本次结果证明手动验证及刷新请求上下文之后的产品全流程可用，不能确定之前命中的网站内部风险规则，也不保证以后不会再要求验证。没有自动解验证码、账户轮换或消息重试，未发布 npm 包。

本地 strict 类型检查、构建、101 项确定性测试、双 Provider 冒烟、39 文件真实 tarball 隔离安装以及 Inspector 六工具发现通过；[PR #12](https://github.com/983033995/web-ai-mcp/pull/12) 的 Node 20/22/24 CI 通过。文件能力当前只支持非空 TXT，其他格式未开放。
