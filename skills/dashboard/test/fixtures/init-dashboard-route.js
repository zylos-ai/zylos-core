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
  spawnSync(...args) {
    if (process.argv.includes('hook-failed')) return { status: 1, stderr: 'private-handoff-content' };
    if (process.argv.includes('handoff-failed')) return { status: 0, output: ['', '', '', 'private-handoff-content'] };
    return childProcess.spawnSync(...args);
  },
  execSync(command) {
    commands.push(command);
    if (command === 'pm2 jlist') return JSON.stringify([{ name: 'scheduler', pm2_env: { status: 'online' } }]);
    return '';
  },
} });
console.log('Init route worker isolation:', JSON.stringify(Object.fromEntries(
  ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR'].map(key => [key, process.env[key]]))));
const { startCoreServices, parseInitFlags } = await import('../../../../cli/commands/init.js');
const { printDashboardInfo } = await import('../../../../cli/lib/dashboard-access.js');
const flags = parseInitFlags(process.argv.slice(2).filter(arg => !['hook-failed', 'handoff-failed'].includes(arg)));
const access = { zylosDir: root, noCaddy: flags.caddy === false };
assert.equal(startCoreServices(null, access), 1);
assert.ok(commands.some(command => command.startsWith('pm2 start ')));
assert.ok(commands.includes('pm2 save'));
console.log('Init service phase finished.');
printDashboardInfo(access);
assert.equal(access.password, undefined);
