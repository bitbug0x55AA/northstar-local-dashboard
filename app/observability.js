(function () {
  const state = { tab: 'all', level: 'all', status: 'all', q: '', events: [], summary: { total: 0, openAlerts: 0, critical: 0, byTab: {} } };
  const tabs = [['all', 'Overview'], ['security', 'Security Audit'], ['debug', 'Debug'], ['application', 'Application Logs'], ['llm', 'Local LLM'], ['usage', 'Codex / Claude Usage'], ['alerts', 'Alerts']];
  const label = { security: 'Security Audit', debug: 'Debug', application: 'Application Logs', llm: 'Local LLM', usage: 'Codex / Claude Usage', alerts: 'Alerts' };
  const escape = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const when = value => new Date(value).toLocaleString(navigator.language || 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  async function load() {
    const params = new URLSearchParams({ tab: state.tab, level: state.level, status: state.status, q: state.q });
    const response = await fetch(`/api/observability?${params}`);
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'Unable to load observability data');
    state.events = data.events; state.summary = data.summary; render();
  }
  function eventRow(event) {
    const detail = Object.entries(event.details || {}).map(([key, value]) => `${escape(key)}: ${escape(value)}`).join(' · ');
    return `<div class="obs-event"><div class="obs-event-main"><div class="obs-event-top"><span class="obs-level ${event.level}">${escape(event.level)}</span><b>${escape(event.message)}</b></div><div class="obs-meta">${escape(label[event.tab] || event.tab)} · ${escape(event.source)} · ${escape(event.eventType)} · ${when(event.timestamp)}</div>${detail ? `<div class="obs-details">${detail}</div>` : ''}</div><div class="obs-event-actions"><span class="obs-status ${event.status}">${escape(event.status)}</span>${event.status !== 'resolved' ? `<button class="ghost-button obs-action" data-id="${escape(event.id)}" data-status="resolved">Resolve</button>` : ''}</div></div>`;
  }
  function render() {
    const summary = state.summary;
    document.querySelector('#view-observability').innerHTML = `<div class="page-heading"><div><div class="eyebrow">OPERATIONS TELEMETRY</div><h1>Logs & Audit</h1><p>按语义区分安全事件、调试信息、应用日志、本地 LLM 行为以及 Codex / Claude 用量。</p></div><button class="primary-button" id="obsRefresh">↻ Refresh</button></div><div class="metric-grid">${metric('Total Events', summary.total, 'Stored locally', '')}${metric('Open Alerts', summary.openAlerts, 'Needs attention', summary.openAlerts ? 'warn' : 'good')}${metric('Critical', summary.critical, 'Across all categories', summary.critical ? 'warn' : 'good')}</div><div class="filter-row obs-tabs">${tabs.map(([id, name]) => `<button class="filter ${state.tab === id ? 'active' : ''}" data-obs-tab="${id}">${name}${id !== 'all' && summary.byTab[id] ? ` <small>${summary.byTab[id]}</small>` : ''}</button>`).join('')}</div><div class="obs-toolbar"><input id="obsQuery" value="${escape(state.q)}" placeholder="Search source, event type, or message" /><select id="obsLevel"><option value="all">All levels</option><option value="debug">Debug</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option><option value="critical">Critical</option></select><select id="obsStatus"><option value="all">All statuses</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option><option value="ignored">Ignored</option></select></div><div class="panel obs-panel"><div class="panel-header"><div><div class="panel-title">${state.tab === 'all' ? 'Recent Activity' : escape(label[state.tab])}</div><div class="panel-subtitle">Sensitive values are redacted before persistence.</div></div></div><div class="obs-list">${state.events.map(eventRow).join('') || '<div class="empty">No events match these filters.</div>'}</div></div>`;
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
