const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const DATA_FILE = process.env.NORTHSTAR_OBSERVABILITY_PATH || (HOME ? path.join(HOME, '.northstar', 'observability.json') : path.join(process.cwd(), '.northstar-observability.json'));
const MAX_EVENTS = 1000;

const DEMO_EVENTS = [
  { id: 'demo-usage-1', timestamp: new Date(Date.now() - 1000 * 60 * 18).toISOString(), tab: 'usage', level: 'warning', source: 'codex', eventType: 'quota_threshold', message: 'Codex usage is approaching the configured quota.', details: { usedPercent: 82, threshold: 80 }, status: 'open', ruleId: 'USAGE-QUOTA-80' },
  { id: 'demo-llm-1', timestamp: new Date(Date.now() - 1000 * 60 * 42).toISOString(), tab: 'llm', level: 'info', source: 'ollama', eventType: 'inference', message: 'Local LLM inference completed within the safety boundary.', details: { latencyMs: 842, model: 'local model' }, status: 'resolved', ruleId: null },
  { id: 'demo-debug-1', timestamp: new Date(Date.now() - 1000 * 60 * 76).toISOString(), tab: 'debug', level: 'info', source: 'northstar', eventType: 'startup', message: 'Observability store initialized.', details: {}, status: 'resolved', ruleId: null }
];

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { events: Array.isArray(parsed.events) ? parsed.events : [], updatedAt: parsed.updatedAt || null };
  } catch {
    return { events: [], updatedAt: null };
  }
}

function writeStore(store) {
  const directory = path.dirname(DATA_FILE);
  fs.mkdirSync(directory, { recursive: true });
  const temp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ events: store.events.slice(0, MAX_EVENTS), updatedAt: new Date().toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}

function cleanDetails(details) {
  if (!details || typeof details !== 'object') return {};
  const output = {};
  for (const [key, value] of Object.entries(details).slice(0, 20)) {
    if (/token|secret|password|authorization|private.?key|prompt|content/i.test(key)) output[key] = '[redacted]';
    else output[key] = typeof value === 'string' ? value.slice(0, 500) : value;
  }
  return output;
}

function normalizeEvent(input = {}) {
  const allowedTabs = new Set(['security', 'debug', 'application', 'llm', 'usage', 'alerts']);
  const allowedLevels = new Set(['debug', 'info', 'warning', 'error', 'critical']);
  const allowedStatuses = new Set(['open', 'acknowledged', 'resolved', 'ignored']);
  return {
    id: String(input.id || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`).slice(0, 80),
    timestamp: input.timestamp && !Number.isNaN(new Date(input.timestamp).getTime()) ? new Date(input.timestamp).toISOString() : new Date().toISOString(),
    tab: allowedTabs.has(input.tab) ? input.tab : 'application',
    level: allowedLevels.has(input.level) ? input.level : 'info',
    source: String(input.source || 'northstar').slice(0, 80),
    eventType: String(input.eventType || 'log').slice(0, 100),
    message: String(input.message || 'Observability event').replace(/[\r\n]+/g, ' ').slice(0, 500),
    details: cleanDetails(input.details),
    status: allowedStatuses.has(input.status) ? input.status : 'open',
    ruleId: input.ruleId ? String(input.ruleId).slice(0, 80) : null
  };
}

function recordEvent(input) {
  const store = readStore();
  const event = normalizeEvent(input);
  const existing = store.events.find(item => item.id === event.id);
  if (!existing) {
    store.events.unshift(event);
    writeStore(store);
  }
  return event;
}

function listEvents(filters = {}) {
  const stored = readStore().events;
  const events = stored.length ? stored : DEMO_EVENTS;
  return events.filter(event => {
    if (filters.tab === 'alerts' && (!['warning', 'error', 'critical'].includes(event.level) || !['open', 'acknowledged'].includes(event.status))) return false;
    if (filters.tab && !['all', 'alerts'].includes(filters.tab) && event.tab !== filters.tab) return false;
    if (filters.level && filters.level !== 'all' && event.level !== filters.level) return false;
    if (filters.status && filters.status !== 'all' && event.status !== filters.status) return false;
    if (filters.q && !`${event.source} ${event.eventType} ${event.message}`.toLowerCase().includes(String(filters.q).toLowerCase())) return false;
    return true;
  }).slice(0, 300);
}

function acknowledgeEvent(id, status) {
  const allowed = new Set(['acknowledged', 'resolved', 'ignored', 'open']);
  if (!allowed.has(status)) throw new Error('Invalid observability status');
  const store = readStore();
  const event = store.events.find(item => item.id === id);
  if (!event) throw new Error('Observability event not found');
  event.status = status;
  writeStore(store);
  return event;
}

function summarize(events) {
  return events.reduce((summary, event) => {
    summary.total += 1;
    summary.byTab[event.tab] = (summary.byTab[event.tab] || 0) + 1;
    if (['warning', 'error', 'critical'].includes(event.level) && ['open', 'acknowledged'].includes(event.status)) summary.openAlerts += 1;
    if (event.level === 'critical') summary.critical += 1;
    return summary;
  }, { total: 0, openAlerts: 0, critical: 0, byTab: {} });
}

module.exports = { recordEvent, listEvents, acknowledgeEvent, summarize, DATA_FILE };
