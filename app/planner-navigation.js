(function () {
  const shared = window.NorthstarPlannerShared;
  function createNavigation(nav, sideNav, getState, getCategories, tasksFor) {
    function render() {
      const { activePage } = getState();
      const categories = getCategories();
      sideNav.innerHTML = `<button class="nav-subitem ${activePage === 'overview' ? 'active' : ''}" data-planner-sidepage="overview">${shared.tr('总览', 'Overview')}</button>${categories.map(category => `<button class="nav-subitem ${activePage === shared.categoryId(category) ? 'active' : ''}" data-planner-sidepage="${shared.escapeHtml(shared.categoryId(category))}">${shared.escapeHtml(shared.categoryText(category))}<span>${tasksFor(category).filter(task => task.status !== 'done').length}</span></button>`).join('')}<button class="nav-subitem accent ${activePage === 'add' ? 'active' : ''}" data-planner-sidepage="add">${shared.tr('添加', 'Add')}</button>`;
      nav.classList.add('planner-nav-toggle');
      nav.setAttribute('aria-expanded', 'true');
    }
    function setExpanded(expanded) { sideNav.hidden = !expanded; nav.setAttribute('aria-expanded', String(expanded)); }
    return { render, setExpanded };
  }
  window.NorthstarPlannerNavigation = { createNavigation };
}());
