(function () {
  const nav = document.querySelector('.planner-nav');
  const view = document.querySelector('#view-planner');
  if (!nav || !view) return;

  let data = { goals: [], projects: [], tasks: [], events: [], progressLogs: [] };
  let llmConfigured = false;

  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
  const dateText = value => value ? new Date(value).toLocaleString(document.documentElement.lang === 'en' ? 'en-AU' : 'zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }) : '—';
  const todayKey = () => new Date().toISOString().slice(0, 10);
  const statusText = status => ({ planned: '计划中', 'in-progress': '进行中', done: '已完成', cancelled: '已取消' }[status] || status);

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
        <div><div class="eyebrow">PERSONAL OPERATING SYSTEM</div><h1>个人工作计划</h1><p>本地任务、进度日志和可选的自然语言整理入口。</p></div>
        <span class="source-pill"><i></i> LOCAL PLANNER</span>
      </div>
      <div class="metric-grid planner-metrics">
        <div class="metric-card"><div class="metric-label">今日任务</div><div class="metric-value">${todayTasks.length}</div><div class="metric-foot good">有明确日期的待办</div></div>
        <div class="metric-card"><div class="metric-label">进行中</div><div class="metric-value">${data.tasks.filter(task => task.status === 'in-progress').length}</div><div class="metric-foot">当前工作焦点</div></div>
        <div class="metric-card"><div class="metric-label">待处理</div><div class="metric-value">${activeTasks.length}</div><div class="metric-foot">不含已完成事项</div></div>
        <div class="metric-card"><div class="metric-label">进度记录</div><div class="metric-value">${data.progressLogs.length}</div><div class="metric-foot">本地维护</div></div>
      </div>
      <div class="planner-grid">
        <div>
          <div class="panel planner-input-panel">
            <div class="panel-header"><div><div class="panel-title">自然语言更新</div><div class="panel-subtitle">${llmConfigured ? '本地模型已配置；解析结果仍需确认。' : '本地模型尚未配置，可先使用手动任务。'}</div></div><span class="source-pill ${llmConfigured ? '' : 'warn'}"><i></i>${llmConfigured ? 'LLM READY' : 'MANUAL MODE'}</span></div>
            <textarea id="plannerNaturalInput" placeholder="例如：今天完成 CDSA 复习，明天晚上安排 OST2 学习两小时"></textarea>
            <div class="planner-actions"><button class="primary-button" id="plannerInterpret" ${llmConfigured ? '' : 'disabled'}>解析并预览</button><button class="ghost-button" id="plannerRefresh">刷新</button></div>
            <div id="plannerPreview"></div>
          </div>
          <div class="panel">
            <div class="panel-header"><div><div class="panel-title">快速添加任务</div><div class="panel-subtitle">先建立可执行的本地计划。</div></div></div>
            <div class="planner-form"><input id="plannerTaskTitle" placeholder="任务名称" /><input id="plannerTaskDue" type="datetime-local" /><select id="plannerTaskPriority"><option value="medium">普通优先级</option><option value="high">高优先级</option><option value="low">低优先级</option></select><button class="primary-button" id="plannerAddTask">添加任务</button></div>
          </div>
          <div class="panel"><div class="panel-header"><div><div class="panel-title">任务列表</div><div class="panel-subtitle">手动创建的任务与未来 LLM 提案共用同一数据模型。</div></div></div><div id="plannerTasks">${renderTasks(activeTasks)}</div></div>
        </div>
        <div>
          <div class="panel"><div class="panel-header"><div><div class="panel-title">进度日志</div><div class="panel-subtitle">保留“我是怎么走到现在的”。</div></div></div><textarea id="plannerLogInput" class="planner-log-input" placeholder="记录今天完成了什么..."></textarea><button class="ghost-button planner-log-button" id="plannerAddLog">记录进度</button><div class="planner-log-list">${recentLogs.map(log => `<div class="planner-log"><span>${dateText(log.occurredAt)}</span><b>${escapeHtml(log.content)}</b></div>`).join('') || '<div class="empty">暂无进度记录</div>'}</div></div>
          <div class="panel"><div class="panel-header"><div><div class="panel-title">近期日程</div><div class="panel-subtitle">固定时间事项暂时独立于任务。</div></div></div><div id="plannerEvents">${renderEvents()}</div></div>
        </div>
      </div>`;
    bind();
  }

  function renderTasks(tasks) {
    if (!tasks.length) return '<div class="empty">暂无待处理任务</div>';
    return tasks.map(task => `<div class="planner-task"><div class="planner-task-main"><b>${escapeHtml(task.title)}</b><small>${task.dueAt ? `截止 ${dateText(task.dueAt)}` : '未设置截止时间'} · ${statusText(task.status)}</small></div><span class="planner-priority ${task.priority}">${task.priority}</span><button class="text-button planner-complete" data-id="${task.id}">完成</button></div>`).join('');
  }

  function renderEvents() {
    const events = [...data.events].sort((a, b) => new Date(a.startAt) - new Date(b.startAt)).slice(0, 6);
    return events.length ? events.map(event => `<div class="planner-event"><span>${dateText(event.startAt)}</span><b>${escapeHtml(event.title)}</b></div>`).join('') : '<div class="empty">暂无固定日程</div>';
  }

  async function apply(operations) {
    const result = await request('/api/planner/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operations }) });
    data = result.data;
    render();
  }

  function bind() {
    document.querySelector('#plannerRefresh')?.addEventListener('click', load);
    document.querySelector('#plannerAddTask')?.addEventListener('click', async () => {
      const title = document.querySelector('#plannerTaskTitle').value.trim();
      if (!title) return;
      try {
        await apply([{ type: 'create_task', title, dueAt: document.querySelector('#plannerTaskDue').value || null, priority: document.querySelector('#plannerTaskPriority').value }]);
      } catch (error) { showError(error.message); }
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
  }

  async function interpret() {
    const input = document.querySelector('#plannerNaturalInput').value.trim();
    if (!input) return;
    const preview = document.querySelector('#plannerPreview');
    preview.innerHTML = '<div class="planner-preview">正在请求本地模型...</div>';
    try {
      const result = await request('/api/planner/interpret', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
      preview.innerHTML = `<div class="planner-preview"><b>解析结果</b><pre>${escapeHtml(JSON.stringify(result.operations, null, 2))}</pre><button class="primary-button" id="plannerConfirm">确认写入</button><button class="ghost-button" id="plannerCancel">取消</button></div>`;
      document.querySelector('#plannerConfirm').addEventListener('click', async () => { try { await apply(result.operations); } catch (error) { showError(error.message); } });
      document.querySelector('#plannerCancel').addEventListener('click', () => { preview.innerHTML = ''; });
    } catch (error) { showError(error.message); }
  }

  function showError(message) {
    const preview = document.querySelector('#plannerPreview');
    if (preview) preview.innerHTML = `<div class="error-note">${escapeHtml(message)}</div>`;
  }

  async function load() {
    try { data = await request('/api/planner'); render(); } catch (error) { view.innerHTML = `<div class="panel error-note">Planner 无法加载：${escapeHtml(error.message)}</div>`; }
  }

  async function initialize() {
    try {
      const status = await request('/api/planner/status');
      if (!status.enabled) return;
      llmConfigured = status.llmConfigured;
      nav.hidden = false;
      nav.lastChild.textContent = 'Personal Planner';
      nav.addEventListener('click', () => {
        setTimeout(() => {
          nav.lastChild.textContent = 'Personal Planner';
          const pageTitle = document.querySelector('#pageTitle');
          if (pageTitle) pageTitle.textContent = '个人工作计划';
        }, 0);
        load();
      });
      await load();
    } catch (error) {
      nav.hidden = true;
      console.warn('Planner is unavailable:', error.message);
    }
  }

  initialize();
}());
