# Northstar Local Dashboard

Northstar is a local Windows 11 developer control room for tracking GitHub delivery work, personal planning, and local Codex / Claude Code usage in one place.

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
- GitHub → Planner bridge: Open Issues are automatically mirrored into Personal Planner after each GitHub sync. A configured local LLM turns raw issues into concise task summaries, categories, tags, and project-linked parent/child entries; without a model, the sync safely falls back to the original GitHub text.
- AI usage: local Codex / Claude Code usage, today and month totals, sessions, 14-day trend, model distribution, and visible subscription-limit snapshots.
- Personal Planner: a display-first overview of tasks, progress logs, focus, and upcoming events, plus a separate input tab for manual and natural-language updates.
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
- GitHub-to-Planner sync is one-way: it can create or complete Planner tasks, but never modifies GitHub and never deletes Planner data. It uses a stable `github:<repo>#<issue-number>` reference to avoid duplicate tasks and does not overwrite manual Planner tasks.
- If the optional local LLM is configured, only the selected GitHub issue metadata needed for language polishing is sent to that local endpoint. The model may rewrite task titles and notes, but cannot set task status, priority, IDs, or perform Planner operations. LLM failure falls back to raw GitHub text.
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

## Personal Planner

The Planner is intentionally isolated behind an environment flag. To run this branch with the Planner enabled:

```powershell
$env:NORTHSTAR_PLANNER_ENABLED = 'true'
.\start-windows.ps1
```

For the local Ollama setup, use the simpler feature-specific launcher. It enables Planner, starts the local Ollama API when needed, and supplies the default model settings:

```powershell
.\start-windows.ps1 -Planner
```

Planner data is stored separately under `%APPDATA%\Northstar\planner` by default. Set `NORTHSTAR_PLANNER_DIR` to use another local directory. The Planner API uses `/api/planner/*` and does not modify GitHub or AI usage data.

When GitHub sync succeeds, Northstar also calls `/api/planner/github-sync`. Open Issues become Planner tasks under a repository-level parent project; the local LLM adds a short category and tags, while `in-progress`, `in progress`, and `doing` labels map to an in-progress task, `urgent`, `critical`, and `blocker` labels map to high priority, and a matching closed Issue completes its Planner task. Existing manual tasks are not touched. The same bridge runs through the five-minute automatic sync.

Natural-language interpretation is optional. Configure an OpenAI-compatible local model endpoint and model name before starting:

```powershell
$env:NORTHSTAR_LLM_URL = 'http://127.0.0.1:11434/api/chat'
$env:NORTHSTAR_LLM_MODEL = 'qwen2.5:3b'
$env:NORTHSTAR_LLM_KEEP_ALIVE = '5m'
```

The model returns proposed Planner operations for the manual natural-language input. The UI previews the operations and requires confirmation before saving them. During GitHub sync, the model has a narrower polish-only role: it returns rewritten titles and notes, not Planner operations. Event scheduling and external calendar sync remain separate follow-up work.

When started with `.\start-windows.ps1 -Planner`, Northstar records whether it started Ollama itself. Closing the dashboard stops only that Ollama process; an Ollama instance that was already running before Northstar is left untouched. `NORTHSTAR_LLM_KEEP_ALIVE` controls how long the Ollama model remains loaded after an inference request; the default is `5m`. This affects model memory residency, not the Ollama service process itself.

## Planner LLM Safety Boundary

Planner LLM output is treated as untrusted input. The behavior contract is versioned in:

- `server/planner-policy.json`: allowed operations, limits, and confirmation rules.
- `server/planner-system-prompt.txt`: local-model instructions.
- `server/planner-validator.js`: server-side schema validation and field sanitization.
- `tests/run-planner-policy.js`: regression checks for unsafe and malformed proposals.
- `tests/run-planner-sync.js`: regression checks for GitHub task creation, deduplication, and closed-Issue completion.

LLM proposals are marked with `source: "llm"`, always require explicit confirmation, and cannot write through the Planner API without `confirmed: true`. The connection test only parses a fixed prompt and never saves data.

## Roadmap

1. Add a Windows scheduled task or background helper for persistent sync outside the browser tab.
2. Add optional Anthropic Admin API support for Claude API usage reporting.
3. Add GitHub Project V2 GraphQL support to replace the current label-based planning board.

## Merge Orchestrator

The GitHub Projects area includes a nested Merge Orchestrator workspace. The workspace discovers local repositories under the configured/common project roots, then lets the user select a repository, target branch, and source branches from discovered Git refs. A manual path remains as a fallback when discovery is unavailable. The backend performs read-only Git inspection of commit ancestry, changed-file overlap, working-tree state, and a `git merge-tree --trivial-merge` preflight. If the local LLM is configured, it explains a suggested order using only those deterministic results.

GitHub subpages are navigated from the expandable sidebar; the duplicate in-page GitHub tab strip is not used.

The workspace never runs merge, rebase, commit, push, reset, or delete operations. Repository paths are used only as the working directory for fixed Git read commands, and the analysis result is not persisted to the repository.
