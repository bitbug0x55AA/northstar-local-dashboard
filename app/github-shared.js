(function () {
  function context() { return window.northstarGithubApp; }
  function scopedRepos() { const app = context(), repos = app.state.github.repos || []; return app.state.selectedRepo === 'all' ? repos : repos.filter(repo => repo.name === app.state.selectedRepo); }
  function issues(repos) { return repos.flatMap(repo => (repo.issues || []).map(issue => ({ ...issue, repo: repo.name }))); }
  function releases(repos) { return repos.flatMap(repo => (repo.releases || []).map(release => ({ ...release, repo: repo.name }))).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)); }
  function issueCard(issue) { const app = context(); return `<div class="roadmap-item">#${issue.number} ${app.escapeHtml(issue.title)}<small>${app.escapeHtml(issue.repo)} · ${(issue.labels || []).slice(0, 2).map(app.escapeHtml).join(' / ') || 'unlabelled'}</small></div>`; }
  function toolbar(repos) { const app = context(); return `<div class="github-toolbar"><select id="repoScope"><option value="all">${app.t('全部项目', 'All Projects')}</option>${repos.map(repo => `<option value="${app.escapeHtml(repo.name)}" ${app.state.selectedRepo === repo.name ? 'selected' : ''}>${app.escapeHtml(repo.name)}</option>`).join('')}</select><button class="primary-button" id="githubSync">↻ ${app.t('同步 GitHub', 'Sync GitHub')}</button></div>`; }
  window.NorthstarGithubShared = { context, scopedRepos, issues, releases, issueCard, toolbar };
}());
