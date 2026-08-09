(function () {
  function render() {
    const app = window.northstarGithubApp;
    if (!app) return;
    const repos = window.NorthstarGithubShared.scopedRepos();
    const views = {
      all: window.NorthstarGithubOverview.render(repos),
      releases: window.NorthstarGithubReleases.render(repos),
      roadmap: window.NorthstarGithubRoadmap.render(repos),
      ci: window.NorthstarGithubCi.render(repos)
    };
    const tabs = [['all', app.t('全部项目', 'All Projects')], ['releases', app.t('最近发布', 'Recent Releases')], ['roadmap', app.t('计划看板', 'Planning Board')], ['ci', app.t('CI 状态', 'CI Status')]];
    app.view.innerHTML = app.header('DELIVERY CENTER', app.t('GitHub 项目', 'GitHub Projects'), app.t('版本、Issue、CI 和轻量项目计划的统一视图。', 'A unified view of releases, issues, CI, and lightweight planning.'), window.NorthstarGithubShared.toolbar(app.state.github.repos || [])) + `<div class="filter-row">${tabs.map(([id, label]) => `<button class="filter ${app.state.githubView === id ? 'active' : ''}" data-github-view="${id}">${label}</button>`).join('')}</div>${views[app.state.githubView] || views.all}`;
    document.querySelector('#githubSync').addEventListener('click', app.syncGithub);
    document.querySelector('#repoScope').addEventListener('change', event => { app.state.selectedRepo = event.target.value; render(); });
    document.querySelectorAll('[data-github-view]').forEach(button => button.addEventListener('click', () => { app.state.githubView = button.dataset.githubView; render(); }));
    window.NorthstarGithubCi.bind();
  }
  window.NorthstarGithubPages = { render };
}());
