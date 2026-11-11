import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import * as childProcess from 'node:child_process';

// Only command execution for dependency installation/PM2 is stubbed. The real
// init orchestration, post-install hook and Dashboard/Caddy route owners run.
const root = process.env.ZYLOS_DIR;
assert.equal(fs.realpathSync(root), root);
const commands = [];
mock.module('node:child_process', { namedExports: { ...childProcess,
  execFileSync(command, args, options) {
    if (command === 'pm2') {
      assert.deepEqual(args,['jlist']);
      return '[]';
    }
    if (args.some(arg => String(arg).endsWith('/dashboard/hooks/post-install.js')) && process.argv.includes('hook-failed')) throw new Error('fixture hook failure');
    return childProcess.execFileSync(command, args, options);
  },
  execSync(command) {
    commands.push(command);
    if (command === 'pm2 jlist') return JSON.stringify([{ name: 'scheduler', pm2_env: { status: 'online' } }]);
    return '';
  },
} });
console.log('Init route worker isolation:', JSON.stringify(Object.fromEntries(
  ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR'].map(key => [key, process.env[key]]))));
const { startServicesWithDashboard, parseInitFlags } = await import('../../../../cli/commands/init.js');
const { printDashboardInfo } = await import('../../../../cli/lib/dashboard-access.js');
const flags = parseInitFlags(process.argv.slice(2).filter(arg => !['hook-failed', 'provision-failed'].includes(arg)));
const { dashboardAccess: access, servicesStarted } = await startServicesWithDashboard(flags);
assert.equal(servicesStarted, 1);
assert.ok(commands.some(command => command.startsWith('pm2 start ')));
assert.ok(commands.includes('pm2 save'));
console.log('Init service phase finished.');
const secret = access.password;
const lines = [];
printDashboardInfo(access, line => { lines.push(line); console.log(line); });
if (flags.quiet && secret) assert.equal(lines.join('\n').includes(secret), false);
assert.equal(access.password, undefined);
if (flags.quiet) {
  const configPath = path.join(root, 'components/dashboard/config.json');
  const before = fs.readFileSync(configPath, 'utf8');
  const { dashboardAccess: repeat, servicesStarted: repeatedStarted } = await startServicesWithDashboard(flags);
  assert.equal(repeatedStarted, 1);
  assert.equal(repeat.password, null);
  const repeatedLines = [];
  printDashboardInfo(repeat, line => { repeatedLines.push(line); console.log(line); });
  assert.match(repeatedLines.join('\n'), /Password already configured/);
  assert.equal(repeatedLines.join('\n').includes(secret), false);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
}
