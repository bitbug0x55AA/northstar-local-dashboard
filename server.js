const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
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
  const [repo, releases, issues] = await Promise.all([
    githubRequest({ route: `/repos/${encoded}`, token: config.token }),
    githubRequest({ route: `/repos/${encoded}/releases?per_page=5`, token: config.token }),
    githubRequest({ route: `/repos/${encoded}/issues?state=open&per_page=20&sort=updated`, token: config.token })
  ]);

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
    issues: issues.filter(item => !item.pull_request).map(item => ({
      number: item.number,
      title: item.title,
      state: item.state,
      labels: item.labels.map(label => label.name),
      url: item.html_url,
      updatedAt: item.updated_at,
      assignee: item.assignee ? item.assignee.login : null
    })),
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

function serveStatic(req, res) {
  const requested = req.url === '/' ? '/app/index.html' : req.url;
  const safePath = path.normalize(requested.split('?')[0]).replace(/^\.\.(\/|\\)/, '');
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
    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Unknown error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Northstar dashboard running at http://127.0.0.1:${PORT}`);
});
