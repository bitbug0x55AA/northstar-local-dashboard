(function () {
  const { escapeHtml, tr, categoryText } = window.NorthstarPlannerShared;
  const moduleLabels = {
    none: () => tr('普通任务页', 'Standard task page'),
    roadmap: () => tr('路线图', 'Roadmap'),
    github: () => tr('GitHub 项目', 'GitHub projects'),
    performance: () => tr('绩效台账', 'Performance register'),
    fitness: () => tr('训练记录', 'Fitness log')
  };
  const moduleFor = (data, category) => Object.entries(data.settings?.modules || {}).find(([, value]) => value === category)?.[0] || 'none';
  const moduleOptions = selected => Object.keys(moduleLabels).map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${moduleLabels[value]()}</option>`).join('');

  function categoryRows(data) {
    return (data.categories || []).map((category, index) => {
      const labelEn = data.settings?.categoryLabels?.find(item => item.category === category)?.labelEn || '';
      return `<form class="planner-data-row" data-category-row data-index="${index}" data-old-name="${escapeHtml(category)}"><input name="name" value="${escapeHtml(category)}" aria-label="${tr('分类名称', 'Category name')}"/><input name="labelEn" value="${escapeHtml(labelEn)}" placeholder="${tr('英文显示名（可选）', 'English label (optional)')}"/><select name="module" aria-label="${tr('页面类型', 'Page type')}">${moduleOptions(moduleFor(data, category))}</select><button class="ghost-button" type="submit">${tr('保存', 'Save')}</button><button class="text-button danger" type="button" data-delete-category>${tr('删除', 'Delete')}</button></form>`;
    }).join('') || `<div class="empty">${tr('尚无分类。请先创建一个分类，再添加任务。', 'No categories yet. Create one before adding tasks.')}</div>`;
  }

  function planRows(data) {
    return (data.fitness?.plans || []).map(item => `<form class="planner-data-row" data-fitness-plan data-id="${escapeHtml(item.id)}"><input name="name" value="${escapeHtml(item.name)}" aria-label="${tr('计划名称', 'Plan name')}"/><input name="labelEn" value="${escapeHtml(item.labelEn || '')}" placeholder="${tr('英文名称', 'English name')}"/><input name="focus" value="${escapeHtml(item.focus || '')}" placeholder="${tr('计划说明', 'Plan description')}"/><input name="focusEn" value="${escapeHtml(item.focusEn || '')}" placeholder="${tr('英文说明', 'English description')}"/><button class="ghost-button" type="submit">${tr('保存', 'Save')}</button><button class="text-button danger" type="button" data-delete-plan>${tr('删除', 'Delete')}</button></form>`).join('') || `<div class="empty">${tr('没有训练计划；训练页会显示空状态。', 'No training plans; the fitness page will show an empty state.')}</div>`;
  }

  function targetRows(data) {
    return (data.performance?.targets || []).map(item => `<form class="planner-data-row compact" data-performance-target data-id="${escapeHtml(item.id)}"><input name="name" value="${escapeHtml(item.name)}" aria-label="${tr('指标名称', 'Target name')}"/><input name="labelEn" value="${escapeHtml(item.labelEn || '')}" placeholder="${tr('英文名称', 'English name')}"/><input name="target" type="number" min="0" value="${Number(item.target) || 0}" aria-label="${tr('目标值', 'Target value')}"/><button class="ghost-button" type="submit">${tr('保存', 'Save')}</button><button class="text-button danger" type="button" data-delete-target>${tr('删除', 'Delete')}</button></form>`).join('') || `<div class="empty">${tr('没有绩效目标类型；绩效页不会假定任何年度数字。', 'No performance target types; the performance page assumes no annual numbers.')}</div>`;
  }

  function render(data) {
    return `<div class="planner-category-hero"><div><div class="eyebrow">LOCAL DATA · USER OWNED</div><h2>${tr('私人数据设置', 'Personal data settings')}</h2><p>${tr('这里的内容保存在本机数据文件中，不属于工具代码。所有分离出的配置均可新增、修改和删除。', 'These values live in your local data file, not in tool code. Every extracted setting can be created, edited, or deleted here.')}</p></div><span class="source-pill"><i></i>LOCAL ONLY</span></div><section class="panel planner-data-settings"><div class="panel-header"><div><div class="panel-title">${tr('分类与功能页面', 'Categories and module pages')}</div><small>${tr('一个分类可使用普通任务页，或绑定到一个通用功能模块。', 'A category can use a standard task page or one generic module.')}</small></div></div>${categoryRows(data)}<form class="planner-data-create" id="plannerCreateCategory"><input name="name" placeholder="${tr('新分类名称', 'New category name')}" required/><input name="labelEn" placeholder="${tr('英文显示名（可选）', 'English label (optional)')}"/><select name="module">${moduleOptions('none')}</select><button class="primary-button" type="submit">${tr('新增分类', 'Add category')}</button></form></section><section class="panel planner-data-settings"><div class="panel-header"><div><div class="panel-title">${tr('训练计划', 'Training plans')}</div><small>${tr('计划名称和说明会直接驱动训练页。', 'Plan names and descriptions drive the fitness page directly.')}</small></div></div>${planRows(data)}<form class="planner-data-create" id="plannerCreatePlan"><input name="name" placeholder="${tr('计划名称', 'Plan name')}" required/><input name="labelEn" placeholder="${tr('英文名称', 'English name')}"/><input name="focus" placeholder="${tr('计划说明', 'Plan description')}"/><input name="focusEn" placeholder="${tr('英文说明', 'English description')}"/><button class="primary-button" type="submit">${tr('新增计划', 'Add plan')}</button></form></section><section class="panel planner-data-settings"><div class="panel-header"><div><div class="panel-title">${tr('绩效活动目标', 'Performance activity targets')}</div><small>${tr('指标名称和年度目标值均来自本地数据。', 'Names and annual target values come from local data.')}</small></div></div>${targetRows(data)}<form class="planner-data-create compact" id="plannerCreateTarget"><input name="name" placeholder="${tr('指标名称', 'Target name')}" required/><input name="labelEn" placeholder="${tr('英文名称', 'English name')}"/><input name="target" type="number" min="0" placeholder="${tr('目标值', 'Target')}" required/><button class="primary-button" type="submit">${tr('新增指标', 'Add target')}</button></form></section><div id="plannerPreview"></div>`;
  }

  function values(form) { return Object.fromEntries(new FormData(form).entries()); }
  async function run(apply, showError, operation) { try { await apply([operation]); } catch (error) { showError(error.message); } }
  function bind(state, apply, render, showError) {
    document.querySelectorAll('[data-category-row]').forEach(form => {
      form.addEventListener('submit', event => { event.preventDefault(); const value = values(form); run(apply, showError, { type: 'update_category', oldName: form.dataset.oldName, name: value.name, labelEn: value.labelEn, module: value.module }); });
      form.querySelector('[data-delete-category]')?.addEventListener('click', () => { if (window.confirm(tr('删除这个分类？使用中的分类不能删除。', 'Delete this category? Categories in use cannot be deleted.'))) run(apply, showError, { type: 'delete_category', name: form.dataset.oldName }); });
    });
    document.querySelector('#plannerCreateCategory')?.addEventListener('submit', event => { event.preventDefault(); const value = values(event.currentTarget); run(apply, showError, { type: 'create_category', ...value }); });
    document.querySelectorAll('[data-fitness-plan]').forEach(form => {
      form.addEventListener('submit', event => { event.preventDefault(); run(apply, showError, { type: 'update_fitness_plan', id: form.dataset.id, ...values(form) }); });
      form.querySelector('[data-delete-plan]')?.addEventListener('click', () => run(apply, showError, { type: 'delete_fitness_plan', id: form.dataset.id }));
    });
    document.querySelector('#plannerCreatePlan')?.addEventListener('submit', event => { event.preventDefault(); run(apply, showError, { type: 'create_fitness_plan', ...values(event.currentTarget) }); });
    document.querySelectorAll('[data-performance-target]').forEach(form => {
      form.addEventListener('submit', event => { event.preventDefault(); const value = values(form); run(apply, showError, { type: 'update_performance_target', id: form.dataset.id, ...value, target: Number(value.target) }); });
      form.querySelector('[data-delete-target]')?.addEventListener('click', () => run(apply, showError, { type: 'delete_performance_target', id: form.dataset.id }));
    });
    document.querySelector('#plannerCreateTarget')?.addEventListener('submit', event => { event.preventDefault(); const value = values(event.currentTarget); run(apply, showError, { type: 'create_performance_target', ...value, target: Number(value.target) }); });
  }
  window.NorthstarPlannerSettings = { render, bind };
}());
