(function () {
  const nav = document.querySelector('.planner-nav');
  const view = document.querySelector('#view-planner');
  if (!nav || !view) return;

  let data = { goals: [], projects: [], tasks: [], events: [], progressLogs: [] };
  let lastLanguage = document.documentElement.lang;
  const llmState = { configured: false, tested: false, ok: false, testing: false, model: null, latencyMs: null, result: null, error: null };

  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
  const isEnglish = () => document.documentElement.lang === 'en';
  const tr = (zh, en) => isEnglish() ? en : zh;
  const dateText = value => value ? new Date(value).toLocaleString(isEnglish() ? 'en-AU' : 'zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }) : tr('\u2014', '\u2014');
  const todayKey = () => new Date().toISOString().slice(0, 10);
  const statusText = status => ({ planned: tr('\u8ba1\u5212\u4e2d', 'Planned'), 'in-progress': tr('\u8fdb\u884c\u4e2d', 'In Progress'), done: tr('\u5df2\u5b8c\u6210', 'Done'), cancelled: tr('\u5df2\u53d6\u6d88', 'Cancelled') }[status] || status);
  const priorityText = priority => ({ high: tr('\u9ad8', 'High'), medium: tr('\u666e\u901a', 'Medium'), low: tr('\u4f4e', 'Low') }[priority] || priority);

  async function request(url, options) {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  function render() {
    const activeTasks = data.tasks.filter(task => task.status !== 'done' && task.status !== 'cancelled');
    const todayTasks = activeTasks.filter(task => task.dueAt && task.dueAt.slice(0, 10) === todayKey());
    const recentLogs = (data.progressLogs || []).slice(0, 6);
    view.innerHTML = `
      <div class="page-heading planner-heading">
        <div><div class="eyebrow">PERSONAL OPERATING SYSTEM</div><h1>${tr('\u4e2a\u4eba\u5de5\u4f5c\u8ba1\u5212', 'Personal Planner')}</h1><p>${tr('\u672c\u5730\u4efb\u52a1\u3001\u8fdb\u5ea6\u65e5\u5fd7\u548c\u53ef\u9009\u7684\u81ea\u7136\u8bed\u8a00\u6574\u7406\u5165\u53e3\u3002', 'Local tasks, progress logs, and an optional natural-language planning assistant.')}</p></div>
        <span class="source-pill"><i></i> LOCAL PLANNER</span>
      </div>
      <div class="metric-grid planner-metrics">
        <div class="metric-card"><div class="metric-label">${tr('\u4eca\u65e5\u4efb\u52a1', 'Today')}</div><div class="metric-value">${todayTasks.length}</div><div class="metric-foot good">${tr('\u6709\u660e\u786e\u65e5\u671f\u7684\u5f85\u529e', 'Tasks with a date')}</div></div>
        <div class="metric-card"><div class="metric-label">${tr('\u8fdb\u884c\u4e2d', 'In Progress')}</div><div class="metric-value">${data.tasks.filter(task => task.status === 'in-progress').length}</div><div class="metric-foot">${tr('\u5f53\u524d\u5de5\u4f5c\u7126\u70b9', 'Current work focus')}</div></div>
        <div class="metric-card"><div class="metric-label">${tr('\u5f85\u5904\u7406', 'Pending')}</div><div class="metric-value">${activeTasks.length}</div><div class="metric-foot">${tr('\u4e0d\u542b\u5df2\u5b8c\u6210\u4e8b\u9879', 'Excludes completed items')}</div></div>
        <div class="metric-card"><div class="metric-label">${tr('\u8fdb\u5ea6\u8bb0\u5f55', 'Progress Logs')}</div><div class="metric-value">${data.progressLogs.length}</div><div class="metric-foot">${tr('\u672c\u5730\u7ef4\u62a4', 'Stored locally')}</div></div>
      </div>
      <div class="planner-grid">
        <div>
          <div class="panel planner-input-panel">
            <div class="panel-header"><div><div class="panel-title">${tr('\u81ea\u7136\u8bed\u8a00\u66f4\u65b0', 'Natural-language update')}</div><div class="panel-subtitle">${llmState.configured ? tr('\u672c\u5730\u6a21\u578b\u5df2\u914d\u7f6e\uff1b\u89e3\u6790\u7ed3\u679c\u4ecd\u9700\u786e\u8ba4\u3002', 'Local model configured; proposed changes still require confirmation.') : tr('\u672c\u5730\u6a21\u578b\u5c1a\u672a\u914d\u7f6e\uff0c\u53ef\u5148\u4f7f\u7528\u624b\u52a8\u4efb\u52a1\u3002', 'Local model is not configured; manual tasks are still available.')}</div></div><span id="plannerLlmBadge" class="source-pill ${llmBadgeClass()}"><i></i>${llmBadgeText()}</span></div>
            <textarea id="plannerNaturalInput" placeholder="${tr('\u4f8b\u5982\uff1a\u4eca\u5929\u5b8c\u6210 CDSA \u590d\u4e60\uff0c\u660e\u5929\u665a\u4e0a\u5b89\u6392 OST2 \u5b66\u4e60\u4e24\u5c0f\u65f6', 'For example: Finish CDSA review today and schedule two hours of OST2 tomorrow evening')}"></textarea>
            <div class="planner-actions"><button class="primary-button" id="plannerInterpret" ${llmState.configured ? '' : 'disabled'}>${tr('\u89e3\u6790\u5e76\u9884\u89c8', 'Parse and preview')}</button><button class="ghost-button" id="plannerLlmTest" ${llmState.configured ? '' : 'disabled'}>${tr('\u6d4b\u8bd5\u672c\u5730 LLM', 'Test Local LLM')}</button><button class="ghost-button" id="plannerRefresh">${tr('\u5237\u65b0', 'Refresh')}</button></div>
            <div id="plannerLlmTestResult">${llmTestResultHtml()}</div><div id="plannerPreview"></div>
          </div>
          <div class="panel"><div class="panel-header"><div><div class="panel-title">${tr('\u5feb\u901f\u6dfb\u52a0\u4efb\u52a1', 'Quick add task')}</div><div class="panel-subtitle">${tr('\u5148\u5efa\u7acb\u53ef\u6267\u884c\u7684\u672c\u5730\u8ba1\u5212\u3002', 'Start with an actionable local plan.')}</div></div></div><div class="planner-form"><input id="plannerTaskTitle" placeholder="${tr('\u4efb\u52a1\u540d\u79f0', 'Task title')}" /><input id="plannerTaskDue" type="datetime-local" /><select id="plannerTaskPriority"><option value="medium">${tr('\u666e\u901a\u4f18\u5148\u7ea7', 'Medium priority')}</option><option value="high">${tr('\u9ad8\u4f18\u5148\u7ea7', 'High priority')}</option><option value="low">${tr('\u4f4e\u4f18\u5148\u7ea7', 'Low priority')}</option></select><button class="primary-button" id="plannerAddTask">${tr('\u6dfb\u52a0\u4efb\u52a1', 'Add task')}</button></div></div>
          <div class="panel"><div class="panel-header"><div><div class="panel-title">${tr('\u4efb\u52a1\u5217\u8868', 'Task list')}</div><div class="panel-subtitle">${tr('\u624b\u52a8\u521b\u5efa\u7684\u4efb\u52a1\u4e0e\u672a\u6765 LLM \u63d0\u6848\u5171\u7528\u540c\u4e00\u6570\u636e\u6a21\u578b\u3002', 'Manual tasks and future LLM proposals share one data model.')}</div></div></div><div id="plannerTasks">${renderTasks(activeTasks)}</div></div>
        </div>
        <div>
          <div class="panel"><div class="panel-header"><div><div class="panel-title">${tr('\u8fdb\u5ea6\u65e5\u5fd7', 'Progress log')}</div><div class="panel-subtitle">${tr('\u4fdd\u7559\u201c\u6211\u662f\u600e\u4e48\u8d70\u5230\u73b0\u5728\u7684\u201d\u3002', 'Keep a record of how you got here.')}</div></div></div><textarea id="plannerLogInput" class="planner-log-input" placeholder="${tr('\u8bb0\u5f55\u4eca\u5929\u5b8c\u6210\u4e86\u4ec0\u4e48...', 'What did you complete today?...')}"></textarea><button class="ghost-button planner-log-button" id="plannerAddLog">${tr('\u8bb0\u5f55\u8fdb\u5ea6', 'Log progress')}</button><div class="planner-log-list">${recentLogs.map(log => `<div class="planner-log"><span>${dateText(log.occurredAt)}</span><b>${escapeHtml(log.content)}</b></div>`).join('') || `<div class="empty">${tr('\u6682\u65e0\u8fdb\u5ea6\u8bb0\u5f55', 'No progress logs')}</div>`}</div></div>
          <div class="panel"><div class="panel-header"><div><div class="panel-title">${tr('\u8fd1\u671f\u65e5\u7a0b', 'Upcoming events')}</div><div class="panel-subtitle">${tr('\u56fa\u5b9a\u65f6\u95f4\u4e8b\u9879\u6682\u65f6\u72ec\u7acb\u4e8e\u4efb\u52a1\u3002', 'Fixed-time items are separate from tasks for now.')}</div></div></div><div id="plannerEvents">${renderEvents()}</div></div>
        </div>
      </div>`;
    bind();
  }

  function renderTasks(tasks) {
    if (!tasks.length) return `<div class="empty">${tr('\u6682\u65e0\u5f85\u5904\u7406\u4efb\u52a1', 'No pending tasks')}</div>`;
    return tasks.map(task => `<div class="planner-task"><div class="planner-task-main"><b>${escapeHtml(task.title)}</b><small>${task.dueAt ? `${tr('\u622a\u6b62', 'Due')} ${dateText(task.dueAt)}` : tr('\u672a\u8bbe\u7f6e\u622a\u6b62\u65f6\u95f4', 'No due date')} Â· ${statusText(task.status)}</small></div><span class="planner-priority ${task.priority}">${priorityText(task.priority)}</span><button class="text-button planner-complete" data-id="${task.id}">${tr('\u5b8c\u6210', 'Complete')}</button></div>`).join('');
  }

  function renderEvents() {
    const events = [...data.events].sort((a, b) => new Date(a.startAt) - new Date(b.startAt)).slice(0, 6);
    return events.length ? events.map(event => `<div class="planner-event"><span>${dateText(event.startAt)}</span><b>${escapeHtml(event.title)}</b></div>`).join('') : `<div class="empty">${tr('\u6682\u65e0\u56fa\u5b9a\u65e5\u7a0b', 'No scheduled events')}</div>`;
  }

  function llmBadgeText() {
    if (!llmState.configured) return tr('\u624b\u52a8\u6a21\u5f0f', 'MANUAL MODE');
    if (!llmState.tested) return tr('LLM \u672a\u6d4b\u8bd5', 'LLM UNTESTED');
    return llmState.ok ? tr('LLM \u5df2\u8fde\u63a5', 'LLM CONNECTED') : tr('LLM \u9519\u8bef', 'LLM ERROR');
  }

  function llmBadgeClass() { return !llmState.configured || (llmState.tested && !llmState.ok) ? 'warn' : ''; }

  function llmTestResultHtml() {
    if (!llmState.tested) return `<div class="planner-llm-result muted">${tr('\u5c1a\u672a\u6267\u884c\u8fde\u63a5\u6d4b\u8bd5\u3002', 'Connection test has not run yet.')}</div>`;
    if (!llmState.ok) return `<div class="planner-llm-result failure"><b>${tr('LLM \u6d4b\u8bd5\u5931\u8d25', 'LLM test failed')}</b><small>${escapeHtml(llmState.error || tr('\u672a\u77e5\u9519\u8bef', 'Unknown error'))}</small></div>`;
    return `<div class="planner-llm-result success"><b>${tr('LLM \u5df2\u6210\u529f\u63a5\u5165', 'LLM connected successfully')}</b><small>${tr('\u6a21\u578b', 'Model')}: ${escapeHtml(llmState.model || 'unknown')} Â· ${tr('\u5ef6\u8fdf', 'Latency')}: ${llmState.latencyMs ?? tr('\u2014', '\u2014')}ms</small><pre>${escapeHtml(JSON.stringify(llmState.result?.operations || [], null, 2))}</pre></div>`;
  }

  function updateLlmTestUi() {
    const badge = document.querySelector('#plannerLlmBadge');
    const result = document.querySelector('#plannerLlmTestResult');
    const testButton = document.querySelector('#plannerLlmTest');
    if (badge) { badge.className = `source-pill ${llmBadgeClass()}`; badge.innerHTML = `<i></i>${llmBadgeText()}`; }
    if (result) result.innerHTML = llmState.testing ? `<div class="planner-llm-result muted">${tr('\u6b63\u5728\u8c03\u7528\u672c\u5730\u6a21\u578b\u6d4b\u8bd5...', 'Testing the local model...')}</div>` : llmTestResultHtml();
    if (testButton) { testButton.disabled = !llmState.configured || llmState.testing; testButton.textContent = llmState.testing ? tr('\u6d4b\u8bd5\u4e2d...', 'Testing...') : tr('\u6d4b\u8bd5\u672c\u5730 LLM', 'Test Local LLM'); }
  }

  async function apply(operations, confirmed = false) {
    const result = await request('/api/planner/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operations, confirmed }) });
    data = result.data;
    render();
  }

  function bind() {
    document.querySelector('#plannerRefresh')?.addEventListener('click', load);
    document.querySelector('#plannerAddTask')?.addEventListener('click', async () => {
      const title = document.querySelector('#plannerTaskTitle').value.trim();
      if (!title) return;
      try { await apply([{ type: 'create_task', title, dueAt: document.querySelector('#plannerTaskDue').value || null, priority: document.querySelector('#plannerTaskPriority').value }]); } catch (error) { showError(error.message); }
    });
    document.querySelector('#plannerAddLog')?.addEventListener('click', async () => {
      const input = document.querySelector('#plannerLogInput');
      if (!input.value.trim()) return;
      try { await apply([{ type: 'log_progress', content: input.value.trim() }]); } catch (error) { showError(error.message); }
    });
    document.querySelectorAll('.planner-complete').forEach(button => button.addEventListener('click', async () => {
      try { await apply([{ type: 'update_task', id: button.dataset.id, status: 'done' }]); } catch (error) { showError(error.message); }
    }));
    document.querySelector('#plannerInterpret')?.addEventListener('click', interpret);
    document.querySelector('#plannerLlmTest')?.addEventListener('click', testLlm);
  }

  async function testLlm() {
    if (!llmState.configured || llmState.testing) return;
    llmState.testing = true;
    updateLlmTestUi();
    try {
      const result = await request('/api/planner/llm-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      llmState.tested = true; llmState.ok = true; llmState.model = result.model; llmState.latencyMs = result.latencyMs; llmState.result = result.result; llmState.error = null;
    } catch (error) {
      llmState.tested = true; llmState.ok = false; llmState.error = error.message;
    } finally { llmState.testing = false; updateLlmTestUi(); }
  }

  async function interpret() {
    const input = document.querySelector('#plannerNaturalInput').value.trim();
    if (!input) return;
    const preview = document.querySelector('#plannerPreview');
    preview.innerHTML = `<div class="planner-preview">${tr('\u6b63\u5728\u8bf7\u6c42\u672c\u5730\u6a21\u578b...', 'Requesting the local model...')}</div>`;
    try {
      const result = await request('/api/planner/interpret', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
      const clarification = result.clarification ? `<div class="planner-clarification">${escapeHtml(result.clarification)}</div>` : '';
      const confirm = result.operations.length ? `<button class="primary-button" id="plannerConfirm">${tr('\u786e\u8ba4\u5199\u5165', 'Confirm and save')}</button>` : '';
      preview.innerHTML = `<div class="planner-preview"><b>${tr('\u89e3\u6790\u7ed3\u679c', 'Parsed result')}</b>${clarification}<pre>${escapeHtml(JSON.stringify(result.operations, null, 2))}</pre>${confirm}<button class="ghost-button" id="plannerCancel">${tr('\u53d6\u6d88', 'Cancel')}</button></div>`;
      document.querySelector('#plannerConfirm')?.addEventListener('click', async () => { try { await apply(result.operations, true); } catch (error) { showError(error.message); } });
      document.querySelector('#plannerCancel').addEventListener('click', () => { preview.innerHTML = ''; });
    } catch (error) { showError(error.message); }
  }

  function showError(message) {
    const preview = document.querySelector('#plannerPreview');
    if (preview) preview.innerHTML = `<div class="error-note">${tr('\u64cd\u4f5c\u5931\u8d25\uff1a', 'Operation failed: ')}${escapeHtml(message)}</div>`;
  }

  async function load() {
    try { data = await request('/api/planner'); render(); } catch (error) { view.innerHTML = `<div class="panel error-note">${tr('Planner \u65e0\u6cd5\u52a0\u8f7d\uff1a', 'Planner could not load: ')}${escapeHtml(error.message)}</div>`; }
  }

  function keepNavigationLabel() {
    if (!nav || nav.hidden) return;
    const navLabel = tr('\u4e2a\u4eba\u8ba1\u5212', 'Personal Planner');
    if (nav.lastChild && nav.lastChild.textContent !== navLabel) nav.lastChild.textContent = navLabel;
    const pageTitle = document.querySelector('#pageTitle');
    const title = tr('\u4e2a\u4eba\u5de5\u4f5c\u8ba1\u5212', 'Personal Planner');
    if (pageTitle && view.classList.contains('active-view') && pageTitle.textContent !== title) pageTitle.textContent = title;
  }

  async function initialize() {
    try {
      const status = await request('/api/planner/status');
      if (!status.enabled) { nav.hidden = true; return; }
      llmState.configured = status.llmConfigured;
      nav.hidden = false;
      keepNavigationLabel();
      const navObserver = new MutationObserver(keepNavigationLabel);
      navObserver.observe(nav, { childList: true, subtree: true, characterData: true });
      const languageObserver = new MutationObserver(() => {
        keepNavigationLabel();
        if (document.documentElement.lang !== lastLanguage) { lastLanguage = document.documentElement.lang; render(); }
      });
      languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
      nav.addEventListener('click', () => setTimeout(keepNavigationLabel, 0));
      await load();
    } catch (error) { nav.hidden = true; console.warn('Planner is unavailable:', error.message); }
  }

  initialize();
}());
