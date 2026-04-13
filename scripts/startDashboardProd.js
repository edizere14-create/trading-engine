const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.cwd();
const buildIdPath = path.join(root, 'dashboard', '.next', 'BUILD_ID');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

if (!fs.existsSync(buildIdPath)) {
  console.log('[dashboard] Missing production build. Running build:dashboard...');
  run('npm', ['run', 'build:dashboard']);
}

console.log('[dashboard] Starting Next production server...');
run('npx', ['next', 'start', 'dashboard', '--port', '3000']);
