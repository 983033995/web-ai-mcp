# npm / npx 与自动发布

包名：`web-ai-mcp`，准备发布版本：`0.1.1`。项目自身代码采用 MIT。首次 npm 发布与账号授权尚未完成；在 registry 出现该版本前，不宣称 npx 安装已可用。

## 包的边界

`package.json` 的 bin 指向 `dist/index.js`，发布文件使用白名单。仅包含项目自身 JavaScript、说明与模板；上游参考源、WASM、source maps、凭据和会话数据都被排除。`prepack` 构建源码，不执行安装期下载。

npx 首次运行或 `--setup` 从固定上游 URL 下载 WASM 到用户缓存，校验 SHA-256 后使用；它不被代理到我们的服务器，也不进入 npm tarball。下载与本机导入不解决第三方许可问题，见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## GitHub Actions

- `.github/workflows/ci.yml`：PR 和 main 推送运行 Node.js 20/22/24 的类型检查、构建、35 项确定性测试、本地 smoke 和隔离 npm 包 smoke。
- `.github/workflows/publish.yml`：GitHub Release 发布时触发。手动运行默认只验证；将输入 `publish` 设为 true 才发布。
- 发布在 `npm-release` environment 中运行，仅发布来自 main 历史的 commit；Release tag 必须与 package.json 一致，例如 `v0.1.1`。手动真正发布必须从 main 运行。
- Node.js 24、npm >=11.5.1，禁用发布 job 的 npm 缓存。先构建、测试，再检查并隔离安装真实 tarball；最终发布同一个已验收 tarball。
- 用 `contents: read` 和 `id-token: write` 支持 npm OIDC 与 provenance。不会使用 DEEPSEEK_USER_TOKEN，也不运行 live smoke。

## 首次授权

维护者需要 npm 账号并拥有包名权限。PyPI 账号无法用于 npm。当前包名查询返回未发布，最终可注册性以 npm 首次发布结果为准。

推荐先在本机完成 npm 登录和 2FA，再发布已经验收的包：

```bash
npm login --registry=https://registry.npmjs.org
npm run setup:upstream
npm run build
npm run typecheck
npm test
npm run smoke:package
npm publish --access public
```

随后在 npm 包 Settings → Trusted publishing 添加 GitHub Actions publisher：

| 字段 | 值 |
| --- | --- |
| Organization or user | `983033995` |
| Repository | `web-ai-mcp` |
| Workflow filename | `publish.yml`（不带目录） |
| Environment name | `npm-release` |
| Allowed actions | 允许直接 `npm publish` |

配置完成后，后续发布不需要长期 token。npm trusted publishing 是 npm 侧授权，GitHub Actions 文件本身不能代替这个账号操作。首次创建包若无法先设置 trusted publisher，可先本机发布；也可为首次 Actions 发布配置仅有必要权限的 `NPM_TOKEN` environment secret，首次成功后移除并改用 OIDC。不要把 npm token 发到聊天、提交到仓库或输出到日志。

官方依据：[npm trusted publishers](https://docs.npmjs.com/trusted-publishers)、[provenance](https://docs.npmjs.com/generating-provenance-statements)。

## 后续版本

1. 通过 PR 更新 package.json、锁文件版本与 README 示例。
2. 三项 CI 通过后 squash 合并到 main。
3. 在该合并 commit 创建与版本一致的 tag，再发布 GitHub Release；例如 `v0.1.2`。
4. Actions 验证并发布。核对 npm 上的版本与 provenance，再更新发布状态说明。

不要每次 main 推送就发布新包，也不要覆盖已有 npm 版本。发布失败时先看失败步骤：权限错误修复 npm 授权；版本已存在则核对是否上次已经成功，勿自动重复发布。错误版本用新的修复版本替代，必要时 deprecate 受影响版本，不改写 Git 历史。

## 其他分发方式

发布 npm 后可另行登记官方 MCP Registry；Registry 只存元数据，不托管运行中的服务。本项目仍为本地 stdio，未实现远程 HTTPS MCP，也未向 Registry 或插件市场提交。远程 transport、用户隔离及凭据托管应作为独立任务。
