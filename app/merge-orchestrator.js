(function () {
  const nav = document.querySelector('[data-github-subnav]');
  const toggle = document.querySelector('.nav-item[data-view="github"]');
  const view = document.querySelector('#view-github');
  if (!nav || !toggle || !view) return;

  const storageKey = 'northstar.githubSubpage';
  const workspaceKey = 'northstar.mergeWorkspace';
  let rendering = false;
  let activeSubpage = localStorage.getItem(storageKey) || 'all';

  function tr(zh, en) { return document.documentElement.lang === 'en' ? en : zh; }
  function escape(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
  function readJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } }
  function getSavedWorkspace() { return readJson(workspaceKey, { repoPath: '', baseBranch: 'main', sourceBranches: '' }); }
  function setActiveGithub() {
    document.querySelectorAll('.view').forEach(item => item.classList.toggle('active-view', item === view));
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === 'github'));
    const pageTitle = document.querySelector('#pageTitle');
    if (pageTitle) pageTitle.textContent = tr('GitHub 项目', 'GitHub Projects');
  }

  function setSubnavExpanded(expanded) {
    nav.hidden = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
  }

  function moveSubnav() {
    toggle.classList.add('github-nav-toggle');
    toggle.after(nav);
  }

  function removeGithubTabs() {
    view.querySelectorAll('.filter-row').forEach(row => {
      if (row.querySelector('[data-github-view]')) row.remove();
    });
  }

  function setSubpage(id) {
    activeSubpage = id;
    localStorage.setItem(storageKey, id);
    setSubnavExpanded(true);
    nav.querySelectorAll('[data-github-subview]').forEach(button => button.classList.toggle('active', button.dataset.githubSubview === id));
  }

  function subpageButton(id, label) {
    return `<button class="nav-subitem ${id === 'orchestrator' ? 'accent' : ''}" data-github-subview="${id}">${label}</button>`;
  }

  function renderShell() {
    const saved = getSavedWorkspace();
    const github = readJson('northstar.github', { repos: [] });
    const repoHint = (github.repos || []).map(repo => escape(repo.name)).join(', ');
    view.setAttribute('data-merge-orchestrator-rendered', 'true');
    view.innerHTML = `<div class="merge-page">
      <div class="page-heading"><div><div class="eyebrow">MERGE CONTROL ROOM</div><h1>${tr('Merge 编排工作台', 'Merge Orchestrator')}</h1><p>${tr('先读取 Git 图谱和真实冲突，再由本地 LLM 给出可审阅的合并顺序。', 'Inspect the Git graph and real conflicts before the local LLM explains a reviewable merge order.')}</p></div><span class="source-pill"><i></i>${tr('只读预检', 'READ-ONLY PREFLIGHT')}</span></div>
      <div class="merge-grid"><div class="panel"><div class="panel-header"><div><div class="panel-title">${tr('工作区输入', 'Workspace Inputs')}</div><div class="panel-subtitle">${tr('只运行只读 Git 查询，不会修改仓库、提交或推送。', 'Read-only Git queries only. No merge, commit, push, or reset is performed.')}</div></div></div>
        <div class="merge-field"><label>${tr('本地仓库路径', 'Local repository path')}</label><input id="mergeRepoPath" value="${escape(saved.repoPath)}" placeholder="C:\\Users\\you\\Documents\\github\\project" /></div>
        <div class="merge-field"><label>${tr('目标分支', 'Target branch')}</label><input id="mergeBaseBranch" value="${escape(saved.baseBranch || 'main')}" placeholder="main" /></div>
        <div class="merge-field"><label>${tr('待合并分支（每行一个）', 'Branches to merge (one per line)')}</label><textarea id="mergeSourceBranches" placeholder="feature/a\nfeature/b">${escape(saved.sourceBranches)}</textarea></div>
        <div class="help">${tr('GitHub 已同步仓库：', 'GitHub-synced repositories: ')}${repoHint || tr('暂无，请先同步 GitHub。', 'None yet; sync GitHub first.')}</div>
        <div class="merge-actions"><button class="primary-button" id="mergeAnalyze">${tr('开始冲突预检', 'Run Merge Preflight')}</button><button class="ghost-button" id="mergeClear">${tr('清空结果', 'Clear')}</button></div>
        <div id="mergeAnalysisStatus" class="merge-analysis-status"></div>
      </div><div id="mergeResults"><div class="panel merge-empty"><div class="panel-title">${tr('等待分析', 'Waiting for analysis')}</div><p>${tr('输入一个本地仓库、目标分支和两个或多个待合并分支，开始建立变更依赖图。', 'Enter a local repository, target branch, and one or more source branches to build a change dependency map.')}</p></div></div></div>
    </div>`;
    bindForm();
    loadWorkspaces(saved);
  }

  function renderWorkspaceControls(workspaces, saved) {
    const pathInput = document.querySelector('#mergeRepoPath');
    const repoField = pathInput?.closest('.merge-field');
    if (!repoField || !workspaces.length) return;
    const selectedPath = workspaces.some(item => item.path === saved.repoPath) ? saved.repoPath : workspaces[0].path;
    repoField.innerHTML = `<label>${tr('本地仓库', 'Local repository')}</label><select id="mergeWorkspaceSelect">${workspaces.map(item => `<option value="${escape(item.path)}" ${item.path === selectedPath ? 'selected' : ''}>${escape(item.name)} · ${escape(item.path)}</option>`).join('')}</select>`;
    const baseField = document.querySelector('#mergeBaseBranch')?.closest('.merge-field');
    const sourceField = document.querySelector('#mergeSourceBranches')?.closest('.merge-field');
    if (!baseField || !sourceField) return;
    baseField.innerHTML = `<label>${tr('目标分支', 'Target branch')}</label><select id="mergeBaseBranch"></select>`;
    sourceField.innerHTML = `<label>${tr('待合并分支', 'Branches to merge')}</label><div id="mergeSourceBranches" class="merge-branch-picker"></div>`;
    const workspaceSelect = document.querySelector('#mergeWorkspaceSelect');
    const baseSelect = document.querySelector('#mergeBaseBranch');
    const sourcePicker = document.querySelector('#mergeSourceBranches');
    const selectedSources = String(saved.sourceBranches || '').split(/[\r\n,]+/).map(value => value.trim()).filter(Boolean);
    function refreshBranchOptions(workspace) {
      const branches = Array.isArray(workspace?.branches) ? workspace.branches : [];
      const preferredBase = saved.baseBranch && branches.includes(saved.baseBranch) ? saved.baseBranch : branches.find(branch => ['main', 'master', 'develop'].includes(branch)) || workspace?.currentBranch || branches[0] || 'main';
      baseSelect.innerHTML = branches.length ? branches.map(branch => `<option value="${escape(branch)}" ${branch === preferredBase ? 'selected' : ''}>${escape(branch)}</option>`).join('') : '<option value="main">main</option>';
      const defaults = selectedSources.length ? selectedSources : (workspace?.currentBranch && workspace.currentBranch !== preferredBase ? [workspace.currentBranch] : []);
      sourcePicker.innerHTML = branches.filter(branch => branch !== preferredBase).map(branch => `<label class="merge-branch-option"><input type="checkbox" data-merge-source value="${escape(branch)}" ${defaults.includes(branch) ? 'checked' : ''} /><span>${escape(branch)}</span></label>`).join('') || `<span class="empty">${tr('没有可选的其他分支。', 'No other branches available.')}</span>`;
    }
    refreshBranchOptions(workspaces.find(item => item.path === selectedPath));
    workspaceSelect.addEventListener('change', () => {
      const workspace = workspaces.find(item => item.path === workspaceSelect.value);
      refreshBranchOptions(workspace);
    });
  }

  async function loadWorkspaces(saved) {
    try {
      const response = await fetch('/api/merge-orchestrator/workspaces');
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || tr('无法发现本地仓库', 'Unable to discover local repositories'));
      renderWorkspaceControls(data.workspaces || [], saved);
    } catch {
      // The manual path controls remain available when discovery is unavailable.
    }
  }

  function riskLabel(risk) { return ({ low: tr('低风险', 'LOW'), medium: tr('中风险', 'MEDIUM'), high: tr('高风险', 'HIGH'), critical: tr('存在冲突', 'CONFLICT') }[risk] || risk); }
  function branchCard(branch) {
    const conflicts = branch.preflight?.conflictFiles || [];
    const overlap = branch.overlapWithBase || [];
    return `<div class="merge-branch-card"><div class="merge-branch-head"><div><b>${escape(branch.name)}</b><small>${escape(branch.sha.slice(0, 10))} · ${branch.changedFiles.length} ${tr('个变更文件', 'changed files')}</small></div><span class="merge-risk ${branch.risk}">${riskLabel(branch.risk)}</span></div><div class="merge-branch-meta"><span>${tr('预检', 'Preflight')}: ${branch.preflight.status === 'clean' ? tr('无直接冲突', 'clean') : tr('需要人工解决', 'manual resolution required')}</span><span>${tr('与目标分支重叠', 'Target overlap')}: ${overlap.length}</span><span>${tr('与其他分支重叠', 'Pair overlap')}: ${branch.pairwiseOverlapCount}</span></div>${conflicts.length ? `<div class="merge-file-list"><b>${tr('冲突文件', 'Conflict files')}</b>${conflicts.map(file => `<code>${escape(file)}</code>`).join('')}</div>` : overlap.length ? `<div class="merge-file-list"><b>${tr('重叠文件', 'Overlapping files')}</b>${overlap.slice(0, 12).map(file => `<code>${escape(file)}</code>`).join('')}</div>` : ''}</div>`;
  }

  function renderResults(analysis) {
    const recommendation = analysis.recommendation || {};
    const order = Array.isArray(recommendation.order) ? recommendation.order.map(item => typeof item === 'string' ? { branch: item, reason: '' } : item).filter(item => item?.branch) : [];
    const riskRows = (recommendation.risks || []).map(item => `<li><b>${escape(item.branch)}</b><span>${escape(item.file || '')}${item.reason ? ` · ${escape(item.reason)}` : ''}</span></li>`).join('');
    const pairRows = (analysis.pairwiseOverlaps || []).map(item => `<li><b>${escape(item.branches.join(' ↔ '))}</b><span>${item.files.length} ${tr('个共同文件', 'shared files')} · ${item.files.slice(0, 5).map(escape).join(', ')}</span></li>`).join('');
    const dirty = (analysis.workingTree || []).length;
    document.querySelector('#mergeResults').innerHTML = `<div class="merge-result-stack">
      <div class="metric-grid merge-metrics">${metricCard(tr('当前分支', 'Current branch'), analysis.currentBranch || '—', analysis.base.name)}${metricCard(tr('工作区状态', 'Working tree'), dirty ? tr('有未提交改动', 'Dirty') : tr('干净', 'Clean'), dirty ? 'warn' : 'good')}${metricCard(tr('待合并分支', 'Source branches'), analysis.branches.length, tr('已完成只读预检', 'read-only preflight complete'))}${metricCard(tr('直接冲突', 'Direct conflicts'), analysis.branches.filter(item => item.preflight.status === 'conflict').length, tr('需要人工处理', 'needs review'), analysis.branches.some(item => item.preflight.status === 'conflict') ? 'warn' : 'good')}</div>
      <div class="merge-result-grid"><div class="panel"><div class="panel-header"><div><div class="panel-title">${tr('建议合并顺序', 'Recommended order')}</div><div class="panel-subtitle">${recommendation.source === 'local-llm' ? tr('本地 LLM 基于 Git 预检结果生成', 'Generated locally from Git preflight results') : tr('基于冲突风险和文件重叠的确定性排序', 'Deterministic order based on conflict risk and file overlap')}</div></div><span class="source-pill"><i></i>${recommendation.source === 'local-llm' ? 'LOCAL LLM' : 'GIT HEURISTIC'}</span></div><div class="merge-order">${order.map((item, index) => `<div class="merge-order-row"><span>${String(index + 1).padStart(2, '0')}</span><div><b>${escape(item.branch)}</b><small>${escape(item.reason || tr('先处理较低风险变更，再处理重叠或冲突变更。', 'Handle lower-risk changes before overlapping or conflicting changes.'))}</small></div></div>`).join('') || `<div class="empty">${tr('暂无可用顺序。', 'No order available.')}</div>`}</div>${recommendation.summary ? `<div class="merge-summary">${escape(recommendation.summary)}</div>` : ''}${recommendation.questions?.length ? `<div class="merge-questions"><b>${tr('需要确认', 'Questions to confirm')}</b>${recommendation.questions.map(question => `<span>${escape(question)}</span>`).join('')}</div>` : ''}</div><div class="panel"><div class="panel-header"><div><div class="panel-title">${tr('分支预检', 'Branch preflight')}</div><div class="panel-subtitle">${escape(analysis.base.name)} ← ${analysis.branches.length} ${tr('个来源分支', 'source branches')}</div></div></div>${analysis.branches.map(branchCard).join('')}</div></div>
      ${(pairRows || riskRows) ? `<div class="merge-result-grid"><div class="panel"><div class="panel-title">${tr('分支之间的重叠', 'Pairwise overlap')}</div><ul class="merge-info-list">${pairRows || `<li><span>${tr('没有检测到共同变更文件。', 'No shared changed files detected.')}</span></li>`}</ul></div><div class="panel"><div class="panel-title">${tr('LLM 风险提示', 'LLM risk notes')}</div><ul class="merge-info-list">${riskRows || `<li><span>${tr('当前没有额外风险提示。', 'No additional risk notes.')}</span></li>`}</ul></div></div>` : ''}
      <div class="merge-disclaimer">${tr('这是合并前的证据汇总，不是自动执行许可。确认代码语义、测试和依赖后，再在 Git 客户端中逐步合并。', 'This is evidence for merge preparation, not permission to execute. Confirm code semantics, tests, and dependencies before merging step by step in Git.')}</div>
    </div>`;
  }

  function metricCard(label, value, foot, cls = '') { return `<div class="metric-card"><div class="metric-label">${escape(label)}</div><div class="metric-value">${escape(value)}</div><div class="metric-foot ${cls}">${escape(foot)}</div></div>`; }

  function bindForm() {
    document.querySelector('#mergeAnalyze')?.addEventListener('click', analyze);
    document.querySelector('#mergeClear')?.addEventListener('click', () => { localStorage.removeItem(workspaceKey); renderShell(); });
  }

  async function analyze() {
    const workspaceSelect = document.querySelector('#mergeWorkspaceSelect');
    const repoPath = workspaceSelect?.value || document.querySelector('#mergeRepoPath')?.value.trim() || '';
    const baseControl = document.querySelector('#mergeBaseBranch');
    const baseBranch = baseControl?.value?.trim() || 'main';
    const sourceControl = document.querySelector('#mergeSourceBranches');
    const sourceBranches = sourceControl?.tagName === 'TEXTAREA'
      ? sourceControl.value.trim()
      : [...document.querySelectorAll('[data-merge-source]:checked')].map(input => input.value).join('\n');
    localStorage.setItem(workspaceKey, JSON.stringify({ repoPath, baseBranch, sourceBranches }));
    const button = document.querySelector('#mergeAnalyze');
    const status = document.querySelector('#mergeAnalysisStatus');
    button.disabled = true;
    status.innerHTML = `<span>${tr('正在读取 Git 图谱并执行只读预检…', 'Reading the Git graph and running read-only preflight...')}</span>`;
    try {
      const response = await fetch('/api/merge-orchestrator/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoPath, baseBranch, sourceBranches }) });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || tr('分析失败', 'Analysis failed'));
      if (!document.querySelector('#mergeResults')) {
        if (activeSubpage !== 'orchestrator') return;
        rendering = true;
        renderShell();
        rendering = false;
      }
      renderResults(data);
      const nextStatus = document.querySelector('#mergeAnalysisStatus');
      if (nextStatus) nextStatus.innerHTML = `<span class="good">${tr('预检完成', 'Preflight complete')} · ${new Date(data.generatedAt).toLocaleTimeString()}</span>`;
    } catch (error) {
      const nextStatus = document.querySelector('#mergeAnalysisStatus');
      if (!nextStatus) return;
      nextStatus.innerHTML = `<span class="bad">${escape(error.message)}</span>`;
      const results = document.querySelector('#mergeResults');
      if (results) results.innerHTML = `<div class="panel error-note">${tr('无法完成 Merge 预检：', 'Merge preflight failed: ')}${escape(error.message)}</div>`;
    } finally { if (button) button.disabled = false; }
  }

  function openSubpage(id) {
    setSubpage(id);
    if (id === 'orchestrator') {
      toggle.click();
      setTimeout(() => {
        setSubpage('orchestrator');
        setActiveGithub();
        renderShell();
      }, 0);
      return;
    }
    if (window.northstarGithub?.navigate) {
      window.northstarGithub.navigate(id);
      return;
    }
    toggle.click();
    setTimeout(() => {
      document.querySelector(`#view-github [data-github-view="${id}"]`)?.click();
      setSubpage(id);
    }, 0);
  }

  moveSubnav();
  removeGithubTabs();
  nav.addEventListener('click', event => {
    const button = event.target.closest('[data-github-subview]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    openSubpage(button.dataset.githubSubview);
  }, true);
  toggle.addEventListener('click', () => {
    const opening = nav.hidden;
    setSubnavExpanded(opening);
    if (opening) {
      activeSubpage = 'all';
      localStorage.setItem(storageKey, 'all');
      nav.querySelectorAll('[data-github-subview]').forEach(button => button.classList.toggle('active', button.dataset.githubSubview === 'all'));
    }
  }, true);
  document.addEventListener('click', event => {
    const navItem = event.target.closest('.nav-item');
    if (navItem && navItem.dataset.view !== 'github') {
      activeSubpage = 'all';
      localStorage.removeItem(storageKey);
      setSubnavExpanded(false);
    }
  }, true);

  const observer = new MutationObserver(() => {
    removeGithubTabs();
    if (!view.classList.contains('active-view')) return;
    if (rendering || activeSubpage !== 'orchestrator') return;
    if (!view.querySelector('.merge-page')) {
      rendering = true;
      setActiveGithub();
      renderShell();
      rendering = false;
    }
  });
  observer.observe(view, { childList: true });

  const savedSubpage = activeSubpage;
  if (savedSubpage === 'orchestrator') {
    toggle.click();
    setTimeout(() => {
      setSubpage('orchestrator');
      setActiveGithub();
      renderShell();
    }, 0);
  } else {
    setSubnavExpanded(false);
  }
}());
