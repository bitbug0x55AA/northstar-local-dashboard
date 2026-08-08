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

const second = syncGithubToPlanner(github);
assert.equal(second.results.created, 0);
assert.equal(second.results.updated, 0);
assert.equal(second.data.projects.length, 1);
assert.equal(second.data.tasks.length, 1);

const closed = syncGithubToPlanner({
  repos: [{ ...github.repos[0], issues: [], closedIssues: [{ number: 241, title: 'Add keyboard shortcuts' }] }]
});
assert.equal(closed.results.completed, 1);
assert.equal(readPlanner().tasks[0].status, 'done');

fs.rmSync(tempDir, { recursive: true, force: true });
console.log('Planner GitHub sync checks passed');
