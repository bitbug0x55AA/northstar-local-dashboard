(function () {
  const state = { tab: 'all', level: 'all', status: 'all', q: '', events: [], summary: { total: 0, openAlerts: 0, critical: 0, byTab: {} } };
  const tabs = [['all', 'Overview'], ['security', 'Security Audit'], ['debug', 'Debug'], ['application', 'Application Logs'], ['llm', 'Local LLM'], ['usage', 'Codex / Claude Usage'], ['alerts', 'Alerts']];
  const label = { security: 'Security Audit', debug: 'Debug', application: 'Application Logs', llm: 'Local LLM', usage: 'Codex / Claude Usage', alerts: 'Alerts' };
  const ruleDocs = {
    'USAGE-QUOTA-80': { title: 'Codex / Claude quota at 80%', meaning: 'The local usage importer found that a hosted coding assistant has consumed at least 80% of its observed quota window. This is a capacity warning, not a security incident and not a local LLM failure.', action: 'Review the reset time, reduce non-essential long sessions, or wait for the provider window to reset.' },
    'USAGE-QUOTA-95': { title: 'Codex / Claude quota at 95%', meaning: 'The hosted coding assistant is close to its observed quota limit. Long tasks may be throttled, delayed, or unavailable until reset.', action: 'Save work, avoid large exploratory runs, and check the provider reset time before continuing.' },
    'LLM-DENY-001': { title: 'Local LLM operation blocked', meaning: 'The local model proposed an operation that the Planner safety policy does not permit.', action: 'Review the proposed operation and keep it blocked unless you can establish a safe, explicit alternative.' }
  };
  const genericDocs = {
    warning: { title: 'Warning', meaning: 'The system detected an unusual or potentially risky condition. It has not necessarily caused damage.', action: 'Review the event details and decide whether to acknowledge, resolve, or investigate it.' },
    error: { title: 'Error', meaning: 'A Northstar operation failed or returned an unusable result. This may affect freshness or reliability of the related data.', action: 'Check the source and event type, retry the operation, and inspect Debug logs if it repeats.' },
    critical: { title: 'Critical event', meaning: 'A high-impact condition was detected and should be treated as requiring immediate review.', action: 'Stop the affected workflow, preserve the event details, and investigate before retrying.' }
  };
  const escape = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const when = value => new Date(value).toLocaleString(navigator.language || 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  async function load() {
    const params = new URLSearchParams({ tab: state.tab, level: state.level, status: state.status, q: state.q });
    const response = await fetch(`/api/observability?${params}`);
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : { error: `Observability API returned ${response.status} ${response.statusText}. Restart the Northstar server on the current branch.` };
    if (!response.ok || data.error) throw new Error(data.error || 'Unable to load observability data');
    state.events = data.events; state.summary = data.summary; render();
  }
  function eventRow(event) {
    const detail = Object.entries(event.details || {}).map(([key, value]) => `${escape(key)}: ${escape(value)}`).join(' · ');
    const explanation = ruleDocs[event.ruleId] || genericDocs[event.level];
    const explainHtml = explanation && event.level !== 'info' && event.level !== 'debug' ? `<div class="obs-explanation"><b>What this means</b><span>${escape(explanation.meaning)}</span><b>Recommended action</b><span>${escape(explanation.action)}</span></div>` : '';
    return `<div class="obs-event"><div class="obs-event-main"><div class="obs-event-top"><span class="obs-level ${event.level}">${escape(event.level)}</span><b>${escape(event.message)}</b></div><div class="obs-meta">${escape(label[event.tab] || event.tab)} · ${escape(event.source)} · ${escape(event.eventType)} · ${when(event.timestamp)}</div>${detail ? `<div class="obs-details">${detail}</div>` : ''}${explainHtml}</div><div class="obs-event-actions"><span class="obs-status ${event.status}">${escape(event.status)}</span>${event.status !== 'resolved' ? `<button class="ghost-button obs-action" data-id="${escape(event.id)}" data-status="resolved">Resolve</button>` : ''}</div></div>`;
  }
  function render() {
    const summary = state.summary;
    document.querySelector('#view-observability').innerHTML = `<div class="page-heading"><div><div class="eyebrow">OPERATIONS TELEMETRY</div><h1>Logs & Audit</h1><p>按语义区分安全事件、调试信息、应用日志、本地 LLM 行为以及 Codex / Claude 用量。</p></div><button class="primary-button" id="obsRefresh">↻ Refresh</button></div><div class="metric-grid">${metric('Total Events', summary.total, 'Stored locally', '')}${metric('Open Alerts', summary.openAlerts, 'Needs attention', summary.openAlerts ? 'warn' : 'good')}${metric('Critical', summary.critical, 'Across all categories', summary.critical ? 'warn' : 'good')}</div><div class="panel obs-guide"><div class="panel-title">How to read these logs</div><div class="obs-guide-grid"><div><b>warning</b><span>Needs review; it does not automatically mean data loss or compromise.</span></div><div><b>error</b><span>An operation failed and may affect reliability or data freshness.</span></div><div><b>critical</b><span>High-impact condition; pause the affected workflow and investigate.</span></div><div><b>Usage vs Local LLM</b><span>Codex / Claude tabs describe hosted quota usage. Local LLM tabs describe Ollama behavior and policy boundaries.</span></div></div></div><div class="filter-row obs-tabs">${tabs.map(([id, name]) => `<button class="filter ${state.tab === id ? 'active' : ''}" data-obs-tab="${id}">${name}${id !== 'all' && summary.byTab[id] ? ` <small>${summary.byTab[id]}</small>` : ''}</button>`).join('')}</div><div class="obs-toolbar"><input id="obsQuery" value="${escape(state.q)}" placeholder="Search source, event type, or message" /><select id="obsLevel"><option value="all">All levels</option><option value="debug">Debug</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option><option value="critical">Critical</option></select><select id="obsStatus"><option value="all">All statuses</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option><option value="ignored">Ignored</option></select></div><div class="panel obs-panel"><div class="panel-header"><div><div class="panel-title">${state.tab === 'all' ? 'Recent Activity' : escape(label[state.tab])}</div><div class="panel-subtitle">Sensitive values are redacted before persistence.</div></div></div><div class="obs-list">${state.events.map(eventRow).join('') || '<div class="empty">No events match these filters.</div>'}</div></div>`;
    const level = document.querySelector('#obsLevel'); level.value = state.level;
    const status = document.querySelector('#obsStatus'); status.value = state.status;
    document.querySelectorAll('[data-obs-tab]').forEach(button => button.addEventListener('click', () => { state.tab = button.dataset.obsTab; load().catch(showError); }));
    document.querySelector('#obsRefresh').addEventListener('click', () => load().catch(showError));
    document.querySelector('#obsLevel').addEventListener('change', event => { state.level = event.target.value; load().catch(showError); });
    document.querySelector('#obsStatus').addEventListener('change', event => { state.status = event.target.value; load().catch(showError); });
    document.querySelector('#obsQuery').addEventListener('change', event => { state.q = event.target.value.trim(); load().catch(showError); });
    document.querySelectorAll('.obs-action').forEach(button => button.addEventListener('click', async () => { await fetch('/api/observability/events', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: button.dataset.id, status: button.dataset.status }) }); load().catch(showError); }));
  }
  function metric(name, value, foot, cls) { return `<div class="metric-card"><div class="metric-label">${name}</div><div class="metric-value">${value}</div><div class="metric-foot ${cls}">${foot}</div></div>`; }
  function showError(error) { document.querySelector('#view-observability').innerHTML = `<div class="panel error-note">${escape(error.message)}</div>`; }
  window.observability = { load, render };
  document.addEventListener('DOMContentLoaded', () => load().catch(showError));
}());
