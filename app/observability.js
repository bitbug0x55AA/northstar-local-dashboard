(function () {
  const state = { tab: 'all', level: 'all', status: 'all', q: '', events: [], summary: { total: 0, openAlerts: 0, critical: 0, byTab: {} } };
  const tr = (zh, en) => document.documentElement.lang === 'en' ? en : zh;
  const tabDefinitions = [
    ['all', '总览', 'Overview'], ['security', '安全审计', 'Security Audit'], ['debug', '调试', 'Debug'],
    ['application', '应用日志', 'Application Logs'], ['llm', '本地 LLM', 'Local LLM'],
    ['usage', 'Codex / Claude 用量', 'Codex / Claude Usage'], ['alerts', '告警', 'Alerts']
  ];
  const copy = pair => ({ title: tr(pair.title[0], pair.title[1]), meaning: tr(pair.meaning[0], pair.meaning[1]), action: tr(pair.action[0], pair.action[1]) });
  const ruleDocs = {
    'USAGE-QUOTA-50': { title: ['Codex / Claude 用量达到 50%', 'Codex / Claude quota at 50%'], meaning: ['本地用量导入器发现托管编码助手已使用至少一半的可见额度窗口。这是容量预警，不是安全事件或本地 LLM 故障。', 'The local usage importer found that a hosted coding assistant has consumed at least half of its observed quota window. This is an early capacity warning, not a security incident or a local LLM failure.'], action: ['留意重置时间；若预计有重度工作，请避免不必要的长会话。', 'Keep the reset time in mind and avoid unnecessary long sessions if you expect heavier work.'] },
    'USAGE-QUOTA-80': { title: ['Codex / Claude 用量达到 80%', 'Codex / Claude quota at 80%'], meaning: ['托管编码助手已使用至少 80% 的可见额度窗口。这是容量预警，不是安全事件或本地 LLM 故障。', 'The local usage importer found that a hosted coding assistant has consumed at least 80% of its observed quota window. This is a capacity warning, not a security incident and not a local LLM failure.'], action: ['检查重置时间，减少非必要的长会话，或等待服务商窗口重置。', 'Review the reset time, reduce non-essential long sessions, or wait for the provider window to reset.'] },
    'USAGE-QUOTA-90': { title: ['Codex / Claude 用量达到 90%', 'Codex / Claude quota at 90%'], meaning: ['托管编码助手已接近可见额度上限。长任务在重置前可能会被限流、延迟或不可用。', 'The hosted coding assistant is close to its observed quota limit. Long tasks may be throttled, delayed, or unavailable until reset.'], action: ['保存工作，避免大型探索性运行，并在继续前检查服务商重置时间。', 'Save work, avoid large exploratory runs, and check the provider reset time before continuing.'] },
    'USAGE-QUOTA-95': { title: ['Codex / Claude 用量达到 95%', 'Codex / Claude quota at 95%'], meaning: ['托管编码助手已接近可见额度上限。长任务在重置前可能会被限流、延迟或不可用。', 'The hosted coding assistant is close to its observed quota limit. Long tasks may be throttled, delayed, or unavailable until reset.'], action: ['保存工作，避免大型探索性运行，并在继续前检查服务商重置时间。', 'Save work, avoid large exploratory runs, and check the provider reset time before continuing.'] },
    'LLM-DENY-001': { title: ['已阻止本地 LLM 操作', 'Local LLM operation blocked'], meaning: ['本地模型提出的操作不符合计划器安全策略。', 'The local model proposed an operation that the Planner safety policy does not permit.'], action: ['检查该操作；除非能建立安全、明确的替代方案，否则保持阻止状态。', 'Review the proposed operation and keep it blocked unless you can establish a safe, explicit alternative.'] }
  };
  const genericDocs = {
    warning: { title: ['警告', 'Warning'], meaning: ['系统检测到异常或潜在风险情况，但不一定已经造成损害。', 'The system detected an unusual or potentially risky condition. It has not necessarily caused damage.'], action: ['查看事件详情，并决定是否确认、解决或调查。', 'Review the event details and decide whether to acknowledge, resolve, or investigate it.'] },
    error: { title: ['错误', 'Error'], meaning: ['Northstar 操作失败或返回不可用结果，可能影响相关数据的新鲜度或可靠性。', 'A Northstar operation failed or returned an unusable result. This may affect freshness or reliability of the related data.'], action: ['检查来源和事件类型，重试操作；如重复发生，请查看调试日志。', 'Check the source and event type, retry the operation, and inspect Debug logs if it repeats.'] },
    critical: { title: ['严重事件', 'Critical event'], meaning: ['检测到高影响情况，应立即审查。', 'A high-impact condition was detected and should be treated as requiring immediate review.'], action: ['停止受影响的工作流，保留事件详情，并在重试前完成调查。', 'Stop the affected workflow, preserve the event details, and investigate before retrying.'] }
  };
  const escape = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  const when = value => new Date(value).toLocaleString(document.documentElement.lang === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const labelFor = tab => { const item = tabDefinitions.find(([id]) => id === tab); return item ? tr(item[1], item[2]) : tab; };
  const levelFor = level => ({ debug: tr('调试', 'Debug'), info: tr('信息', 'Info'), warning: tr('警告', 'Warning'), error: tr('错误', 'Error'), critical: tr('严重', 'Critical') }[level] || level);
  const statusFor = status => ({ open: tr('未处理', 'Open'), acknowledged: tr('已确认', 'Acknowledged'), resolved: tr('已解决', 'Resolved'), ignored: tr('已忽略', 'Ignored') }[status] || status);

  async function load() {
    const params = new URLSearchParams({ tab: state.tab, level: state.level, status: state.status, q: state.q });
    const response = await fetch(`/api/observability?${params}`);
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : { error: tr(`日志与审计 API 返回 ${response.status} ${response.statusText}。请重启当前分支上的 Northstar 服务。`, `Observability API returned ${response.status} ${response.statusText}. Restart the Northstar server on the current branch.`) };
    if (!response.ok || data.error) throw new Error(data.error || tr('无法读取日志与审计数据', 'Unable to load observability data'));
    state.events = data.events; state.summary = data.summary; render();
  }

  function eventRow(event) {
    const detail = Object.entries(event.details || {}).map(([key, value]) => `${escape(key)}: ${escape(value)}`).join(' · ');
    const explanation = event.ruleId ? ruleDocs[event.ruleId] : genericDocs[event.level];
    const guide = explanation && event.level !== 'info' && event.level !== 'debug' ? copy(explanation) : null;
    const explainHtml = guide ? `<div class="obs-explanation"><b>${tr('含义', 'What this means')}</b><span>${escape(guide.meaning)}</span><b>${tr('建议操作', 'Recommended action')}</b><span>${escape(guide.action)}</span></div>` : '';
    return `<div class="obs-event"><div class="obs-event-main"><div class="obs-event-top"><span class="obs-level ${event.level}">${escape(levelFor(event.level))}</span><b>${escape(event.message)}</b></div><div class="obs-meta">${escape(labelFor(event.tab))} · ${escape(event.source)} · ${escape(event.eventType)} · ${when(event.timestamp)}</div>${detail ? `<div class="obs-details">${detail}</div>` : ''}${explainHtml}</div><div class="obs-event-actions"><span class="obs-status ${event.status}">${escape(statusFor(event.status))}</span>${event.status !== 'resolved' ? `<button class="ghost-button obs-action" data-id="${escape(event.id)}" data-status="resolved">${tr('解决', 'Resolve')}</button>` : ''}</div></div>`;
  }

  function metric(name, value, foot, cls) { return `<div class="metric-card"><div class="metric-label">${name}</div><div class="metric-value">${value}</div><div class="metric-foot ${cls}">${foot}</div></div>`; }
  function render() {
    const summary = state.summary;
    const tabs = tabDefinitions.map(([id, zh, en]) => [id, tr(zh, en)]);
    document.querySelector('#view-observability').innerHTML = `<div class="page-heading"><div><div class="eyebrow">${tr('运行遥测', 'OPERATIONS TELEMETRY')}</div><h1>${tr('日志与审计', 'Logs & Audit')}</h1><p>${tr('按语义区分安全事件、调试信息、应用日志、本地 LLM 行为以及 Codex / Claude 用量。', 'Separate security events, debugging information, application logs, local LLM behavior, and Codex / Claude usage by meaning.')}</p></div><button class="primary-button" id="obsRefresh">↻ ${tr('刷新', 'Refresh')}</button></div><div class="metric-grid">${metric(tr('事件总数', 'Total Events'), summary.total, tr('仅本地存储', 'Stored locally'), '')}${metric(tr('未处理告警', 'Open Alerts'), summary.openAlerts, tr('需要关注', 'Needs attention'), summary.openAlerts ? 'warn' : 'good')}${metric(tr('严重事件', 'Critical'), summary.critical, tr('跨所有类别', 'Across all categories'), summary.critical ? 'warn' : 'good')}</div><div class="panel obs-guide"><div class="panel-title">${tr('如何阅读这些日志', 'How to read these logs')}</div><div class="obs-guide-grid"><div><b>${tr('警告', 'warning')}</b><span>${tr('需要审查；这不自动代表数据丢失或遭到入侵。', 'Needs review; it does not automatically mean data loss or compromise.')}</span></div><div><b>${tr('错误', 'error')}</b><span>${tr('一次操作失败，可能影响可靠性或数据新鲜度。', 'An operation failed and may affect reliability or data freshness.')}</span></div><div><b>${tr('严重', 'critical')}</b><span>${tr('高影响情况；请暂停相关工作流并调查。', 'High-impact condition; pause the affected workflow and investigate.')}</span></div><div><b>${tr('用量与本地 LLM', 'Usage vs Local LLM')}</b><span>${tr('Codex / Claude 标签描述托管额度用量；本地 LLM 标签描述 Ollama 行为和策略边界。', 'Codex / Claude tabs describe hosted quota usage. Local LLM tabs describe Ollama behavior and policy boundaries.')}</span></div></div></div><div class="filter-row obs-tabs">${tabs.map(([id, name]) => `<button class="filter ${state.tab === id ? 'active' : ''}" data-obs-tab="${id}">${name}${id !== 'all' && summary.byTab[id] ? ` <small>${summary.byTab[id]}</small>` : ''}</button>`).join('')}</div><div class="obs-toolbar"><input id="obsQuery" value="${escape(state.q)}" placeholder="${tr('搜索来源、事件类型或消息', 'Search source, event type, or message')}" /><select id="obsLevel"><option value="all">${tr('全部等级', 'All levels')}</option><option value="debug">${tr('调试', 'Debug')}</option><option value="info">${tr('信息', 'Info')}</option><option value="warning">${tr('警告', 'Warning')}</option><option value="error">${tr('错误', 'Error')}</option><option value="critical">${tr('严重', 'Critical')}</option></select><select id="obsStatus"><option value="all">${tr('全部状态', 'All statuses')}</option><option value="open">${tr('未处理', 'Open')}</option><option value="acknowledged">${tr('已确认', 'Acknowledged')}</option><option value="resolved">${tr('已解决', 'Resolved')}</option><option value="ignored">${tr('已忽略', 'Ignored')}</option></select></div><div class="panel obs-panel"><div class="panel-header"><div><div class="panel-title">${state.tab === 'all' ? tr('最近活动', 'Recent Activity') : escape(labelFor(state.tab))}</div><div class="panel-subtitle">${tr('敏感值会在持久化前脱敏。', 'Sensitive values are redacted before persistence.')}</div></div></div><div class="obs-list">${state.events.map(eventRow).join('') || `<div class="empty">${tr('没有事件符合这些筛选条件。', 'No events match these filters.')}</div>`}</div></div>`;
    const level = document.querySelector('#obsLevel'); level.value = state.level;
    const status = document.querySelector('#obsStatus'); status.value = state.status;
    document.querySelectorAll('[data-obs-tab]').forEach(button => button.addEventListener('click', () => { state.tab = button.dataset.obsTab; load().catch(showError); }));
    document.querySelector('#obsRefresh').addEventListener('click', () => load().catch(showError));
    document.querySelector('#obsLevel').addEventListener('change', event => { state.level = event.target.value; load().catch(showError); });
    document.querySelector('#obsStatus').addEventListener('change', event => { state.status = event.target.value; load().catch(showError); });
    document.querySelector('#obsQuery').addEventListener('change', event => { state.q = event.target.value.trim(); load().catch(showError); });
    document.querySelectorAll('.obs-action').forEach(button => button.addEventListener('click', async () => { await fetch('/api/observability/events', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: button.dataset.id, status: button.dataset.status }) }); load().catch(showError); }));
  }
  function showError(error) { document.querySelector('#view-observability').innerHTML = `<div class="panel error-note">${escape(error.message)}</div>`; }
  window.observability = { load, render };
  document.addEventListener('DOMContentLoaded', () => load().catch(showError));
}());
