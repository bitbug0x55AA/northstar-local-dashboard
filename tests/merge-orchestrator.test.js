const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');
const { analyzeMergeWorkspace } = require('../server/merge-orchestrator');

function git(directory, ...args) {
  return execFileSync('git', ['-c', 'user.name=Northstar CI', '-c', 'user.email=ci@example.test', ...args], { cwd: directory, encoding: 'utf8' });
}

test('merge analysis is read-only and reports branch overlap', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-merge-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  git(directory, 'init', '--initial-branch=main');
  fs.writeFileSync(path.join(directory, 'shared.txt'), 'base\n');
  git(directory, 'add', '.'); git(directory, 'commit', '-m', 'base');

  git(directory, 'checkout', '-b', 'feature-one');
  fs.writeFileSync(path.join(directory, 'shared.txt'), 'feature one\n');
  git(directory, 'add', '.'); git(directory, 'commit', '-m', 'feature one');
  git(directory, 'checkout', 'main');
  git(directory, 'checkout', '-b', 'feature-two');
  fs.writeFileSync(path.join(directory, 'docs.txt'), 'feature two\n');
  git(directory, 'add', '.'); git(directory, 'commit', '-m', 'feature two');

  const before = git(directory, 'status', '--porcelain');
  const result = await analyzeMergeWorkspace({ repoPath: directory, baseBranch: 'main', sourceBranches: 'feature-one, feature-two' });
  assert.equal(result.base.name, 'main');
  assert.equal(result.branches.length, 2);
  assert.equal(result.workingTree.length, 0);
  assert.deepEqual(git(directory, 'status', '--porcelain'), before, 'analysis must not modify the repository');
  assert.ok(result.recommendation.order.includes('feature-one'));
  assert.ok(result.recommendation.order.includes('feature-two'));
});

test('merge analysis rejects unsafe Git refs before running Git commands', async () => {
  await assert.rejects(
    analyzeMergeWorkspace({ repoPath: process.cwd(), baseBranch: 'main', sourceBranches: 'main; rm -rf /' }),
    /不安全|unsafe|invalid/i
  );
});
