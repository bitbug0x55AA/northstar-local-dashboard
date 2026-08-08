# Northstar Local Dashboard

Windows 11 本地开发者控制台的第一版 MVP：集中查看 GitHub 项目进度，以及从本地导入 Codex / Claude Code 使用量。

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
- 设置：配置 GitHub owner、多个仓库和只读 token；粘贴 JSON 导入 AI usage。
- 本地优先：服务只监听 `127.0.0.1`，配置和用量数据保存在浏览器 localStorage，不写入代码仓库。

## GitHub Token 建议

公开仓库可以留空 Token。私有仓库请使用 fine-grained Personal Access Token，并只授予 Metadata、Issues、Contents 的 Read 权限。

## Usage JSON 示例

```json
{
  "codex": { "todayTokens": 184000, "monthTokens": 2960000, "budgetTokens": 4400000, "sessions": 17, "source": "local", "reset": "2d 14h" },
  "claude": { "todayTokens": 127000, "monthTokens": 2180000, "budgetTokens": 3600000, "sessions": 12, "source": "local", "reset": "—" },
  "daily": [36, 52, 44, 61, 48, 76, 68, 83, 70, 88, 64, 92, 74, 82],
  "models": [
    { "name": "Claude Sonnet", "value": 48, "color": "blue" },
    { "name": "GPT-5-Codex", "value": 37, "color": "teal" },
    { "name": "Claude Opus", "value": 15, "color": "amber" }
  ]
}
```

## 后续建议

1. 增加 Windows 计划任务，每隔 15 分钟刷新并保存 GitHub 快照。
2. 增加 Claude Code / Codex 本地日志解析器，把 JSON 导入变成自动采集。
3. 接入 GitHub Project V2 GraphQL，替换当前基于 Issue label 的轻量计划看板。
