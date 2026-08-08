const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const LOCAL_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const CREDENTIAL_DIR = process.platform === 'win32' && HOME ? path.join(HOME, 'AppData', 'Roaming', 'Northstar') : '';
const CREDENTIAL_FILE = CREDENTIAL_DIR ? path.join(CREDENTIAL_DIR, 'github-token.dpapi') : '';
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
    "$bytes=[Text.Encoding]::UTF8.GetBytes($env:NORTHSTAR_TOKEN); $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($protected)",
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
    "$protected=[Convert]::FromBase64String($env:NORTHSTAR_PROTECTED_TOKEN); $bytes=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($bytes)",
    { NORTHSTAR_PROTECTED_TOKEN: encoded }
  );
}

function deleteGithubToken() {
  if (CREDENTIAL_FILE && fs.existsSync(CREDENTIAL_FILE)) fs.unlinkSync(CREDENTIAL_FILE);
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

function normalizeLimitSnapshot(record) {
  const limits = record.payload?.rate_limits || record.rate_limits || record.rateLimits;
  if (!limits) return null;
  const primaryReset = limits.primary?.resets_at ? new Date(limits.primary.resets_at * 1000).toISOString() : null;
  const secondaryReset = limits.secondary?.resets_at ? new Date(limits.secondary.resets_at * 1000).toISOString() : null;
  return {
    planType: limits.plan_type || null,
    limitId: limits.limit_id || null,
    primary: limits.primary ? {
      usedPercent: limits.primary.used_percent ?? null,
      windowMinutes: limits.primary.window_minutes ?? null,
      resetsAt: primaryReset
    } : null,
    secondary: limits.secondary ? {
      usedPercent: limits.secondary.used_percent ?? null,
      windowMinutes: limits.secondary.window_minutes ?? null,
      resetsAt: secondaryReset
    } : null,
    credits: limits.credits ? {
      hasCredits: limits.credits.has_credits ?? null,
      unlimited: limits.credits.unlimited ?? null,
      balance: limits.credits.balance ?? null
    } : null,
    rateLimitReached: limits.rate_limit_reached ?? null,
    rateLimitReachedType: limits.rate_limit_reached_type ?? null
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
  let limits = null;
  let limitsAt = null;
  let todayTokens = 0;
  let monthTokens = 0;

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
      const total =
        numberFrom(record, ['payload.info.last_token_usage.total_tokens', 'total_tokens', 'totalTokens', 'usage.total_tokens', 'message.usage.total_tokens']) ||
        numberFrom(record, ['input_tokens', 'inputTokens', 'usage.input_tokens', 'message.usage.input_tokens', 'payload.info.last_token_usage.input_tokens']) +
        numberFrom(record, ['output_tokens', 'outputTokens', 'usage.output_tokens', 'message.usage.output_tokens', 'payload.info.last_token_usage.output_tokens']) +
        numberFrom(record, ['cache_creation_input_tokens', 'cache_read_input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'usage.cache_creation_input_tokens', 'usage.cache_read_input_tokens', 'payload.info.last_token_usage.cached_input_tokens', 'payload.info.last_token_usage.cache_write_input_tokens']);
      if (!total) continue;

      let fileDate = new Date();
      try { fileDate = fs.statSync(file).mtime; } catch {}
      const date = recordDate(record) || fileDate;
      const dayKey = dateKey(date);
      byDay.set(dayKey, (byDay.get(dayKey) || 0) + total);
      if (dayKey === todayKey) todayTokens += total;
      if (dayKey.startsWith(monthKey)) monthTokens += total;

      const model = recordModel || modelBySession.get(currentSession) || currentModel;
      if (model) models.set(model, (models.get(model) || 0) + total);
      sessions.add(currentSession);
    }
  }

  const daily = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(now);
    date.setDate(now.getDate() - (13 - index));
    return Math.round((byDay.get(dateKey(date)) || 0) / 1000);
  });
  const modelTotal = Array.from(models.values()).reduce((sum, value) => sum + value, 0);
  const colors = ['teal', 'blue', 'amber'];
  return {
    todayTokens,
    monthTokens,
    budgetTokens,
    sessions: sessions.size,
    source: files.length ? sourceName : 'missing',
    reset: 'local',
    daily,
    models: Array.from(models.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, value], index) => ({
      name,
      value: modelTotal ? Math.round(value / modelTotal * 100) : 0,
      tokens: value,
      color: colors[index % colors.length]
    })),
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
  const models = mergeModels([codex.models, claude.models]);
  return { codex, claude, daily, models, fetchedAt: new Date().toISOString() };
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
    if (req.method === 'GET' && req.url === '/api/usage') {
      sendJson(res, 200, getLocalUsage());
      return;
    }
    if (req.method === 'POST' && req.url === '/api/shutdown') {
      assertLocalOrigin(req);
      sendJson(res, 200, { ok: true, message: 'Northstar is shutting down.' });
      setTimeout(() => server.close(() => process.exit(0)), 100);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Unknown error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Northstar dashboard running at http://127.0.0.1:${PORT}`);
});
