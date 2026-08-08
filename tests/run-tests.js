const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const testFiles = fs.readdirSync(__dirname)
  .filter(file => file.endsWith('.test.js'))
  .sort()
  .map(file => path.join(__dirname, file));
const commands = [
  [process.execPath, ['tests/run-planner-policy.js']],
  [process.execPath, ['tests/run-planner-sync.js']],
  [process.execPath, ['--test', ...testFiles]]
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}
