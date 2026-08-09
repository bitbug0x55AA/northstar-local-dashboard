(function () {
  const shared = window.NorthstarPlannerShared;
  const nav = document.querySelector('.planner-nav');
  const view = document.querySelector('#view-planner');
  const sideNav = document.querySelector('[data-planner-subnav]');
  if (!nav || !view || !sideNav) return;

  const state = {
    data: { goals: [], projects: [], tasks: [], events: [], progressLogs: [], categories: shared.DEFAULT_CATEGORIES, performance: { goals: [], controls: [], initiatives: [], evidence: [], checkpoints: [] } },
    activePage: 'overview', editingTaskId: null, draftCategory: null,
    llm: { configured: false, tested: false, ok: false, testing: false, model: null, latencyMs: null, error: null }
  };
  const storageKey = 'northstar.plannerSubpage';
  const categories = () => [...new Set([...shared.DEFAULT_CATEGORIES, ...(state.data.categories || []), ...state.data.tasks.map(task => task.category).filter(Boolean)])];
  const tasksFor = category => (category ? state.data.tasks.filter(task => task.category === category && task.status !== 'cancelled') : state.data.tasks.filter(task => task.status !== 'cancelled'));
  const navigation = window.NorthstarPlannerNavigation.createNavigation(nav, sideNav, () => state, categories, tasksFor);

  async function apply(operations, confirmed = false) { const result = await shared.request('/api/planner/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operations, confirmed }) }); state.data = result.data; render(); }
  function showError(message) { const preview = document.querySelector('#plannerPreview'); if (preview) preview.innerHTML = `<div class="error-note">${shared.tr('操作失败：', 'Operation failed: ')}${shared.escapeHtml(message)}</div>`; }
  function pageContent() { const category = shared.categoryFromPage(state.activePage); if (state.activePage === 'overview') return window.NorthstarPlannerTasks.renderOverview(state.data, categories(), tasksFor); if (state.activePage === 'add') return `<div class="planner-grid planner-input-grid">${window.NorthstarPlannerTasks.renderAddPage(state.data, state, categories())}${window.NorthstarPlannerLlm.render(state.llm)}</div>`; if (category === shared.WORK_PERFORMANCE_CATEGORY) return window.NorthstarPlannerPerformance.render(state.data); return window.NorthstarPlannerTasks.renderCategory(category, tasksFor); }
  function render() {
    const currentCategory = shared.categoryFromPage(state.activePage);
    if (state.activePage !== 'overview' && state.activePage !== 'add' && !categories().includes(currentCategory)) state.activePage = 'overview';
    localStorage.setItem(storageKey, state.activePage);
    navigation.render();
    const githubCount = state.data.tasks.filter(task => task.source === 'github').length;
    view.innerHTML = `<div class="page-heading planner-heading"><div><div class="eyebrow">PERSONAL OPERATING SYSTEM</div><h1>${shared.tr('个人计划', 'Personal Planner')}</h1><p>${shared.tr('为每一个重点方向提供独立页面，导航位于左侧栏。', 'Dedicated pages for each important direction, navigated from the left sidebar.')}</p></div><span class="source-pill"><i></i>${githubCount ? `GITHUB LINKED · ${githubCount}` : 'LOCAL PLANNER'}</span></div><div class="planner-page-content">${pageContent()}</div>`;
    window.NorthstarPlannerTasks.bind(state.data, state, apply, render, showError);
    window.NorthstarPlannerPerformance.bind(apply, showError);
    window.NorthstarPlannerLlm.bind(state.llm, apply, showError);
  }
  function keepNavigationLabel() { const label = shared.tr('个人计划', 'Personal Planner'); if (nav.lastChild) nav.lastChild.textContent = label; const title = document.querySelector('#pageTitle'); if (title && view.classList.contains('active-view')) title.textContent = label; }
  async function load() { try { state.data = await shared.request('/api/planner'); render(); } catch (error) { view.innerHTML = `<div class="panel error-note">${shared.tr('Planner 无法加载：', 'Planner could not load: ')}${shared.escapeHtml(error.message)}</div>`; } }
  async function initialize() {
    try {
      const status = await shared.request('/api/planner/status');
      if (!status.enabled) { nav.hidden = true; sideNav.hidden = true; return; }
      state.llm.configured = status.llmConfigured;
      nav.hidden = false;
      state.activePage = localStorage.getItem(storageKey) || 'overview';
      keepNavigationLabel();
      new MutationObserver(() => { keepNavigationLabel(); render(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
      nav.addEventListener('click', event => { if (event.isTrusted) { state.activePage = 'overview'; state.editingTaskId = null; state.draftCategory = null; } navigation.setExpanded(sideNav.hidden); setTimeout(keepNavigationLabel, 0); }, true);
      sideNav.addEventListener('click', event => { const button = event.target.closest('[data-planner-sidepage]'); if (!button) return; event.preventDefault(); event.stopPropagation(); state.activePage = button.dataset.plannerSidepage; state.editingTaskId = null; state.draftCategory = null; nav.click(); setTimeout(() => { render(); navigation.setExpanded(true); }, 0); }, true);
      document.addEventListener('click', event => { const item = event.target.closest('.nav-item'); if (item && item !== nav) navigation.setExpanded(false); }, true);
      await load();
      navigation.setExpanded(false);
    } catch { nav.hidden = true; sideNav.hidden = true; }
  }
  window.planner = { load };
  initialize();
}());
