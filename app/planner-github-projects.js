(function () {
  const shared = window.NorthstarPlannerShared;
  const githubSnapshot = () => window.northstarGithubApp?.state?.github?.repos || [];

  function taskRows(tasks, empty) {
    if (!tasks.length) return `<div class="empty">${empty}</div>`;
    return tasks.map(task => `<div class="planner-task"><div class="planner-task-main"><b>${shared.escapeHtml(task.title)}</b>${task.notes ? `<p class="planner-task-notes">${shared.escapeHtml(String(task.notes).split(/\r?\n/)[0])}</p>` : ''}<small>${task.dueAt ? `${shared.tr('截止', 'Due')} ${shared.dateText(task.dueAt)} · ` : ''}${shared.escapeHtml(task.status)}</small></div><span class="planner-priority ${shared.escapeHtml(task.priority || 'medium')}">${shared.escapeHtml(task.priority || 'medium')}</span><button class="text-button planner-complete" data-id="${shared.escapeHtml(task.id)}" data-status="${shared.escapeHtml(task.status)}">${task.status === 'done' ? shared.tr('重新打开', 'Reopen') : shared.tr('完成', 'Complete')}</button><button class="text-button planner-edit" data-id="${shared.escapeHtml(task.id)}">${shared.tr('编辑', 'Edit')}</button><button class="text-button planner-delete" data-id="${shared.escapeHtml(task.id)}">${shared.tr('删除', 'Delete')}</button></div>`).join('');
  }

  function render(data, state) {
    const category = data.settings?.modules?.github;
    const projects = (data.projects || []).filter(project => project.source === 'github');
    const categoryTasks = (data.tasks || []).filter(task => task.category === category && task.status !== 'cancelled');
    const hasUnassigned = categoryTasks.some(task => !task.projectId);
    const allowed = new Set(['all', 'unassigned', ...projects.map(project => project.id)]);
    if (!allowed.has(state.githubPlannerProjectId)) state.githubPlannerProjectId = projects[0]?.id || (hasUnassigned ? 'unassigned' : 'all');
    const selectedId = state.githubPlannerProjectId;
    const selected = projects.find(project => project.id === selectedId);
    const tasks = selectedId === 'all' ? categoryTasks : selectedId === 'unassigned' ? categoryTasks.filter(task => !task.projectId) : categoryTasks.filter(task => task.projectId === selectedId);
    const repo = githubSnapshot().find(item => item.name === selected?.name);
    const active = tasks.filter(task => !['done', 'cancelled'].includes(task.status));
    const done = tasks.filter(task => task.status === 'done');
    const progress = shared.taskProgress(tasks);
    const options = `${projects.map(project => `<option value="${shared.escapeHtml(project.id)}" ${project.id === selectedId ? 'selected' : ''}>${shared.escapeHtml(project.name)}</option>`).join('')}${hasUnassigned ? `<option value="unassigned" ${selectedId === 'unassigned' ? 'selected' : ''}>${shared.tr('未分配任务', 'Unassigned tasks')}</option>` : ''}<option value="all" ${selectedId === 'all' ? 'selected' : ''}>${shared.tr('全部项目', 'All projects')}</option>`;
    const total = key => githubSnapshot().reduce((sum, item) => sum + Number(item[key] || 0), 0);
    return `<div class="github-planner-hero"><div><div class="eyebrow">PROJECT-SCOPED PLANNER</div><h2>${shared.escapeHtml(shared.categoryText(category))}</h2><p>${shared.tr('通过项目下拉菜单隔离仓库数据、Issue 任务和完成记录。', 'Use the project selector to isolate repository data, issue tasks and completed work.')}</p></div><label>${shared.tr('当前项目', 'Current project')}<select id="plannerGithubProjectSelect">${options}</select></label></div>${projects.length ? `<section class="github-project-summary"><div><span>${shared.tr('项目', 'Project')}</span><strong>${shared.escapeHtml(selected?.name || shared.tr('全部项目', 'All projects'))}</strong><small>${shared.escapeHtml(selected?.description || shared.tr('跨项目汇总视图', 'Cross-project summary'))}</small></div><div><span>STARS</span><strong>${selected ? Number(repo?.stars || 0) : total('stars')}</strong></div><div><span>FORKS</span><strong>${selected ? Number(repo?.forks || 0) : total('forks')}</strong></div><div><span>${shared.tr('任务进度', 'Task progress')}</span><strong>${progress}%</strong><small>${done.length}/${tasks.length} ${shared.tr('项完成', 'complete')}</small></div></section>` : ''}<div class="github-project-work"><section class="panel"><div class="panel-header"><div><div class="panel-title">${shared.tr('当前项目任务', 'Current project tasks')}</div><div class="panel-subtitle">${active.length} ${shared.tr('项待推进', 'items to advance')}</div></div><button class="text-button" data-planner-tab="add" data-category="${shared.escapeHtml(category || '')}" data-project="${shared.escapeHtml(selected?.id || '')}">${shared.tr('添加项目任务', 'Add project task')}</button></div>${taskRows(active, projects.length ? shared.tr('该项目目前没有待办。', 'No pending tasks for this project.') : shared.tr('同步 GitHub 后，项目会出现在下拉菜单中。', 'Projects appear here after GitHub sync.'))}</section><section class="panel"><div class="panel-header"><div><div class="panel-title">${shared.tr('已完成', 'Completed')}</div><div class="panel-subtitle">${done.length} ${shared.tr('项成果', 'items')}</div></div></div>${taskRows(done.slice(0, 8), shared.tr('该项目还没有完成记录。', 'No completed work for this project yet.'))}</section></div>`;
  }

  function bind(state, render) {
    document.querySelector('#plannerGithubProjectSelect')?.addEventListener('change', event => {
      state.githubPlannerProjectId = event.target.value;
      localStorage.setItem('northstar.plannerGithubProject', state.githubPlannerProjectId);
      render();
    });
  }
  window.NorthstarPlannerGithubProjects = { render, bind };
}());
