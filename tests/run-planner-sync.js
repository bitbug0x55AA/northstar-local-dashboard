const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-planner-sync-'));
process.env.NORTHSTAR_PLANNER_DIR = tempDir;
const { readPlanner, syncGithubToPlanner } = require('../server/planner-store');

const github = {
  repos: [{
    name: 'signal-console',
    issues: [{ number: 241, title: 'Add keyboard shortcuts', labels: ['in-progress'], updatedAt: '2026-08-08T05:42:00Z', url: 'https://github.com/northstar-labs/signal-console/issues/241' }],
    closedIssues: []
  }]
};

const first = syncGithubToPlanner(github);
assert.equal(first.results.created, 1);
assert.equal(first.results.projectsCreated, 1);
assert.equal(first.data.projects[0].sourceRef, 'github:signal-console');
assert.equal(first.data.tasks[0].sourceRef, 'github:signal-console#241');
assert.equal(first.data.tasks[0].status, 'in-progress');
assert.equal(first.data.tasks[0].projectId, first.data.projects[0].id);
assert.equal(first.data.tasks[0].category, 'GitHub 开源项目');

const polished = syncGithubToPlanner({
  repos: [{
    ...github.repos[0],
    issues: [{
      ...github.repos[0].issues[0],
      plannerTitle: '#241 建立可执行的键盘快捷键方案',
      plannerNotes: '整理命令面板快捷键并完成验证。',
      plannerCategory: 'feature',
      plannerTags: ['command-palette', 'ux'],
      plannerPolishVersion: 'github-polish-v3'
    }]
  }]
});
assert.equal(polished.data.tasks[0].title, '#241 建立可执行的键盘快捷键方案');
assert.equal(polished.data.tasks[0].notes, '整理命令面板快捷键并完成验证。');
assert.equal(polished.data.tasks[0].sourcePolishVersion, 'github-polish-v3');
assert.equal(polished.data.tasks[0].category, 'GitHub 开源项目');

const second = syncGithubToPlanner(github);
assert.equal(second.results.created, 0);
assert.equal(second.results.updated, 0);
assert.equal(second.data.projects.length, 1);
assert.equal(second.data.tasks.length, 1);

const rawRefresh = syncGithubToPlanner({
  repos: [{
    ...github.repos[0],
    issues: [{ ...github.repos[0].issues[0], updatedAt: '2026-08-09T05:42:00Z' }]
  }]
});
assert.equal(rawRefresh.data.tasks[0].title, '#241 建立可执行的键盘快捷键方案');
assert.equal(rawRefresh.data.tasks[0].sourcePolishVersion, 'github-polish-v3');

const closed = syncGithubToPlanner({
  repos: [{ ...github.repos[0], issues: [], closedIssues: [{ number: 241, title: 'Add keyboard shortcuts' }] }]
});
assert.equal(closed.results.completed, 1);
assert.equal(readPlanner().tasks[0].status, 'done');

fs.rmSync(tempDir, { recursive: true, force: true });
console.log('Planner GitHub sync checks passed');
