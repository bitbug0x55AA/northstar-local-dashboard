# Northstar Local Dashboard

Northstar is a local Windows 11 developer dashboard for monitoring GitHub project activity, CI status, and local Codex / Claude Code usage.

## Start

Requires Node.js 16 or newer. In PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\start-windows.ps1
```

Or:

```powershell
npm start
```

Then open `http://127.0.0.1:4173`.

## Current Features

- GitHub: repository overview, issues, recent releases, latest GitHub Actions CI status, failed-job inspection, and an issue-label planning board.
- AI usage: local Codex / Claude Code usage, today and month totals, sessions, 14-day trend, model distribution, and visible subscription-limit snapshots.
- Settings: display name, UI language, GitHub owner, repository list, and optional read-only GitHub token.
- Local-first operation: the server listens only on `127.0.0.1`; non-secret settings and usage summaries are stored in browser `localStorage` and are not written to the repository. On Windows, the GitHub token is stored by the local service using the current user's DPAPI protection and is not stored in browser storage.

## GitHub Token Recommendation

Public repositories can usually be monitored without a token. For private repositories, use a fine-grained Personal Access Token with read-only permissions:

- Metadata: Read
- Issues: Read
- Contents: Read
- Actions: Read

## Privacy Notes For Open Source Use

- The server listens only on `127.0.0.1` and does not bind to a public network interface.
- GitHub owner/repository settings and usage summaries are stored in browser `localStorage`; the GitHub token is deliberately excluded from browser storage and repository files. On Windows it is persisted only as a DPAPI-protected blob under the user's roaming application data.
- The browser sends the token only when saving it to the local service; subsequent GitHub and CI requests omit it and the local service retrieves it from DPAPI.
- API responses include browser security headers, and state-changing local API routes reject requests with a non-local `Origin`.
- Automatic sync sends GitHub owner, repository names, and token only to the local `/api/github` endpoint. The local service then calls the GitHub API.
- AI usage is read from local logs and is not uploaded to GitHub.
- `/api/usage` returns only aggregated tokens, sessions, model distribution, trends, and visible limit snapshots. It does not return local `.codex` / `.claude` paths or raw log content.
- Static file serving is restricted to `/app/*`; repository root files, `.git`, and env files are not exposed as static assets.
- `.gitignore` excludes `.env*`, logs, usage exports, local data directories, `*.local.json`, and `*.private.json`. Do not put real tokens or raw usage logs into source files.

## AI Usage Data Sources

By default, Northstar scans local JSON / JSONL logs under:

- `%USERPROFILE%\.codex\sessions`
- `%USERPROFILE%\.claude`

Only aggregated usage data is stored. You can override the default paths before startup with:

- `CODEX_USAGE_PATH`
- `CLAUDE_USAGE_PATH`

Codex subscription-limit information is read from local Codex rate-limit snapshots when available. Claude Code subscription limits are shown only if local logs expose equivalent data.

## Personal Planner Feature Preview

The Planner is intentionally isolated behind an environment flag. To run this branch with the Planner enabled:

```powershell
$env:NORTHSTAR_PLANNER_ENABLED = 'true'
.\start-windows.ps1
```

Planner data is stored separately under `%APPDATA%\Northstar\planner` by default. Set `NORTHSTAR_PLANNER_DIR` to use another local directory. The Planner API uses `/api/planner/*` and does not modify GitHub or AI usage data.

Natural-language interpretation is optional. Configure an OpenAI-compatible local model endpoint and model name before starting:

```powershell
$env:NORTHSTAR_LLM_URL = 'http://127.0.0.1:11434/api/chat'
$env:NORTHSTAR_LLM_MODEL = 'qwen2.5:3b'
```

The model only returns proposed Planner operations. The UI previews the operations and requires confirmation before saving them. The first implementation supports manual tasks and progress logs; event scheduling, project linking, and external calendar sync remain separate follow-up work.

## Roadmap

1. Add a Windows scheduled task or background helper for persistent sync outside the browser tab.
2. Add optional Anthropic Admin API support for Claude API usage reporting.
3. Add GitHub Project V2 GraphQL support to replace the current label-based planning board.
