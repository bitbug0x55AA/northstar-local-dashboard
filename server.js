const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const HOME = process.env.USERPROFILE || process.env.HOME || '';
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

async function fetchRepo(config) {
  const encoded = `${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  const [repo, releases, openIssues, closedIssues] = await Promise.all([
    githubRequest({ route: `/repos/${encoded}`, token: config.token }),
    githubRequest({ route: `/repos/${encoded}/releases?per_page=5`, token: config.token }),
    githubRequest({ route: `/repos/${encoded}/issues?state=open&per_page=30&sort=updated`, token: config.token }),
    githubRequest({ route: `/repos/${encoded}/issues?state=closed&per_page=20&sort=updated`, token: config.token })
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
    description: repo.description || '暂无描述',
    url: repo.html_url,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    language: repo.language || 'Unknown',
    updatedAt: repo.updated_at,
    defaultBranch: repo.default_branch,
    openIssues: repo.open_issues_count,
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
  const token = String(body.token || '').trim();
  const owner = String(body.owner || '').trim();
  const repos = Array.isArray(body.repos) ? body.repos : [];
  if (!owner || !repos.length) throw new Error('请至少配置 GitHub owner 和一个仓库');
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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
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

function usageFromPath(sourceName, targetPath, budgetTokens) {
  const files = listJsonFiles(targetPath);
  const now = new Date();
  const todayKey = dateKey(now);
  const monthKey = todayKey.slice(0, 7);
  const byDay = new Map();
  const models = new Map();
  const sessions = new Set();
  let todayTokens = 0;
  let monthTokens = 0;

  for (const file of files) {
    for (const record of readJsonRecords(file)) {
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

      const model = record.model || record.modelName || record.message?.model || record.payload?.model || record.payload?.thread_settings?.model;
      if (model) models.set(model, (models.get(model) || 0) + total);
      const session = record.session_id || record.sessionId || record.conversation_id || record.conversationId || file;
      sessions.add(session);
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
      color: colors[index % colors.length]
    }))
  };
}

function getLocalUsage() {
  const codexPath = process.env.CODEX_USAGE_PATH || (HOME ? path.join(HOME, '.codex', 'sessions') : '');
  const claudePath = process.env.CLAUDE_USAGE_PATH || (HOME ? path.join(HOME, '.claude') : '');
  const codex = usageFromPath('local', codexPath, Number(process.env.CODEX_BUDGET_TOKENS || 4400000));
  const claude = usageFromPath('local', claudePath, Number(process.env.CLAUDE_BUDGET_TOKENS || 3600000));
  const daily = codex.daily.map((value, index) => value + (claude.daily[index] || 0));
  const models = [...codex.models, ...claude.models].slice(0, 5);
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
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/health') {
      sendJson(res, 200, { ok: true, name: 'Northstar', port: PORT });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/github') {
      const body = JSON.parse(await readBody(req) || '{}');
      sendJson(res, 200, await getGithub(body));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/usage') {
      sendJson(res, 200, getLocalUsage());
      return;
    }
    if (req.method === 'POST' && req.url === '/api/shutdown') {
      sendJson(res, 200, { ok: true, message: 'Northstar is shutting down.' });
      setTimeout(() => server.close(() => process.exit(0)), 100);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Unknown error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Northstar dashboard running at http://127.0.0.1:${PORT}`);
});
