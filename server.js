const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { readPlanner, applyOperations, syncGithubToPlanner } = require('./server/planner-store');
const { GITHUB_POLISH_VERSION, interpretPlannerInput, reviewFitness, polishGithubIssues } = require('./server/planner-llm');
const { recordEvent, listEvents, acknowledgeEvent, summarize } = require('./server/observability-store');
const { analyzeMergeWorkspace, discoverWorkspaces } = require('./server/merge-orchestrator');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
let plannerGithubSyncInFlight = null;
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const LOCAL_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const CREDENTIAL_DIR = process.platform === 'win32' && HOME ? path.join(HOME, 'AppData', 'Roaming', 'Northstar') : '';
const CREDENTIAL_FILE = CREDENTIAL_DIR ? path.join(CREDENTIAL_DIR, 'github-token.dpapi') : '';
const PLANNER_ENABLED = process.env.NORTHSTAR_PLANNER_ENABLED === 'true';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) req.destroy(new Error('Request body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function githubRequest({ method = 'GET', route, token, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const request = https.request({
      hostname: 'api.github.com',
      path: route,
      method,
      headers: {
        'User-Agent': 'Northstar-Local-Dashboard',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { message: data }; }
        if (response.statusCode >= 400) {
          const error = new Error(parsed.message || `GitHub returned ${response.statusCode}`);
          error.statusCode = response.statusCode;
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function runPowerShell(script, environment = {}) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('Windows DPAPI credential storage is only available on Windows'));
      return;
    }
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, ...environment }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', () => reject(new Error('Unable to access Windows credential protection')));
    child.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error('Windows credential protection failed'));
    });
  });
}

async function protectGithubToken(token) {
  if (!CREDENTIAL_FILE) throw new Error('Windows DPAPI credential storage is unavailable');
  const encoded = await runPowerShell(
    "Add-Type -AssemblyName System.Security; $bytes=[Text.Encoding]::UTF8.GetBytes($env:NORTHSTAR_TOKEN); $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($protected)",
    { NORTHSTAR_TOKEN: token }
  );
  fs.mkdirSync(CREDENTIAL_DIR, { recursive: true });
  const tempFile = `${CREDENTIAL_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempFile, encoded, { encoding: 'ascii', mode: 0o600 });
    fs.renameSync(tempFile, CREDENTIAL_FILE);
  } finally {
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
  }
}

async function readGithubToken() {
  if (!CREDENTIAL_FILE || !fs.existsSync(CREDENTIAL_FILE)) return '';
  const encoded = fs.readFileSync(CREDENTIAL_FILE, 'ascii').trim();
  if (!encoded) return '';
  return runPowerShell(
    "Add-Type -AssemblyName System.Security; $protected=[Convert]::FromBase64String($env:NORTHSTAR_PROTECTED_TOKEN); $bytes=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($bytes)",
    { NORTHSTAR_PROTECTED_TOKEN: encoded }
  );
}

function deleteGithubToken() {
  if (CREDENTIAL_FILE && fs.existsSync(CREDENTIAL_FILE)) fs.unlinkSync(CREDENTIAL_FILE);
}

function stopManagedOllama() {
  if (process.platform !== 'win32' || process.env.NORTHSTAR_OLLAMA_MANAGED !== 'true') return Promise.resolve();
  const pid = Number(process.env.NORTHSTAR_OLLAMA_PID || 0);
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const escapedPid = String(pid);
    const script = `$p=Get-Process -Id ${escapedPid} -ErrorAction SilentlyContinue; if($p -and $p.ProcessName -eq 'ollama'){Stop-Process -Id ${escapedPid} -Force}`;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    child.on('error', resolve);
    child.on('close', resolve);
  });
}

function githubTextRequest({ route, token, redirects = 2 }) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'api.github.com',
      path: route,
      method: 'GET',
      headers: {
        'User-Agent': 'Northstar-Local-Dashboard',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects > 0) {
        const target = new URL(response.headers.location);
        const follow = https.request(target, followResponse => {
          let data = '';
          followResponse.on('data', chunk => { data += chunk; });
          followResponse.on('end', () => resolve(data));
        });
        follow.on('error', reject);
        follow.end();
        return;
      }
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode >= 400) {
          reject(new Error(`GitHub logs returned ${response.statusCode}`));
          return;
        }
        resolve(data);
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function extractLogHighlights(text) {
  const lines = String(text || '').split(/\r?\n/);
  const matches = lines.filter(line => /(::error|error:|failed|failure|exception|traceback|npm err!|exit code|process completed with exit code)/i.test(line));
  return (matches.length ? matches : lines.slice(-30)).slice(-40).map(line => line.slice(0, 500));
}

async function fetchRepo(config) {
  const encoded = `${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  const [repo, releases, openIssues, closedIssues, runs] = await Promise.all([
    githubRequest({ route: `/repos/${encoded}`, token: config.token }),
    githubRequest({ route: `/repos/${encoded}/releases?per_page=5`, token: config.token }),
    githubRequest({ route: `/repos/${encoded}/issues?state=open&per_page=30&sort=updated`, token: config.token }),
    githubRequest({ route: `/repos/${encoded}/issues?state=closed&per_page=20&sort=updated`, token: config.token }),
    githubRequest({ route: `/repos/${encoded}/actions/runs?per_page=1`, token: config.token }).catch(error => ({ workflow_runs: [], error: error.message }))
  ]);
  const mapIssue = item => ({
    number: item.number,
    title: item.title,
    state: item.state,
    labels: item.labels.map(label => label.name),
    body: item.body ? String(item.body).slice(0, 2000) : null,
    url: item.html_url,
    updatedAt: item.updated_at,
    closedAt: item.closed_at,
    assignee: item.assignee ? item.assignee.login : null
  });

  return {
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description || 'No description',
    url: repo.html_url,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    language: repo.language || 'Unknown',
    updatedAt: repo.updated_at,
    defaultBranch: repo.default_branch,
    openIssues: repo.open_issues_count,
    latestCi: (runs.workflow_runs || [])[0] ? {
      id: runs.workflow_runs[0].id,
      name: runs.workflow_runs[0].name,
      event: runs.workflow_runs[0].event,
      status: runs.workflow_runs[0].status,
      conclusion: runs.workflow_runs[0].conclusion,
      branch: runs.workflow_runs[0].head_branch,
      sha: runs.workflow_runs[0].head_sha,
      url: runs.workflow_runs[0].html_url,
      createdAt: runs.workflow_runs[0].created_at,
      updatedAt: runs.workflow_runs[0].updated_at
    } : null,
    issues: openIssues.filter(item => !item.pull_request).map(mapIssue),
    closedIssues: closedIssues.filter(item => !item.pull_request).map(mapIssue),
    releases: releases.map(item => ({
      tag: item.tag_name,
      name: item.name || item.tag_name,
      url: item.html_url,
      publishedAt: item.published_at,
      prerelease: item.prerelease
    }))
  };
}

async function getGithub(body) {
  const token = String(body.token || '').trim() || await readGithubToken();
  const owner = String(body.owner || '').trim();
  const repos = Array.isArray(body.repos) ? body.repos : [];
  if (!owner || !repos.length) throw new Error('Configure a GitHub owner and at least one repository');
  const result = [];
  const errors = [];
  for (const repo of repos.slice(0, 12)) {
    try {
      result.push(await fetchRepo({ owner, repo: String(repo).trim(), token }));
    } catch (error) {
      errors.push({ repo, message: error.message });
    }
  }
  return { owner, repos: result, errors, fetchedAt: new Date().toISOString() };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  setSecurityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function assertLocalOrigin(req) {
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGINS.has(origin)) {
    const error = new Error('Requests must originate from the local dashboard');
    error.statusCode = 403;
    throw error;
  }
}

async function getGithubCi(body) {
  const token = String(body.token || '').trim() || await readGithubToken();
  const owner = String(body.owner || '').trim();
  const repo = String(body.repo || '').trim();
  const runId = String(body.runId || '').trim();
  if (!owner || !repo || !runId) throw new Error('owner, repo, and runId are required');
  const encoded = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const jobsData = await githubRequest({ route: `/repos/${encoded}/actions/runs/${encodeURIComponent(runId)}/jobs?per_page=100`, token });
  const jobs = (jobsData.jobs || []).map(job => ({
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    url: job.html_url,
    failedSteps: (job.steps || []).filter(step => ['failure', 'cancelled', 'timed_out'].includes(step.conclusion)).map(step => ({
      name: step.name,
      number: step.number,
      status: step.status,
      conclusion: step.conclusion,
      startedAt: step.started_at,
      completedAt: step.completed_at
    }))
  }));
  const failedJobs = jobs.filter(job => ['failure', 'cancelled', 'timed_out'].includes(job.conclusion));
  for (const job of failedJobs.slice(0, 3)) {
    try {
      const logText = await githubTextRequest({ route: `/repos/${encoded}/actions/jobs/${job.id}/logs`, token });
      job.logHighlights = extractLogHighlights(logText);
    } catch (error) {
      job.logHighlights = [`Unable to read job logs: ${error.message}`];
    }
  }
  return { owner, repo, runId, jobs, failedJobs, fetchedAt: new Date().toISOString() };
}

function listJsonFiles(targetPath, limit = 600) {
  if (!targetPath || !fs.existsSync(targetPath)) return [];
  let stat;
  try { stat = fs.statSync(targetPath); } catch { return []; }
  if (stat.isFile()) return [targetPath];
  const files = [];
  const stack = [targetPath];
  while (stack.length && files.length < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile() && /\.(jsonl?|ndjson)$/i.test(entry.name)) files.push(fullPath);
      if (files.length >= limit) break;
    }
  }
  return files;
}

function readJsonRecords(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  if (/\.jsonl$|\.ndjson$/i.test(filePath)) {
    return text.split(/\r?\n/).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function numberFrom(record, names) {
  for (const name of names) {
    const value = name.split('.').reduce((current, key) => current && current[key], record);
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

const TOKEN_FIELDS = {
  total: ['payload.info.last_token_usage.total_tokens', 'total_tokens', 'totalTokens', 'usage.total_tokens', 'message.usage.total_tokens'],
  input: ['input_tokens', 'inputTokens', 'usage.input_tokens', 'message.usage.input_tokens', 'payload.info.last_token_usage.input_tokens'],
  output: ['output_tokens', 'outputTokens', 'usage.output_tokens', 'message.usage.output_tokens', 'payload.info.last_token_usage.output_tokens'],
  cacheRead: ['cache_read_input_tokens', 'cached_input_tokens', 'usage.cache_read_input_tokens', 'usage.cached_input_tokens', 'message.usage.cache_read_input_tokens', 'message.usage.cached_input_tokens', 'payload.info.last_token_usage.cached_input_tokens'],
  cacheWrite: ['cache_creation_input_tokens', 'cache_write_input_tokens', 'usage.cache_creation_input_tokens', 'usage.cache_write_input_tokens', 'message.usage.cache_creation_input_tokens', 'message.usage.cache_write_input_tokens', 'payload.info.last_token_usage.cache_write_input_tokens']
};

const SESSION_CONTEXT_FIELDS = ['context_tokens', 'contextTokens', 'usage.context_tokens', 'usage.contextTokens', 'message.usage.context_tokens', 'message.usage.contextTokens', 'payload.info.last_token_usage.context_tokens', 'payload.info.context_tokens'];
const CONTEXT_WINDOW_FIELDS = ['context_window', 'contextWindow', 'context_window_tokens', 'contextWindowTokens', 'model_context_window', 'modelContextWindow', 'usage.context_window', 'usage.contextWindow', 'payload.info.context_window', 'payload.info.contextWindow'];

function cleanSessionLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.replace(/\s+/g, ' ').trim();
  return label ? label.slice(0, 96) : null;
}

function sessionTitleFrom(record) {
  const candidates = [record.session_name, record.sessionName, record.title, record.conversation_title, record.conversationTitle, record.payload?.session_name, record.payload?.sessionName, record.payload?.title, record.payload?.conversation_title, record.payload?.conversationTitle, record.payload?.input?.text, record.message?.title];
  return candidates.map(cleanSessionLabel).find(Boolean) || null;
}

function sessionContextTokens(record, usage) {
  const reported = numberFrom(record, SESSION_CONTEXT_FIELDS);
  return reported || ((usage.breakdown.cacheRead || 0) + (usage.breakdown.input || 0));
}
const SESSION_ADVISORY = {
  compactAt: 100000,
  startFreshAt: 160000,
  pauseAfterMinutes: 3,
  activeForMinutes: 15
};

function tokenUsageFrom(record) {
  const breakdown = {
    input: numberFrom(record, TOKEN_FIELDS.input),
    output: numberFrom(record, TOKEN_FIELDS.output),
    cacheRead: numberFrom(record, TOKEN_FIELDS.cacheRead),
    cacheWrite: numberFrom(record, TOKEN_FIELDS.cacheWrite)
  };
  const reportedTotal = numberFrom(record, TOKEN_FIELDS.total);
  return { total: reportedTotal || Object.values(breakdown).reduce((sum, value) => sum + value, 0), breakdown };
}

function sessionLabel(session, file) {
  if (!session || session === file) return 'local-log';
  return String(session).replace(/[^a-zA-Z0-9_-]/g, '').slice(-18) || 'local-log';
}

function sessionRecommendation(session, now) {
  const ageMinutes = Math.max(0, Math.round((now - new Date(session.lastActiveAt)) / 60000));
  const active = ageMinutes <= SESSION_ADVISORY.activeForMinutes;
  if (!active) return null;
  if (session.latestContextTokens >= SESSION_ADVISORY.startFreshAt) {
    return { level: 'high', action: 'start_fresh', message: 'The latest request is very large. Start a fresh session before the next substantial task.' };
  }
  if (session.latestContextTokens >= SESSION_ADVISORY.compactAt && ageMinutes >= SESSION_ADVISORY.pauseAfterMinutes) {
    return { level: 'medium', action: 'compact', message: 'This session has reached a natural pause. Compress its context before continuing.' };
  }
  if (session.latestContextTokens >= SESSION_ADVISORY.compactAt) {
    return { level: 'medium', action: 'prepare_compaction', message: 'The latest request is large. Finish the current step, then compress the context.' };
  }
  return null;
}

function recordDate(record) {
  const value = record.timestamp || record.created_at || record.createdAt || record.time || record.date;
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return null;
}

function normalizeReset(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) {
    const numeric = Number(value);
    const date = new Date(numeric < 100000000000 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeLimitWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const usedPercent = firstValue(window, ['used_percent', 'usedPercent', 'usage_percent', 'usagePercent', 'percent_used', 'percentUsed']);
  const windowMinutes = firstValue(window, ['window_minutes', 'windowMinutes', 'window_mins', 'windowMins']);
  return {
    usedPercent: usedPercent === null ? null : Number(usedPercent),
    windowMinutes: windowMinutes === null ? null : Number(windowMinutes),
    resetsAt: normalizeReset(firstValue(window, ['resets_at', 'resetsAt', 'reset_at', 'resetAt']))
  };
}

function normalizeLimitSnapshot(record) {
  const limits = record.payload?.info?.rate_limits || record.payload?.rate_limits || record.rate_limits || record.rateLimits || record.limits;
  if (!limits) return null;
  const primary = normalizeLimitWindow(limits.primary || limits.primary_window || limits.primaryWindow);
  const secondary = normalizeLimitWindow(limits.secondary || limits.secondary_window || limits.secondaryWindow);
  const credits = limits.credits || limits.credit;
  return {
    planType: firstValue(limits, ['plan_type', 'planType']) || null,
    limitId: firstValue(limits, ['limit_id', 'limitId']) || null,
    primary,
    secondary,
    credits: credits ? {
      hasCredits: firstValue(credits, ['has_credits', 'hasCredits']),
      unlimited: firstValue(credits, ['unlimited']),
      balance: firstValue(credits, ['balance'])
    } : null,
    rateLimitReached: firstValue(limits, ['rate_limit_reached', 'rateLimitReached']),
    rateLimitReachedType: firstValue(limits, ['rate_limit_reached_type', 'rateLimitReachedType'])
  };
}

function usageFromPath(sourceName, targetPath, budgetTokens) {
  const files = listJsonFiles(targetPath);
  const now = new Date();
  const todayKey = dateKey(now);
  const monthKey = todayKey.slice(0, 7);
  const byDay = new Map();
  const models = new Map();
  const sessions = new Set();
  const modelBySession = new Map();
  const sessionDetails = new Map();
  let limits = null;
  let limitsAt = null;
  let todayTokens = 0;
  let monthTokens = 0;
  const breakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (const file of files) {
    let currentModel = null;
    let currentSession = file;
    for (const record of readJsonRecords(file)) {
      const recordModel = record.model || record.modelName || record.message?.model || record.payload?.model || record.payload?.thread_settings?.model || record.payload?.collaboration_mode?.settings?.model;
      const session = record.session_id || record.sessionId || record.conversation_id || record.conversationId || record.payload?.session_id || file;
      currentSession = session || currentSession;
      if (recordModel) {
        currentModel = recordModel;
        modelBySession.set(currentSession, recordModel);
      }
      const snapshot = normalizeLimitSnapshot(record);
      if (snapshot) {
        const snapshotAt = recordDate(record) || limitsAt || new Date();
        if (!limitsAt || snapshotAt >= limitsAt) {
          limits = snapshot;
          limitsAt = snapshotAt;
        }
      }
      const usage = tokenUsageFrom(record);
      const total = usage.total;
      const observedAt = recordDate(record) || new Date();
      const contextWindow = numberFrom(record, CONTEXT_WINDOW_FIELDS);
      const contextTokens = sessionContextTokens(record, usage);
      const sessionDetail = sessionDetails.get(currentSession) || { id: currentSession, provider: sourceName, model: null, title: null, contextWindow: 0, contextTokens: 0, updatedAt: null, tokens: 0, latestContextTokens: 0, lastActiveAt: observedAt.toISOString() };
      const title = sessionTitleFrom(record);
      if (title) sessionDetail.title = title;
      if (recordModel) sessionDetail.model = recordModel;
      if (contextWindow > sessionDetail.contextWindow) sessionDetail.contextWindow = contextWindow;
      if (contextTokens > sessionDetail.contextTokens) sessionDetail.contextTokens = contextTokens;
      if (!sessionDetail.updatedAt || observedAt >= new Date(sessionDetail.updatedAt)) sessionDetail.updatedAt = observedAt.toISOString();
      sessionDetails.set(currentSession, sessionDetail);
      if (!total) continue;

      let fileDate = new Date();
      try { fileDate = fs.statSync(file).mtime; } catch {}
      const date = recordDate(record) || fileDate;
      const dayKey = dateKey(date);
      byDay.set(dayKey, (byDay.get(dayKey) || 0) + total);
      if (dayKey === todayKey) todayTokens += total;
      if (dayKey.startsWith(monthKey)) {
        monthTokens += total;
        for (const [key, value] of Object.entries(usage.breakdown)) breakdown[key] += value;
      }

      const model = recordModel || modelBySession.get(currentSession) || currentModel;
      if (model) models.set(model, (models.get(model) || 0) + total);
      sessions.add(currentSession);
      const detail = sessionDetails.get(currentSession);
      detail.tokens += total;
      if (model) detail.model = String(model).slice(0, 80);
      if (new Date(detail.lastActiveAt) <= date) {
        detail.latestContextTokens = Math.max(0, usage.breakdown.input + usage.breakdown.cacheRead + usage.breakdown.cacheWrite, total - usage.breakdown.output);
        detail.lastActiveAt = date.toISOString();
      }
      sessionDetails.set(currentSession, detail);
    }
  }

  const daily = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(now);
    date.setDate(now.getDate() - (13 - index));
    return Math.round((byDay.get(dateKey(date)) || 0) / 1000);
  });
  const modelTotal = Array.from(models.values()).reduce((sum, value) => sum + value, 0);
  const colors = ['teal', 'blue', 'amber'];
  const sessionWindows = Array.from(sessionDetails.values()).map(session => {
    const contextWindow = session.contextWindow || 0;
    const contextTokens = Math.min(session.contextTokens || 0, contextWindow || Number.MAX_SAFE_INTEGER);
    const remainingTokens = contextWindow ? Math.max(0, contextWindow - contextTokens) : null;
    const usedPercent = contextWindow ? Math.round(contextTokens / contextWindow * 100) : null;
    const id = String(session.id);
    return { id, shortId: id.slice(0, 8), title: session.title || `Session ${id.slice(0, 8)}`, model: session.model || modelBySession.get(session.id) || null, contextWindow: contextWindow || null, contextTokens: contextWindow ? contextTokens : null, remainingTokens, usedPercent, updatedAt: session.updatedAt, needsAttention: Boolean(contextWindow && usedPercent >= 90 && remainingTokens <= 16000) };
  }).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)).slice(0, 20);
  return {
    todayTokens,
    monthTokens,
    budgetTokens,
    sessions: sessions.size,
    source: files.length ? sourceName : 'missing',
    reset: 'local',
    tokenBreakdown: breakdown,
    daily,
    sessionDetails: Array.from(sessionDetails.values()),
    models: Array.from(models.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, value], index) => ({
      name,
      value: modelTotal ? Math.round(value / modelTotal * 100) : 0,
      tokens: value,
      color: colors[index % colors.length]
    })),
    sessionWindows,
    limits: limits ? { ...limits, updatedAt: limitsAt ? limitsAt.toISOString() : null } : null
  };
}

function mergeModels(groups) {
  const totals = new Map();
  for (const group of groups) {
    for (const model of group || []) {
      const tokens = Number(model.tokens || 0);
      if (!tokens) continue;
      totals.set(model.name, (totals.get(model.name) || 0) + tokens);
    }
  }
  const grandTotal = Array.from(totals.values()).reduce((sum, value) => sum + value, 0);
  const colors = ['teal', 'blue', 'amber'];
  return Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, tokens], index) => ({
    name,
    value: grandTotal ? Math.round(tokens / grandTotal * 100) : 0,
    tokens,
    color: colors[index % colors.length]
  }));
}

function getLocalUsage() {
  const codexPath = process.env.CODEX_USAGE_PATH || (HOME ? path.join(HOME, '.codex', 'sessions') : '');
  const claudePath = process.env.CLAUDE_USAGE_PATH || (HOME ? path.join(HOME, '.claude') : '');
  const codex = usageFromPath('local', codexPath, Number(process.env.CODEX_BUDGET_TOKENS || 4400000));
  const claude = usageFromPath('local', claudePath, Number(process.env.CLAUDE_BUDGET_TOKENS || 3600000));
  const daily = codex.daily.map((value, index) => value + (claude.daily[index] || 0));
  const dailyDates = codex.daily.map((_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (13 - index));
    return dateKey(date);
  });
  const models = mergeModels([codex.models, claude.models]);
  const now = new Date();
  const sessionMonitor = [
    ...codex.sessionDetails.map(session => ({ ...session, provider: 'codex' })),
    ...claude.sessionDetails.map(session => ({ ...session, provider: 'claude' }))
  ].map(session => ({ ...session, recommendation: sessionRecommendation(session, now) }))
    .sort((left, right) => new Date(right.lastActiveAt) - new Date(left.lastActiveAt));
  for (const [provider, usage] of [['codex', codex], ['claude-code', claude]]) {
    const usedPercent = usage.limits?.primary?.usedPercent;
    if (Number.isFinite(Number(usedPercent))) {
      const reachedThresholds = [50, 80, 90].filter(threshold => usedPercent >= threshold);
      for (const threshold of reachedThresholds) {
        const level = threshold >= 90 ? 'critical' : 'warning';
        recordEvent({
          id: `usage-${provider}-${threshold}-${dateKey(new Date())}`,
          tab: 'usage',
          level,
          source: provider,
          eventType: 'quota_threshold',
          message: `${provider === 'codex' ? 'Codex' : 'Claude Code'} usage reached the ${threshold}% quota threshold (${Math.round(usedPercent)}% used).`,
          details: { usedPercent: Math.round(usedPercent), threshold, windowMinutes: usage.limits.primary.windowMinutes, resetsAt: usage.limits.primary.resetsAt },
          status: 'open',
          ruleId: `USAGE-QUOTA-${threshold}`
        });
      }
    }
  }
  for (const [provider, usage] of [['codex', codex], ['claude-code', claude]]) {
    for (const session of usage.sessionWindows.filter(item => item.needsAttention)) {
      recordEvent({
        id: `session-window-${provider}-${session.id}-${dateKey(new Date())}`,
        tab: 'usage', level: 'warning', source: provider, eventType: 'session_window_near_limit',
        message: `${provider === 'codex' ? 'Codex' : 'Claude Code'} session "${session.title}" is at ${session.usedPercent}% of its observed context window (${Math.round(session.remainingTokens / 1000)}K tokens left).`,
        details: { sessionId: session.shortId, sessionTitle: session.title, model: session.model, usedPercent: session.usedPercent, remainingTokens: session.remainingTokens, contextWindow: session.contextWindow },
        status: 'open', ruleId: 'SESSION-WINDOW-90-16K'
      });
    }
  }
  return {
    codex,
    claude,
    daily,
    dailyByProvider: { codex: codex.daily, claude: claude.daily },
    dailyDates,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    sessionMonitor: {
      thresholds: SESSION_ADVISORY,
      sessions: sessionMonitor.slice(0, 30),
      alerts: sessionMonitor.filter(session => session.recommendation).slice(0, 8)
    },
    models,
    sessionWindows: [...codex.sessionWindows.map(session => ({ ...session, provider: 'Codex' })), ...claude.sessionWindows.map(session => ({ ...session, provider: 'Claude Code' }))].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)),
    fetchedAt: new Date().toISOString()
  };
}

function serveStatic(req, res) {
  const requested = req.url === '/' ? '/app/index.html' : req.url;
  const safePath = path.normalize(requested.split('?')[0]).replace(/^\.\.(\/|\\)/, '');
  if (!safePath.startsWith('/app/') && !safePath.startsWith('\\app\\')) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const filePath = path.join(ROOT, safePath);
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  setSecurityHeaders(res);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
}

let shutdownStarted = false;
function shutdownNorthstar() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  server.close(async () => {
    await stopManagedOllama();
    process.exit(0);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/health') {
      sendJson(res, 200, { ok: true, name: 'Northstar', port: PORT });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/github-token') {
      assertLocalOrigin(req);
      const body = JSON.parse(await readBody(req) || '{}');
      const token = String(body.token || '').trim();
      if (!token || token.length > 500) throw new Error('A valid GitHub token is required');
      await protectGithubToken(token);
      sendJson(res, 200, { ok: true, stored: true });
      return;
    }
    if (req.method === 'DELETE' && req.url === '/api/github-token') {
      assertLocalOrigin(req);
      deleteGithubToken();
      sendJson(res, 200, { ok: true, stored: false });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/github') {
      assertLocalOrigin(req);
      const body = JSON.parse(await readBody(req) || '{}');
      sendJson(res, 200, await getGithub(body));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/github-ci') {
      assertLocalOrigin(req);
      const body = JSON.parse(await readBody(req) || '{}');
      sendJson(res, 200, await getGithubCi(body));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/merge-orchestrator/analyze') {
      assertLocalOrigin(req);
      const body = JSON.parse(await readBody(req) || '{}');
      sendJson(res, 200, await analyzeMergeWorkspace(body));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/merge-orchestrator/workspaces') {
      sendJson(res, 200, { workspaces: await discoverWorkspaces(), fetchedAt: new Date().toISOString() });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/usage') {
      sendJson(res, 200, getLocalUsage());
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/observability')) {
      const query = new URL(req.url, `http://127.0.0.1:${PORT}`).searchParams;
      const events = listEvents({ tab: query.get('tab') || 'all', level: query.get('level') || 'all', status: query.get('status') || 'all', q: query.get('q') || '' });
      sendJson(res, 200, { events, summary: summarize(events), fetchedAt: new Date().toISOString() });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/observability/events') {
      assertLocalOrigin(req);
      const body = JSON.parse(await readBody(req) || '{}');
      sendJson(res, 201, { event: recordEvent(body) });
      return;
    }
    if (req.method === 'PATCH' && req.url === '/api/observability/events') {
      assertLocalOrigin(req);
      const body = JSON.parse(await readBody(req) || '{}');
      sendJson(res, 200, { event: acknowledgeEvent(String(body.id || ''), String(body.status || '')) });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/planner/status') {
      sendJson(res, 200, {
        enabled: PLANNER_ENABLED,
        llmConfigured: Boolean(process.env.NORTHSTAR_LLM_URL && process.env.NORTHSTAR_LLM_MODEL)
      });
      return;
    }
    if (PLANNER_ENABLED && req.method === 'GET' && req.url === '/api/planner') {
      sendJson(res, 200, readPlanner());
      return;
    }
    if (PLANNER_ENABLED && req.method === 'POST' && req.url === '/api/planner/operations') {
      assertLocalOrigin(req);
      const body = JSON.parse(await readBody(req) || '{}');
      sendJson(res, 200, applyOperations(body.operations, { confirmed: body.confirmed === true }));
      return;
    }
    if (PLANNER_ENABLED && req.method === 'POST' && req.url === '/api/planner/github-sync') {
      assertLocalOrigin(req);
      const body = JSON.parse(await readBody(req) || '{}');
      if (plannerGithubSyncInFlight) {
        sendJson(res, 200, await plannerGithubSyncInFlight);
        return;
      }
      const syncTask = (async () => {
        const github = body.github || {};
        const current = readPlanner();
        const llmAvailable = Boolean(process.env.NORTHSTAR_LLM_URL && process.env.NORTHSTAR_LLM_MODEL);
        const known = new Map(current.tasks.filter(task => task.source === 'github' && task.sourceRef).map(task => [task.sourceRef, task]));
        const candidates = [];
        for (const repo of Array.isArray(github.repos) ? github.repos : []) {
          for (const issue of Array.isArray(repo.issues) ? repo.issues : []) {
            const sourceRef = `github:${String(repo.name || '').trim()}#${issue.number}`;
            const existing = known.get(sourceRef);
            const needsPolish = !existing?.sourcePolishVersion || (llmAvailable && (existing.sourcePolishVersion !== GITHUB_POLISH_VERSION || existing.sourceUpdatedAt !== issue.updatedAt));
            if (!existing || existing.sourceUpdatedAt !== issue.updatedAt || needsPolish) candidates.push({ ...issue, repo: repo.name });
          }
        }
        const polished = await polishGithubIssues(candidates, body.language);
        const polishedByRef = new Map(polished.items.map(item => [item.sourceRef, item]));
        const failedPolishRefs = new Set(polished.failedSourceRefs || []);
        for (const [index, failure] of (polished.failedBatches || []).entries()) {
          const timedOut = failure.code === 'LLM_TIMEOUT';
          recordEvent({
            id: `github-planner-polish-${Date.now()}-${index}`,
            tab: 'llm',
            level: timedOut ? 'error' : 'warning',
            source: 'ollama',
            eventType: timedOut ? 'github_polish_timeout' : 'github_polish_failure',
            message: timedOut
              ? 'GitHub Planner LLM batch timed out; the affected tasks used GitHub fallback text.'
              : 'GitHub Planner LLM batch failed; the affected tasks used GitHub fallback text.',
            details: {
              code: failure.code,
              error: failure.error,
              batchNumber: index + 1,
              batchCount: polished.batches,
              batchSize: failure.sourceRefs.length,
              sourceRefs: failure.sourceRefs,
              model: process.env.NORTHSTAR_LLM_MODEL || null,
              timeoutMs: process.env.NORTHSTAR_LLM_POLISH_TIMEOUT_MS || 90000
            },
            status: 'open',
            ruleId: timedOut ? 'LLM-GITHUB-POLISH-TIMEOUT' : 'LLM-GITHUB-POLISH-FAILURE'
          });
        }
        const enriched = {
          ...github,
          repos: (github.repos || []).map(repo => ({
            ...repo,
            issues: (repo.issues || []).map(issue => {
              const sourceRef = `github:${String(repo.name || '').trim()}#${issue.number}`;
              const item = polishedByRef.get(sourceRef);
              const existing = known.get(sourceRef);
              const batchFailed = failedPolishRefs.has(sourceRef);
              // Do not regress an already polished task to raw GitHub text when the
              // local model is temporarily unavailable.
              const keepExistingPolish = batchFailed && existing?.sourcePolishVersion && existing.sourcePolishVersion !== 'github-raw-v2';
              return item && !keepExistingPolish ? { ...issue, plannerTitle: item.title, plannerNotes: item.notes, plannerCategory: item.category, plannerTags: item.tags, plannerPolishVersion: batchFailed ? 'github-raw-v2' : GITHUB_POLISH_VERSION } : issue;
            })
          }))
        };
        const result = syncGithubToPlanner(enriched);
        result.results = { ...result.results, polished: polished.used, polishFallback: polished.fallback, polishBatches: polished.batches, polishFailures: polished.failedBatches?.length || 0, polishError: polished.error || null };
        return result;
      })();
      plannerGithubSyncInFlight = syncTask;
      try {
        sendJson(res, 200, await syncTask);
      } finally {
        if (plannerGithubSyncInFlight === syncTask) plannerGithubSyncInFlight = null;
      }
      return;
    }
    if (PLANNER_ENABLED && req.method === 'POST' && req.url === '/api/planner/interpret') {
      assertLocalOrigin(req);
      const body = JSON.parse(await readBody(req) || '{}');
      if (!String(body.input || '').trim()) throw new Error('Planner input is required');
      sendJson(res, 200, await interpretPlannerInput(body.input));
      return;
    }
    if (PLANNER_ENABLED && req.method === 'POST' && req.url === '/api/planner/fitness-review') {
      assertLocalOrigin(req);
      const planner = readPlanner();
      sendJson(res, 200, await reviewFitness(planner.fitness));
      return;
    }
    if (PLANNER_ENABLED && req.method === 'POST' && req.url === '/api/planner/llm-test') {
      assertLocalOrigin(req);
      const startedAt = Date.now();
      const result = await interpretPlannerInput('测试连接：请记录“完成本地 LLM 接入测试”，不要创建日程。');
      recordEvent({ tab: 'llm', level: 'info', source: 'ollama', eventType: 'inference', message: 'Local LLM connection test completed.', details: { model: process.env.NORTHSTAR_LLM_MODEL || null, latencyMs: Date.now() - startedAt }, status: 'resolved' });
      sendJson(res, 200, {
        ok: true,
        model: process.env.NORTHSTAR_LLM_MODEL || null,
        latencyMs: Date.now() - startedAt,
        result
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/shutdown') {
      assertLocalOrigin(req);
      sendJson(res, 200, { ok: true, message: 'Northstar is shutting down.' });
      setTimeout(shutdownNorthstar, 100);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Unknown error' });
  }
});

process.on('SIGINT', shutdownNorthstar);
process.on('SIGTERM', shutdownNorthstar);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Northstar dashboard running at http://127.0.0.1:${PORT}`);
});
