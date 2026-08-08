const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-server-'));
const port = 46000 + Math.floor(Math.random() * 1000);
let server;

function request(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: {
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers
    } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        const isJson = String(response.headers['content-type'] || '').includes('application/json');
        resolve({ status: response.statusCode, headers: response.headers, text, body: isJson && text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await request('GET', '/api/health');
      if (response.status === 200) return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw lastError || new Error('Northstar server did not start');
}

test.before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(port), NORTHSTAR_PLANNER_ENABLED: 'true',
      NORTHSTAR_PLANNER_DIR: path.join(directory, 'planner'),
      NORTHSTAR_OBSERVABILITY_PATH: path.join(directory, 'observability.json'),
      CODEX_USAGE_PATH: path.join(directory, 'missing-codex'),
      CLAUDE_USAGE_PATH: path.join(directory, 'missing-claude'),
      NORTHSTAR_REPO_ROOTS: path.join(directory, 'empty')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForServer();
});

test.after(async () => {
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test('HTTP API serves the dashboard and protects state-changing endpoints', async () => {
  const health = await request('GET', '/api/health');
  assert.deepEqual(health.body.ok, true);
  assert.equal(health.headers['x-frame-options'], 'DENY');
  assert.match(health.headers['content-security-policy'], /default-src 'self'/);

  const index = await request('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.text, /Northstar/);
  assert.equal((await request('GET', '/server.js')).status, 404, 'server source must not be exposed as a static asset');
  assert.equal((await request('GET', '/app/../../server.js')).status, 404, 'path traversal must not expose server source');

  const denied = await request('POST', '/api/observability/events', { message: 'blocked' }, { Origin: 'https://evil.example' });
  assert.equal(denied.status, 403);

  const localOrigin = `http://127.0.0.1:${port}`;
  const created = await request('POST', '/api/observability/events', {
    id: 'api-event', tab: 'security', level: 'warning', details: { authorization: 'secret' }
  }, { Origin: localOrigin });
  assert.equal(created.status, 201);
  assert.equal(created.body.event.details.authorization, '[redacted]');

  const acknowledged = await request('PATCH', '/api/observability/events', { id: 'api-event', status: 'acknowledged' }, { Origin: localOrigin });
  assert.equal(acknowledged.body.event.status, 'acknowledged');
});

test('planner API is enabled but requires explicit confirmation for LLM changes', async () => {
  const status = await request('GET', '/api/planner/status');
  assert.equal(status.body.enabled, true);
  const localOrigin = `http://127.0.0.1:${port}`;
  const operation = { type: 'create_task', title: 'Safe CI task', source: 'llm' };
  assert.equal((await request('POST', '/api/planner/operations', { operations: [operation] }, { Origin: localOrigin })).status, 400);
  const saved = await request('POST', '/api/planner/operations', { operations: [operation], confirmed: true }, { Origin: localOrigin });
  assert.equal(saved.status, 200);
  const planner = await request('GET', '/api/planner');
  assert.equal(planner.body.tasks.length, 1);
});
