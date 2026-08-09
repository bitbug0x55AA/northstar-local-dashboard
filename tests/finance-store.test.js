const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { readStore, updateFinance } = require('../server/finance-store');

test('finance ledger deduplicates balance snapshots and reconciles monthly changes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-finance-'));
  const filePath = path.join(directory, 'finance.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const usage = { codex: { creditSnapshots: [
    { provider: 'codex', observedAt: '2026-08-09T00:00:00Z', balance: 100 },
    { provider: 'codex', observedAt: '2026-08-09T00:05:00Z', balance: 90 },
    { provider: 'codex', observedAt: '2026-08-09T00:10:00Z', balance: 140 },
    { provider: 'codex', observedAt: '2026-08-09T00:10:00Z', balance: 140 }
  ] }, claude: { creditSnapshots: [] } };
  const finance = updateFinance(usage, { filePath, now: '2026-08-09T12:00:00Z' });
  assert.equal(finance.codex.currentBalance, 140);
  assert.equal(finance.codex.month.consumptionEvents, 1);
  assert.equal(finance.codex.month.creditsConsumed, 10);
  assert.equal(finance.codex.month.creditIncreaseEvents, 1);
  assert.equal(finance.codex.month.creditsIncreased, 50);
  assert.equal(finance.codex.changes.every(item => item.confidence === 'high'), true);
  assert.equal(finance.codex.month.actualCashSpent, null, 'cash spend must remain unknown without billing transactions');
  assert.equal(readStore(filePath).snapshots.length, 3);
});

test('finance scope excludes Ollama and retains prior snapshots across refreshes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-finance-'));
  const filePath = path.join(directory, 'finance.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  updateFinance({ codex: { creditSnapshots: [{ provider: 'codex', observedAt: '2026-08-01T00:00:00Z', balance: 20 }] }, claude: { creditSnapshots: [] } }, { filePath, now: '2026-08-01T01:00:00Z' });
  const finance = updateFinance({ codex: { creditSnapshots: [] }, claude: { creditSnapshots: [{ provider: 'claude', observedAt: '2026-08-02T00:00:00Z', balance: 30 }] } }, { filePath, now: '2026-08-02T01:00:00Z' });
  assert.deepEqual(finance.scope, ['codex', 'claude']);
  assert.equal(finance.codex.currentBalance, 20);
  assert.equal(finance.claude.currentBalance, 30);
  assert.equal(JSON.stringify(finance).toLowerCase().includes('ollama'), false);
});
