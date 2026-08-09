const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PARSER_VERSION = 'usage-v2';
const DEFAULT_FILE_LIMIT = 600;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

const SESSION_ADVISORY = {
  compactAtPercent: 80,
  startFreshAtPercent: 92,
  remainingFloorTokens: 16000,
  activeForMinutes: 15
};

function numberAt(record, paths) {
  for (const name of paths) {
    const value = name.split('.').reduce((current, key) => current && current[key], record);
    if (value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function valueAt(record, paths) {
  for (const name of paths) {
    const value = name.split('.').reduce((current, key) => current && current[key], record);
    if (value !== '' && value !== null && value !== undefined) return value;
  }
  return null;
}

function timestampOf(record, fallback) {
  const value = valueAt(record, ['timestamp', 'created_at', 'createdAt', 'time', 'date']);
  const date = value ? new Date(value) : fallback;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function safeId(value, fallback) {
  if (value) return String(value).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || fallback;
  return fallback;
}

function opaqueFileId(filePath) {
  return `log-${crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 12)}`;
}

function titleOf(record) {
  const raw = valueAt(record, ['session_name', 'sessionName', 'title', 'conversation_title', 'conversationTitle', 'payload.session_name', 'payload.sessionName', 'payload.title', 'payload.conversation_title', 'payload.input.text', 'message.title']);
  if (typeof raw !== 'string') return null;
  const value = raw.replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, 96) : null;
}

function usageBreakdown(record, provider) {
  const prefix = provider === 'codex' ? 'payload.info.last_token_usage.' : 'message.usage.';
  const input = numberAt(record, provider === 'codex' ? [`${prefix}input_tokens`] : [`${prefix}input_tokens`, 'usage.input_tokens']);
  const output = numberAt(record, provider === 'codex' ? [`${prefix}output_tokens`] : [`${prefix}output_tokens`, 'usage.output_tokens']);
  const cacheRead = numberAt(record, provider === 'codex'
    ? [`${prefix}cached_input_tokens`, `${prefix}cache_read_input_tokens`]
    : [`${prefix}cache_read_input_tokens`, `${prefix}cached_input_tokens`, 'usage.cache_read_input_tokens']);
  const cacheWrite = numberAt(record, provider === 'codex'
    ? [`${prefix}cache_write_input_tokens`]
    : [`${prefix}cache_creation_input_tokens`, `${prefix}cache_write_input_tokens`, 'usage.cache_creation_input_tokens']);
  const values = { input: input || 0, output: output || 0, cacheRead: cacheRead || 0, cacheWrite: cacheWrite || 0 };
  const explicitTotal = numberAt(record, provider === 'codex'
    ? [`${prefix}total_tokens`]
    : [`${prefix}total_tokens`, 'usage.total_tokens']);
  const sum = Object.values(values).reduce((total, value) => total + value, 0);
  return { ...values, total: explicitTotal || sum };
}

function codexAdapter(record) {
  const lastUsage = record?.payload?.info?.last_token_usage;
  const isTokenEvent = Boolean(lastUsage && typeof lastUsage === 'object');
  return {
    usage: isTokenEvent ? usageBreakdown(record, 'codex') : null,
    usageKind: isTokenEvent ? 'delta' : null,
    sessionId: valueAt(record, ['session_id', 'sessionId', 'conversation_id', 'payload.session_id']),
    requestId: valueAt(record, ['request_id', 'requestId', 'call_id', 'callId', 'payload.request_id', 'payload.id']),
    model: valueAt(record, ['model', 'modelName', 'payload.model', 'payload.thread_settings.model', 'payload.collaboration_mode.settings.model']),
    contextTokens: numberAt(record, ['context_tokens', 'contextTokens', 'payload.info.context_tokens', 'payload.info.last_token_usage.context_tokens']),
    contextWindow: numberAt(record, ['context_window', 'contextWindow', 'payload.info.context_window']),
    limits: normalizeLimitSnapshot(record)
  };
}

function claudeAdapter(record) {
  const messageUsage = record?.message?.usage || record?.usage;
  const isAssistantUsage = Boolean(messageUsage && typeof messageUsage === 'object' && (record.type === 'assistant' || record.message?.role === 'assistant'));
  return {
    usage: isAssistantUsage ? usageBreakdown(record, 'claude') : null,
    usageKind: isAssistantUsage ? 'delta' : null,
    sessionId: valueAt(record, ['sessionId', 'session_id', 'conversationId', 'conversation_id']),
    requestId: valueAt(record, ['requestId', 'request_id', 'message.id', 'uuid']),
    model: valueAt(record, ['message.model', 'model', 'modelName']),
    contextTokens: numberAt(record, ['context_tokens', 'contextTokens', 'message.usage.context_tokens', 'usage.context_tokens']),
    contextWindow: numberAt(record, ['context_window', 'contextWindow', 'message.usage.context_window', 'usage.context_window']),
    limits: normalizeLimitSnapshot(record)
  };
}

function operationSignals(record, provider) {
  const payloadType = String(record?.payload?.type || '').toLowerCase();
  const recordType = String(record?.type || '').toLowerCase();
  const content = Array.isArray(record?.message?.content) ? record.message.content : [];
  const toolCalls = provider === 'codex'
    ? Number(['function_call', 'custom_tool_call', 'web_search_call'].includes(payloadType))
    : content.filter(item => item?.type === 'tool_use').length;
  const toolResults = provider === 'codex'
    ? Number(['function_call_output', 'custom_tool_call_output'].includes(payloadType))
    : content.filter(item => item?.type === 'tool_result').length;
  const toolFailures = provider === 'codex'
    ? Number(toolResults > 0 && (record?.payload?.is_error === true || record?.payload?.success === false))
    : content.filter(item => item?.type === 'tool_result' && item.is_error === true).length;
  const providerError = recordType === 'error' || payloadType === 'error' || String(record?.level || '').toLowerCase() === 'error' || Boolean(record?.error);
  const durationMs = numberAt(record, ['duration_ms', 'durationMs', 'latency_ms', 'latencyMs', 'payload.duration_ms', 'message.duration_ms']);
  return { toolCalls, toolResults, toolFailures, providerErrors: Number(providerError), durationMs };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
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
  const usedPercent = valueAt(window, ['used_percent', 'usedPercent', 'usage_percent', 'usagePercent', 'percent_used', 'percentUsed']);
  const windowMinutes = valueAt(window, ['window_minutes', 'windowMinutes', 'window_mins', 'windowMins']);
  return {
    usedPercent: usedPercent === null ? null : Number(usedPercent),
    windowMinutes: windowMinutes === null ? null : Number(windowMinutes),
    resetsAt: normalizeReset(valueAt(window, ['resets_at', 'resetsAt', 'reset_at', 'resetAt']))
  };
}

function normalizeLimitSnapshot(record) {
  const limits = record?.payload?.info?.rate_limits || record?.payload?.rate_limits || record?.rate_limits || record?.rateLimits || record?.limits;
  if (!limits) return null;
  const credits = limits.credits || limits.credit;
  return {
    planType: valueAt(limits, ['plan_type', 'planType']),
    limitId: valueAt(limits, ['limit_id', 'limitId']),
    primary: normalizeLimitWindow(limits.primary || limits.primary_window || limits.primaryWindow),
    secondary: normalizeLimitWindow(limits.secondary || limits.secondary_window || limits.secondaryWindow),
    credits: credits ? { hasCredits: valueAt(credits, ['has_credits', 'hasCredits']), unlimited: valueAt(credits, ['unlimited']), balance: valueAt(credits, ['balance']) } : null,
    rateLimitReached: valueAt(limits, ['rate_limit_reached', 'rateLimitReached']),
    rateLimitReachedType: valueAt(limits, ['rate_limit_reached_type', 'rateLimitReachedType'])
  };
}

function discoverFiles(targetPath, limit = DEFAULT_FILE_LIMIT) {
  const health = { filesDiscovered: 0, filesRead: 0, filesSkipped: 0, recordsSeen: 0, recordsAccepted: 0, parseErrors: 0, duplicateEvents: 0, bytesRead: 0 };
  if (!targetPath || !fs.existsSync(targetPath)) return { files: [], health };
  const pending = [targetPath];
  const candidates = [];
  while (pending.length) {
    const current = pending.pop();
    let stat;
    try { stat = fs.statSync(current); } catch { health.filesSkipped += 1; continue; }
    if (stat.isDirectory()) {
      let entries = [];
      try { entries = fs.readdirSync(current); } catch { health.filesSkipped += 1; }
      for (const entry of entries) pending.push(path.join(current, entry));
    } else if (/\.(jsonl|ndjson)$/i.test(current)) {
      health.filesDiscovered += 1;
      candidates.push({ path: current, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  health.filesSkipped += Math.max(0, candidates.length - limit);
  return { files: candidates.slice(0, limit), health };
}

function recordsForFile(file, health) {
  if (file.size > MAX_FILE_BYTES) { health.filesSkipped += 1; return []; }
  const cached = cache.get(file.path);
  if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
    health.filesRead += 1;
    health.recordsSeen += cached.recordsSeen;
    health.parseErrors += cached.parseErrors;
    return cached.records;
  }
  let text;
  try { text = fs.readFileSync(file.path, 'utf8'); } catch { health.filesSkipped += 1; return []; }
  health.filesRead += 1;
  health.bytesRead += Buffer.byteLength(text);
  let parseErrors = 0;
  let recordsSeen = 0;
  const records = text.split(/\r?\n/).filter(Boolean).flatMap((line, index) => {
    recordsSeen += 1;
    try { return [{ record: JSON.parse(line), line: index + 1 }]; } catch { parseErrors += 1; return []; }
  });
  health.recordsSeen += recordsSeen;
  health.parseErrors += parseErrors;
  cache.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, records, recordsSeen, parseErrors });
  return records;
}

function recommendation(session, now) {
  if (!session.contextWindow || session.contextTokens === null) return null;
  const ageMinutes = Math.max(0, (now - new Date(session.lastActiveAt)) / 60000);
  if (ageMinutes > SESSION_ADVISORY.activeForMinutes) return null;
  const remaining = Math.max(0, session.contextWindow - session.contextTokens);
  const percent = Math.round(session.contextTokens / session.contextWindow * 100);
  if (percent >= SESSION_ADVISORY.startFreshAtPercent || remaining <= SESSION_ADVISORY.remainingFloorTokens) return { level: 'high', action: 'start_fresh', message: 'The latest reported context snapshot is near its model window.' };
  if (percent >= SESSION_ADVISORY.compactAtPercent) return { level: 'medium', action: 'compact', message: 'The latest reported context snapshot is large enough to consider compaction.' };
  return null;
}

function confidenceFor(health, lastEventAt) {
  if (!health.filesDiscovered) return { level: 'unavailable', reason: 'No supported log files were found.' };
  if (!health.recordsAccepted) return { level: 'unavailable', reason: 'No supported usage events were found.' };
  if (health.parseErrors || health.filesSkipped) return { level: 'partial', reason: 'Some records were skipped or malformed.' };
  if (lastEventAt && Date.now() - new Date(lastEventAt).getTime() > STALE_AFTER_MS) return { level: 'stale', reason: 'The newest supported event is more than 24 hours old.' };
  return { level: 'verified', reason: 'All discovered records were parsed using a versioned provider adapter.' };
}

function usageFromPath(provider, targetPath, budgetTokens) {
  const adapter = provider === 'codex' ? codexAdapter : claudeAdapter;
  const { files, health } = discoverFiles(targetPath, Number(process.env.NORTHSTAR_USAGE_FILE_LIMIT || DEFAULT_FILE_LIMIT));
  const now = new Date();
  const todayKey = localDateKey(now);
  const monthKey = todayKey.slice(0, 7);
  const byDay = new Map();
  const models = new Map();
  const sessions = new Map();
  const seenEvents = new Set();
  const breakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let todayTokens = 0;
  let monthTokens = 0;
  let limits = null;
  let limitsAt = null;
  let lastEventAt = null;
  const creditSnapshots = new Map();
  const runtime = { eventsObserved: 0, requests: 0, providerErrors: 0, toolCalls: 0, toolResults: 0, toolFailures: 0, latencySamples: [] };

  for (const file of files) {
    const fallbackDate = new Date(file.mtimeMs);
    const fileId = opaqueFileId(file.path);
    for (const item of recordsForFile(file, health)) {
      const parsed = adapter(item.record);
      const signals = operationSignals(item.record, provider);
      runtime.eventsObserved += 1;
      runtime.providerErrors += signals.providerErrors;
      runtime.toolCalls += signals.toolCalls;
      runtime.toolResults += signals.toolResults;
      runtime.toolFailures += signals.toolFailures;
      if (signals.durationMs !== null) runtime.latencySamples.push(signals.durationMs);
      const observedAt = timestampOf(item.record, fallbackDate);
      if (!observedAt) continue;
      const sessionId = safeId(parsed.sessionId, fileId);
      const current = sessions.get(sessionId) || { id: sessionId, provider, model: null, title: null, contextWindow: null, contextTokens: null, updatedAt: null, tokens: 0, latestContextTokens: null, lastActiveAt: observedAt.toISOString() };
      const model = parsed.model ? String(parsed.model).slice(0, 80) : current.model;
      const title = titleOf(item.record) || current.title;
      if (!current.updatedAt || observedAt >= new Date(current.updatedAt)) {
        current.updatedAt = observedAt.toISOString();
        current.lastActiveAt = observedAt.toISOString();
        current.model = model;
        current.title = title;
        if (parsed.contextWindow !== null) current.contextWindow = parsed.contextWindow;
        if (parsed.contextTokens !== null) {
          current.contextTokens = parsed.contextTokens;
          current.latestContextTokens = parsed.contextTokens;
        }
      }
      sessions.set(sessionId, current);

      if (parsed.limits && (!limitsAt || observedAt >= limitsAt)) { limits = parsed.limits; limitsAt = observedAt; }
      const rawCreditBalance = parsed.limits?.credits?.balance;
      const creditBalance = Number(rawCreditBalance);
      if (rawCreditBalance !== null && rawCreditBalance !== undefined && rawCreditBalance !== '' && Number.isFinite(creditBalance)) {
        const snapshot = { provider, observedAt: observedAt.toISOString(), balance: creditBalance, currency: 'credits', source: 'provider_log' };
        creditSnapshots.set(`${snapshot.observedAt}:${snapshot.balance}`, snapshot);
      }
      if (!parsed.usage || parsed.usageKind !== 'delta' || !parsed.usage.total) continue;
      const eventId = parsed.requestId ? `${provider}:${sessionId}:${parsed.requestId}` : `${provider}:${fileId}:${item.line}`;
      if (seenEvents.has(eventId)) { health.duplicateEvents += 1; continue; }
      seenEvents.add(eventId);
      health.recordsAccepted += 1;
      runtime.requests += 1;
      if (!lastEventAt || observedAt > lastEventAt) lastEventAt = observedAt;
      const day = localDateKey(observedAt);
      byDay.set(day, (byDay.get(day) || 0) + parsed.usage.total);
      if (day === todayKey) todayTokens += parsed.usage.total;
      if (day.startsWith(monthKey)) {
        monthTokens += parsed.usage.total;
        for (const key of Object.keys(breakdown)) breakdown[key] += parsed.usage[key];
      }
      if (model) models.set(model, (models.get(model) || 0) + parsed.usage.total);
      current.tokens += parsed.usage.total;
      sessions.set(sessionId, current);
    }
  }

  const daily = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(now); date.setDate(now.getDate() - (13 - index));
    return Math.round((byDay.get(localDateKey(date)) || 0) / 1000);
  });
  const modelTotal = Array.from(models.values()).reduce((sum, value) => sum + value, 0);
  const colors = ['teal', 'blue', 'amber'];
  const sessionDetails = Array.from(sessions.values()).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  const sessionWindows = sessionDetails.filter(session => session.contextWindow && session.contextTokens !== null).slice(0, 20).map(session => {
    const contextTokens = Math.min(session.contextTokens, session.contextWindow);
    const remainingTokens = Math.max(0, session.contextWindow - contextTokens);
    const usedPercent = Math.round(contextTokens / session.contextWindow * 100);
    return { id: session.id, shortId: session.id.slice(0, 8), title: session.title || `Session ${session.id.slice(0, 8)}`, model: session.model, contextWindow: session.contextWindow, contextTokens, remainingTokens, usedPercent, updatedAt: session.updatedAt, needsAttention: usedPercent >= SESSION_ADVISORY.startFreshAtPercent || remainingTokens <= SESSION_ADVISORY.remainingFloorTokens };
  });
  const confidence = confidenceFor(health, lastEventAt);
  const completedTools = runtime.toolResults;
  const runtimeSummary = {
    eventsObserved: runtime.eventsObserved,
    requests: runtime.requests,
    providerErrors: runtime.providerErrors,
    toolCalls: runtime.toolCalls,
    toolResults: completedTools,
    toolFailures: runtime.toolFailures,
    toolSuccessRate: completedTools ? Math.round((completedTools - runtime.toolFailures) / completedTools * 1000) / 10 : null,
    latencyP50Ms: percentile(runtime.latencySamples, 0.5),
    latencyP95Ms: percentile(runtime.latencySamples, 0.95)
  };
  return {
    todayTokens, monthTokens, budgetTokens, sessions: sessionDetails.filter(item => item.tokens > 0).length,
    source: files.length ? 'local' : 'missing', reset: 'local', tokenBreakdown: breakdown, daily,
    sessionDetails, sessionWindows, limits: limits ? { ...limits, updatedAt: limitsAt.toISOString() } : null,
    models: Array.from(models.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, tokens], index) => ({ name, value: modelTotal ? Math.round(tokens / modelTotal * 100) : 0, tokens, color: colors[index % colors.length] })),
    ingestion: { parserVersion: PARSER_VERSION, provider, ...health, lastEventAt: lastEventAt ? lastEventAt.toISOString() : null, confidence },
    runtime: runtimeSummary,
    creditSnapshots: Array.from(creditSnapshots.values()).sort((a, b) => new Date(a.observedAt) - new Date(b.observedAt))
  };
}

function mergeModels(groups) {
  const totals = new Map();
  for (const group of groups) for (const model of group || []) totals.set(model.name, (totals.get(model.name) || 0) + Number(model.tokens || 0));
  const grandTotal = Array.from(totals.values()).reduce((sum, value) => sum + value, 0);
  const colors = ['teal', 'blue', 'amber'];
  return Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, tokens], index) => ({ name, value: grandTotal ? Math.round(tokens / grandTotal * 100) : 0, tokens, color: colors[index % colors.length] }));
}

function getLocalUsage(options = {}) {
  const home = options.home || process.env.USERPROFILE || process.env.HOME || '';
  const codexPath = options.codexPath || process.env.CODEX_USAGE_PATH || (home ? path.join(home, '.codex', 'sessions') : '');
  const claudePath = options.claudePath || process.env.CLAUDE_USAGE_PATH || (home ? path.join(home, '.claude') : '');
  const codex = usageFromPath('codex', codexPath, Number(process.env.CODEX_BUDGET_TOKENS || 4400000));
  const claude = usageFromPath('claude', claudePath, Number(process.env.CLAUDE_BUDGET_TOKENS || 3600000));
  const now = new Date();
  const dailyDates = codex.daily.map((_, index) => { const date = new Date(now); date.setDate(now.getDate() - (13 - index)); return localDateKey(date); });
  const sessionMonitor = [...codex.sessionDetails, ...claude.sessionDetails]
    .map(session => ({ ...session, recommendation: recommendation(session, now) }))
    .sort((a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt));
  return {
    codex, claude, daily: codex.daily.map((value, index) => value + claude.daily[index]),
    dailyByProvider: { codex: codex.daily, claude: claude.daily }, dailyDates,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    sessionMonitor: { thresholds: SESSION_ADVISORY, sessions: sessionMonitor.slice(0, 30), alerts: sessionMonitor.filter(item => item.recommendation).slice(0, 8) },
    models: mergeModels([codex.models, claude.models]),
    sessionWindows: [...codex.sessionWindows.map(item => ({ ...item, provider: 'Codex' })), ...claude.sessionWindows.map(item => ({ ...item, provider: 'Claude Code' }))].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)),
    measurement: { schemaVersion: 2, usage: 'provider-reported request deltas', context: 'latest explicit provider snapshot only', generatedAt: now.toISOString() },
    fetchedAt: now.toISOString()
  };
}

module.exports = { PARSER_VERSION, SESSION_ADVISORY, codexAdapter, claudeAdapter, usageFromPath, getLocalUsage };
