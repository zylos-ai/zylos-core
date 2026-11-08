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
  execSync(command) {
    commands.push(command);
    if (command === 'pm2 jlist') return JSON.stringify([{ name: 'scheduler', pm2_env: { status: 'online' } }]);
    return '';
  },
} });
console.log('Init route worker isolation:', JSON.stringify(Object.fromEntries(
  ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR'].map(key => [key, process.env[key]]))));
const { startCoreServices } = await import('../../../../cli/commands/init.js');
assert.equal(startCoreServices(), 1);
assert.ok(commands.some(command => command.startsWith('pm2 start ')));
assert.ok(commands.includes('pm2 save'));
