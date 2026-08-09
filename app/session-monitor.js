(() => {
  const compact = value => value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}K` : String(value || 0);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  function render(usage) {
    const host = document.querySelector('#view-usage');
    if (!host || host.querySelector('.session-window-panel')) return;
    const sessions = usage.sessionWindows || [], alerts = sessions.filter(session => session.needsAttention);
    const rows = sessions.map(session => { const known = Number.isFinite(session.contextWindow) && session.contextWindow > 0, usageText = known ? `${session.usedPercent}%` : 'No window reported', capacity = known ? `${compact(session.contextTokens)} / ${compact(session.contextWindow)} · ${compact(session.remainingTokens)} left` : 'No context capacity reported, so no alert', status = session.needsAttention ? 'Consider compacting or starting a new session' : 'Enough room'; return `<div class="session-window-row ${session.needsAttention ? 'attention' : ''}"><div class="session-window-main"><b>${escape(session.title || `Session ${session.shortId}`)}</b><small>${escape(session.provider || '')} · ${escape(session.model || 'Unknown model')} · ID ${escape(session.shortId || '—')}</small></div><div class="session-window-capacity"><b>${usageText}</b><small>${capacity}</small></div><span class="session-window-status ${session.needsAttention ? 'warn' : 'good'}">${status}</span></div>`; }).join('') || '<div class="empty">No identifiable sessions found in local logs yet.</div>';
    host.insertAdjacentHTML('afterbegin', `<div class="panel session-window-panel"><div class="panel-header"><div><div class="panel-title">Session Context Monitor</div><div class="panel-subtitle">Alerts only when a reported context window is ≥90% used and ≤16K tokens remain; one large prompt alone will not trigger one.</div></div><span class="source-pill ${alerts.length ? 'warn' : ''}"><i></i>${alerts.length ? `${alerts.length} need attention` : 'No action needed'}</span></div><div class="session-window-list">${rows}</div></div>`);
  }
  let requested = false;
  function load() { if (requested || !document.querySelector('#view-usage.active-view')) return; requested = true; fetch('/api/usage').then(response => response.ok ? response.json() : null).then(usage => usage && render(usage)).finally(() => { requested = false; }); }
  new MutationObserver(load).observe(document.querySelector('#view-usage'), { childList: true });
  load();
})();
