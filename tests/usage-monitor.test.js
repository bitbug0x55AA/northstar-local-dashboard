const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { usageFromPath } = require('../server/usage-monitor');

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-usage-v2-'));
}

test('Codex adapter deduplicates request deltas and keeps the latest context gauge', t => {
  const directory = tempDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = { timestamp: '2026-08-09T01:00:00Z', request_id: 'request-1', payload: { session_id: 'session-1', model: 'gpt-test', info: { context_window: 100000, context_tokens: 90000, last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, total_token_usage: { total_tokens: 999999 } } } };
  const duplicateAfterCompact = { ...first, timestamp: '2026-08-09T01:01:00Z', payload: { ...first.payload, info: { ...first.payload.info, context_tokens: 20000 } } };
  fs.writeFileSync(path.join(directory, 'session.jsonl'), `${JSON.stringify(first)}\n${JSON.stringify(duplicateAfterCompact)}\n`);
  const usage = usageFromPath('codex', directory, 1000000);
  assert.equal(usage.monthTokens, 120, 'the same request id must only count once');
  assert.equal(usage.ingestion.duplicateEvents, 1);
  assert.equal(usage.sessionDetails[0].contextTokens, 20000, 'context is a latest-value gauge, not a historical maximum');
  assert.equal(usage.sessionDetails[0].latestContextTokens, 20000);
  assert.equal(usage.ingestion.confidence.level, 'verified', 'successfully deduplicated records do not reduce confidence');
});

test('unsupported cumulative Codex snapshots are not added as request usage', t => {
  const directory = tempDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cumulativeOnly = { timestamp: new Date().toISOString(), payload: { session_id: 'session-2', info: { total_token_usage: { total_tokens: 500000 }, rate_limits: { credits: { has_credits: true } } } } };
  fs.writeFileSync(path.join(directory, 'session.jsonl'), `${JSON.stringify(cumulativeOnly)}\n`);
  const usage = usageFromPath('codex', directory, 1000000);
  assert.equal(usage.monthTokens, 0);
  assert.equal(usage.ingestion.recordsAccepted, 0);
  assert.equal(usage.ingestion.confidence.level, 'unavailable');
  assert.equal(usage.creditSnapshots.length, 0, 'a credits object without a balance is not a zero-balance snapshot');
});

test('Claude adapter reports explicit tool failures without involving Ollama', t => {
  const directory = tempDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const timestamp = new Date().toISOString();
  const records = [
    { timestamp, type: 'assistant', sessionId: 'claude-1', requestId: 'r1', message: { model: 'claude-test', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'tool-1' }] } },
    { timestamp, type: 'user', sessionId: 'claude-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true }] } }
  ];
  fs.writeFileSync(path.join(directory, 'session.jsonl'), `${records.map(JSON.stringify).join('\n')}\n`);
  const usage = usageFromPath('claude', directory, 1000000);
  assert.equal(usage.monthTokens, 15);
  assert.equal(usage.runtime.toolCalls, 1);
  assert.equal(usage.runtime.toolResults, 1);
  assert.equal(usage.runtime.toolFailures, 1);
  assert.equal(usage.runtime.toolSuccessRate, 0);
  assert.equal(JSON.stringify(usage).includes('ollama'), false);
});

test('malformed records and path fallback are surfaced safely', t => {
  const directory = tempDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const record = { timestamp: new Date().toISOString(), type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 1 } } };
  fs.writeFileSync(path.join(directory, 'private-session.jsonl'), `{bad json}\n${JSON.stringify(record)}\n`);
  const usage = usageFromPath('claude', directory, 1000000);
  assert.equal(usage.ingestion.parseErrors, 1);
  assert.match(usage.sessionDetails[0].id, /^log-[a-f0-9]{12}$/);
  assert.equal(JSON.stringify(usage).includes(directory), false, 'API data must not expose a local log path');
});
