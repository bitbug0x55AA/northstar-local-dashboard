const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-server-'));
const codexUsagePath = path.join(directory, 'codex');
const claudeUsagePath = path.join(directory, 'claude');
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
  const now = new Date().toISOString();
  fs.mkdirSync(codexUsagePath, { recursive: true });
  fs.mkdirSync(claudeUsagePath, { recursive: true });
  fs.writeFileSync(path.join(codexUsagePath, 'session.jsonl'), `${JSON.stringify({ timestamp: now, type: 'event_msg', title: 'Review auth middleware', payload: { session_id: 'codex-session', model: 'gpt-5-codex', info: { context_window: 128000, last_token_usage: { total_tokens: 180000, input_tokens: 180000, context_tokens: 12000 }, rate_limits: { credits: { has_credits: true, balance: 750 } } } } })}\n`);
  fs.writeFileSync(path.join(claudeUsagePath, 'session.jsonl'), `${JSON.stringify({ timestamp: now, type: 'assistant', sessionId: 'claude-session', message: { model: 'claude-test', usage: { input_tokens: 20, output_tokens: 30, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 } } })}\n`);
  fs.writeFileSync(path.join(claudeUsagePath, 'agent-test.meta.json'), JSON.stringify({ sessionId: 'metadata-only' }));
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(port), NORTHSTAR_PLANNER_ENABLED: 'true',
      NORTHSTAR_LLM_URL: '', NORTHSTAR_LLM_MODEL: '',
      NORTHSTAR_PLANNER_DIR: path.join(directory, 'planner'),
      NORTHSTAR_OBSERVABILITY_PATH: path.join(directory, 'observability.json'),
      NORTHSTAR_FINANCE_PATH: path.join(directory, 'finance.json'),
      CODEX_USAGE_PATH: codexUsagePath,
      CLAUDE_USAGE_PATH: claudeUsagePath,
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

test('usage API includes Claude cache tokens and returns local-day metadata', async () => {
  const usage = await request('GET', '/api/usage');
  assert.equal(usage.status, 200);
  assert.equal(usage.body.codex.monthTokens, 180000);
  assert.equal(usage.body.claude.monthTokens, 500, 'Claude cache read and creation tokens must be included');
  assert.equal(usage.body.claude.tokenBreakdown.cacheRead, 400);
  assert.equal(usage.body.claude.tokenBreakdown.cacheWrite, 50);
  assert.equal(usage.body.dailyByProvider.codex.length, 14);
  assert.equal(usage.body.dailyByProvider.claude.length, 14);
  assert.equal(usage.body.dailyDates.length, 14);
  assert.equal(typeof usage.body.timezone, 'string');
  assert.equal(usage.body.sessionWindows[0].title, 'Review auth middleware');
  assert.equal(usage.body.sessionWindows[0].shortId, 'codex-se');
  assert.equal(usage.body.sessionWindows[0].needsAttention, false, 'a large prompt with ample context space must not warn');
  assert.equal(usage.body.sessionMonitor.sessions.length, 2);
  const codexSession = usage.body.sessionMonitor.sessions.find(session => session.provider === 'codex');
  assert.equal(codexSession.model, 'gpt-5-codex');
  assert.equal(codexSession.latestContextTokens, 12000, 'billing usage must not be treated as context occupancy');
  assert.equal(codexSession.recommendation, null);
  assert.equal(usage.body.sessionMonitor.alerts.length, 0);
  assert.equal(usage.body.codex.ingestion.confidence.level, 'verified');
  assert.equal(usage.body.measurement.schemaVersion, 2);
  assert.equal(usage.body.finance.codex.currentBalance, 750);
  assert.equal(usage.body.finance.codex.month.creditIncreaseEvents, 0);
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
  assert.ok(planner.body.milestones.length >= 20, 'roadmap defaults must migrate into editable Planner data');

  const milestoneCreated = await request('POST', '/api/planner/operations', { operations: [{ type: 'create_milestone', domain: 'security', milestoneType: 'certification', title: 'Editable certification', year: '2029', period: 'Q1', status: 'in-progress', progress: 30 }] }, { Origin: localOrigin });
  assert.equal(milestoneCreated.status, 200);
  const milestoneId = milestoneCreated.body.results[0].item.id;
  const milestoneUpdated = await request('POST', '/api/planner/operations', { operations: [{ type: 'update_milestone', id: milestoneId, title: 'Updated certification', status: 'done', progress: 40 }] }, { Origin: localOrigin });
  assert.equal(milestoneUpdated.body.results[0].item.progress, 100, 'completed milestones must report full progress');
  const milestoneDeleted = await request('POST', '/api/planner/operations', { operations: [{ type: 'delete_milestone', id: milestoneId }] }, { Origin: localOrigin });
  assert.equal(milestoneDeleted.status, 200);

  const eventCreated = await request('POST', '/api/planner/operations', { operations: [{ type: 'create_event', title: 'Editable lab', startAt: '2026-08-10T09:00:00Z', endAt: '2026-08-10T10:00:00Z' }] }, { Origin: localOrigin });
  const eventId = eventCreated.body.results[0].item.id;
  const eventUpdated = await request('POST', '/api/planner/operations', { operations: [{ type: 'update_event', id: eventId, title: 'Updated lab', startAt: '2026-08-10T10:00:00Z', endAt: '2026-08-10T11:30:00Z' }] }, { Origin: localOrigin });
  assert.equal(eventUpdated.body.results[0].item.title, 'Updated lab');
  assert.equal((await request('POST', '/api/planner/operations', { operations: [{ type: 'delete_event', id: eventId }] }, { Origin: localOrigin })).status, 200);

  const sync = await request('POST', '/api/planner/github-sync', {
    language: 'zh',
    github: { repos: [{ name: 'demo', issues: [{ number: 7, title: 'Raw issue', labels: [], updatedAt: '2026-08-09T00:00:00Z' }], closedIssues: [] }] }
  }, { Origin: localOrigin });
  assert.equal(sync.status, 200);
  assert.equal(sync.body.results.polishFailures, 1);
  const repeatedSync = await request('POST', '/api/planner/github-sync', {
    language: 'zh',
    github: { repos: [{ name: 'demo', issues: [{ number: 7, title: 'Raw issue', labels: [], updatedAt: '2026-08-09T00:00:00Z' }], closedIssues: [] }] }
  }, { Origin: localOrigin });
  assert.equal(repeatedSync.status, 200);
  const llmEvents = await request('GET', '/api/observability?tab=llm');
  assert.equal(llmEvents.body.events.filter(event => event.eventType === 'github_polish_failure').length, 1, 'repeated failures are deduplicated for one hour');
});
