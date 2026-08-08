# Northstar Local Dashboard

Windows 11 本地开发者控制台的第一版 MVP：集中查看 GitHub 项目进度，以及自动读取本机 Codex / Claude Code 使用量。

## 启动

需要 Node.js 16+。在 PowerShell 中运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\start-windows.ps1
```

或：

```powershell
npm start
```

然后打开 `http://127.0.0.1:4173`。

## 当前功能

- GitHub：仓库概览、Issue、最近 Release、Issue 标签聚合的计划看板。
- AI 使用量：Codex / Claude Code 的今日、本月、预算、session、近 14 日趋势与模型分布。
- 设置：配置 GitHub owner、多个仓库和只读 token；AI usage 由本机日志自动读取。
- 本地优先：服务只监听 `127.0.0.1`，配置和用量数据保存在浏览器 localStorage，不写入代码仓库。

## GitHub Token 建议

公开仓库可以留空 Token。私有仓库请使用 fine-grained Personal Access Token，并只授予 Metadata、Issues、Contents 的 Read 权限。

## Privacy / 开源仓库注意事项

- 服务只监听 `127.0.0.1`，不会绑定公网地址。
- GitHub 配置、token、usage 汇总结果保存在浏览器 `localStorage`，不会写入仓库文件。
- 自动同步只会把 GitHub owner/repo/token 发给本机 `/api/github`，再由本机服务请求 GitHub API；AI usage 不会上传到 GitHub。
- `/api/usage` 只返回汇总后的 token、session、模型占比和趋势，不返回本机 `.codex` / `.claude` 路径或原始日志内容。
- 静态文件服务只开放 `/app/*`，不会把 `.git`、源码根目录文件、env 文件等作为静态资源暴露。
- `.gitignore` 已忽略 `.env*`、日志、usage 导出、本地数据目录和 `*.local.json` / `*.private.json`。不要把真实 token 或原始 usage 日志写进源码文件。

## AI Usage 数据源

默认扫描 `%USERPROFILE%\.codex\sessions` 和 `%USERPROFILE%\.claude` 下的本地 JSON / JSONL 日志，并只保存汇总后的 token、session、模型分布、趋势和可见的 limit 快照。也可以在启动前通过 `CODEX_USAGE_PATH` / `CLAUDE_USAGE_PATH` 覆盖路径。

## 后续建议

1. 增加 Windows 计划任务，每隔 15 分钟刷新并保存 GitHub 快照。
2. 增强 Claude Code subscription / API usage 数据源接入。
3. 接入 GitHub Project V2 GraphQL，替换当前基于 Issue label 的轻量计划看板。
