import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.PM2_TEST_ROOT;
for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'PATH']) {
  assert.ok(process.env[key].startsWith(root + path.sep), key);
}
console.log('Startup child isolation:', JSON.stringify(Object.fromEntries(
  ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'PATH'].map(key => [key, process.env[key]]))));
const dir = process.env.ZYLOS_DIR;
fs.mkdirSync(path.join(dir, '.claude', 'skills'), { recursive: true });
const ecosystem = path.join(dir, 'pm2', 'ecosystem.config.cjs');
fs.mkdirSync(path.dirname(ecosystem), { recursive: true });
if (process.argv[2] === 'fallback') {
  const script = path.join(dir, '.claude', 'skills', 'scheduler', 'scheduler.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '');
} else fs.writeFileSync(ecosystem, 'module.exports={apps:[]};');

if (process.argv[2] === 'init') {
  const { startCoreServices } = await import('../../cli/commands/init.js');
  await startCoreServices({ noCaddy: true });
} else {
  const { startServices } = await import('../../cli/commands/service.js');
  startServices();
}
