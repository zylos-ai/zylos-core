#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const { TEST_REAL_TMUX, TEST_PRIVATE_SOCKET, TEST_TMUX_TRACE } = process.env;
assert.ok(TEST_REAL_TMUX && TEST_PRIVATE_SOCKET && TEST_TMUX_TRACE);
const args = process.argv.slice(2);
assert.ok(!args.includes('-S') || args[args.indexOf('-S') + 1] === TEST_PRIVATE_SOCKET);
assert.ok(!args.includes('-L'), 'Named sockets are not permitted in this fixture');
const argv = args.includes('-S') ? args : ['-S', TEST_PRIVATE_SOCKET, ...args];
assert.ok(fs.statSync(TEST_TMUX_TRACE).size < 4 * 1024 * 1024, 'Trace exceeded fixture bound');
fs.appendFileSync(TEST_TMUX_TRACE, JSON.stringify({ at: Date.now(), argv }) + '\n');
const result = spawnSync(TEST_REAL_TMUX, argv, { stdio: 'inherit', timeout: 10000 });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
