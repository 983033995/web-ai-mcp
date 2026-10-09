# 参与开发与维护

当前项目通过 GitHub 源码分发，许可状态见 [README](README.md#隐私安全与许可) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。这些流程不改变现有许可，也不代表上游 WASM 可再分发。

## 分支与合并

- `main` 是默认分支，保存已通过检查的版本。
- 每个改动使用独立分支和 PR。Codex 创建的分支使用 `codex/<简短名称>`；其他贡献者可使用 `feat/`、`fix/` 或 `docs/` 前缀。
- PR 合并前必须通过 `Node 20`、`Node 22`、`Node 24` 三个 CI 检查，并解决评审对话。分支需与最新 `main` 保持同步。
- 使用 squash merge，合并后自动删除远程功能分支；`main` 禁止强制推送和删除。
- 单人维护阶段不强制要求他人批准，但仍要求 PR 和 CI；规则也适用于管理员。

首次维护配置通过 PR 验收后启用上述 `main` 保护。实际规则以仓库 Settings → Branches 为准，不要绕过失败的检查或将管理员绕过当作日常发布方式。

## 本地验证与 CI

从仓库根目录运行：

```bash
npm ci
npm run setup:upstream
npm run typecheck
npm run build
npm test
npm run smoke:local
```

CI 在 Ubuntu 上检查 Node.js 20、22、24，触发条件为发往 `main` 的 PR、`main` 推送及手动运行。Actions 固定为提交 SHA，仅授予 `contents: read`，不注入本人网站 token。

上游固定提交的协议参考源与 WASM 只导入 runner 本地；不缓存、上传或发布构建产物。`smoke:local` 使用 loopback fixture，不访问 DeepSeek 网站。真实网站验证仍由维护者在本机明确选择执行，见 [验证记录](docs/LOCAL_VALIDATION.md)。

修改业务代码时补充相关确定性测试。项目没有 lint 脚本，勿在 PR 中声明不存在的检查已通过。

## Issue 与 PR

使用问题反馈或功能建议表单，提供最小复现、环境、脱敏错误码和可验收的完成条件。不要提交 `.env`、token、Cookie、私有路径、会话文件、对话正文或真实私有文档。

PR 应说明具体问题、最终行为、实际验证结果和数据/权限变化。只有全部完成条件满足时才使用 `Closes #编号`；部分工作使用 `Refs #编号`。研究事项需要提交证据和结论，不能因为暂未实现而标为完成。

## 配置变更与恢复

CI 与模板通过 PR 修改并保留 Git 记录；有问题时提交修复或回退 PR，不改写已有提交历史。分支保护与合并策略由维护者在 GitHub 设置中管理；变更时记录原值及原因，只调整阻塞项，完成后恢复既定规则。

