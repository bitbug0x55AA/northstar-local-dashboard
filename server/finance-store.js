const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const DEFAULT_FILE = process.env.NORTHSTAR_FINANCE_PATH || (HOME ? path.join(HOME, '.northstar', 'ai-finance.json') : path.join(process.cwd(), '.northstar-finance.json'));
const MAX_SNAPSHOTS = 10000;

function emptyStore() {
  return { schemaVersion: 1, snapshots: [], updatedAt: null };
}

function readStore(filePath = DEFAULT_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { schemaVersion: 1, snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [], updatedAt: parsed.updatedAt || null };
  } catch {
    return emptyStore();
  }
}

function writeStore(store, filePath = DEFAULT_FILE) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, snapshots: store.snapshots.slice(-MAX_SNAPSHOTS), updatedAt: new Date().toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, filePath);
}

function normalizeSnapshot(input) {
  const provider = input?.provider === 'codex' ? 'codex' : input?.provider === 'claude' ? 'claude' : null;
  const observedAt = new Date(input?.observedAt);
  const balance = Number(input?.balance);
  if (!provider || input?.balance === null || input?.balance === undefined || input?.balance === '' || Number.isNaN(observedAt.getTime()) || !Number.isFinite(balance) || balance < 0) return null;
  return { provider, observedAt: observedAt.toISOString(), balance, currency: 'credits', source: 'provider_log' };
}

function transactionId(provider, previous, current) {
  return `${provider}:${previous.observedAt}:${current.observedAt}:${previous.balance}:${current.balance}`;
}

function reconcileProvider(provider, snapshots, now) {
  const ordered = snapshots.filter(item => item.provider === provider).sort((a, b) => new Date(a.observedAt) - new Date(b.observedAt));
  const changes = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const delta = current.balance - previous.balance;
    if (!delta) continue;
    const gapMinutes = Math.max(0, Math.round((new Date(current.observedAt) - new Date(previous.observedAt)) / 60000));
    changes.push({
      id: transactionId(provider, previous, current), provider,
      type: delta > 0 ? 'credit_increase' : 'credit_consumption',
      amountCredits: Math.abs(delta), balanceBefore: previous.balance, balanceAfter: current.balance,
      observedAt: current.observedAt, intervalStartedAt: previous.observedAt, gapMinutes,
      confidence: gapMinutes <= 15 ? 'high' : gapMinutes <= 180 ? 'medium' : 'low',
      source: 'balance_reconciliation'
    });
  }
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthChanges = changes.filter(item => {
    const date = new Date(item.observedAt);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` === month;
  });
  const increases = monthChanges.filter(item => item.type === 'credit_increase');
  const consumption = monthChanges.filter(item => item.type === 'credit_consumption');
  const latest = ordered.at(-1) || null;
  return {
    provider, currentBalance: latest?.balance ?? null, balanceObservedAt: latest?.observedAt || null,
    snapshotCount: ordered.length,
    month: {
      creditIncreaseEvents: increases.length,
      creditsIncreased: increases.reduce((sum, item) => sum + item.amountCredits, 0),
      consumptionEvents: consumption.length,
      creditsConsumed: consumption.reduce((sum, item) => sum + item.amountCredits, 0),
      actualCashSpent: null,
      cashCurrency: null
    },
    changes: changes.slice(-100).reverse(),
    disclosure: 'Balance increases are observed credit additions. Without billing transaction data they cannot distinguish purchases, auto top-ups, grants, refunds, expiry, or shared-pool activity.'
  };
}

function updateFinance(usage, options = {}) {
  const filePath = options.filePath || DEFAULT_FILE;
  const store = readStore(filePath);
  const incoming = [...(usage?.codex?.creditSnapshots || []), ...(usage?.claude?.creditSnapshots || [])].map(normalizeSnapshot).filter(Boolean);
  const unique = new Map(store.snapshots.map(item => [`${item.provider}:${item.observedAt}:${item.balance}`, item]));
  for (const snapshot of incoming) unique.set(`${snapshot.provider}:${snapshot.observedAt}:${snapshot.balance}`, snapshot);
  const snapshots = Array.from(unique.values()).sort((a, b) => new Date(a.observedAt) - new Date(b.observedAt)).slice(-MAX_SNAPSHOTS);
  const changed = snapshots.length !== store.snapshots.length;
  if (changed) writeStore({ ...store, snapshots }, filePath);
  const now = options.now ? new Date(options.now) : new Date();
  return {
    schemaVersion: 1,
    scope: ['codex', 'claude'],
    codex: reconcileProvider('codex', snapshots, now),
    claude: reconcileProvider('claude', snapshots, now),
    generatedAt: now.toISOString()
  };
}

module.exports = { DEFAULT_FILE, readStore, updateFinance, reconcileProvider };
