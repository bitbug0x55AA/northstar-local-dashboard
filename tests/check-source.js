const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build']);

function filesUnder(directory, predicate) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...filesUnder(path.join(directory, entry.name), predicate));
    } else if (predicate(entry.name)) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

const javascriptFiles = filesUnder(root, name => name.endsWith('.js'));
for (const file of javascriptFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${path.relative(root, file)} has invalid JavaScript:\n${result.stderr}`);
}

const html = fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8');
for (const reference of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
  const target = reference[1];
  if (/^(?:https?:|#|data:)/i.test(target)) continue;
  const file = target.startsWith('/')
    ? path.resolve(root, `.${target}`)
    : path.resolve(root, 'app', target);
  assert.ok(file.startsWith(path.join(root, 'app')), `Asset reference escapes app/: ${target}`);
  assert.ok(fs.existsSync(file), `Missing app asset: ${target}`);
}

console.log(`Source checks passed (${javascriptFiles.length} JavaScript files checked)`);
