(function () {
  const shared = window.NorthstarPlannerShared;
  function createNavigation(nav, sideNav, getState, getCategories, tasksFor) {
    function render() {
      const { activePage } = getState();
      const categories = getCategories();
      const weeklyCount = (getState().data.events || []).filter(event => { const date = new Date(event.startAt); const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); const end = new Date(start); end.setDate(end.getDate() + 7); return date >= start && date < end; }).length;
      sideNav.innerHTML = `<button class="nav-subitem ${activePage === 'overview' ? 'active' : ''}" data-planner-sidepage="overview">${shared.tr('总览', 'Overview')}</button><button class="nav-subitem ${activePage === 'weekly' ? 'active' : ''}" data-planner-sidepage="weekly">${shared.tr('本周计划', 'Weekly Plan')}<span>${weeklyCount}</span></button>${categories.map(category => `<button class="nav-subitem ${activePage === shared.categoryId(category) ? 'active' : ''}" data-planner-sidepage="${shared.escapeHtml(shared.categoryId(category))}">${shared.escapeHtml(shared.categoryText(category))}<span>${tasksFor(category).filter(task => task.status !== 'done').length}</span></button>`).join('')}<button class="nav-subitem accent ${activePage === 'add' ? 'active' : ''}" data-planner-sidepage="add">${shared.tr('添加', 'Add')}</button><button class="nav-subitem ${activePage === 'settings' ? 'active' : ''}" data-planner-sidepage="settings">${shared.tr('数据设置', 'Data settings')}</button>`;
      nav.classList.add('planner-nav-toggle');
      nav.setAttribute('aria-expanded', 'true');
    }
    function setExpanded(expanded) { sideNav.hidden = !expanded; nav.setAttribute('aria-expanded', String(expanded)); }
    return { render, setExpanded };
  }
  window.NorthstarPlannerNavigation = { createNavigation };
}());
