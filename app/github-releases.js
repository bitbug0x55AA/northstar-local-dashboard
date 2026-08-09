(function () {
  const shared = window.NorthstarGithubShared;
  function render(repos) { const app = shared.context(), releases = shared.releases(repos); return `<div class="panel"><div class="panel-header"><div><div class="panel-title">${app.t('最近发布', 'Recent Releases')}</div><div class="panel-subtitle">${releases.length}${app.t(' 条 release 记录', ' release records')}</div></div></div>${releases.map(release => `<div class="release-row"><div class="release-date">${app.dateFmt(release.publishedAt)}</div><span class="release-dot"></span><div class="release-name"><b>${app.escapeHtml(release.name)}</b><small style="display:block;color:#71809b;margin-top:3px">${app.escapeHtml(release.repo)}</small></div><span class="release-tag">${app.escapeHtml(release.tag)}</span></div>`).join('') || `<div class="empty">${app.t('暂无 Release 数据。', 'No release data.')}</div>`}</div>`; }
  window.NorthstarGithubReleases = { render };
}());
