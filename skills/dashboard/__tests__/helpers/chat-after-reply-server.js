import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import { VersionChecker } from '../../src/lib/version-checker.js';

// Serve the full, unmodified app and HTTP routes. Only unrelated outbound
// version discovery is disabled. No runtime/model/collector is started.
const root = fs.realpathSync(process.env.ZYLOS_CHAT_CASE_ROOT);
for (const [key, leaf] of [['HOME', 'home'], ['ZYLOS_DIR', 'instance'], ['PM2_HOME', 'pm2'], ['TMPDIR', 'tmp']]) {
  assert.equal(fs.realpathSync(process.env[key]), path.join(root, leaf));
}
assert.equal(process.env.TMUX_TMPDIR, path.join(root, 'tmp'));
assert.equal(process.env.TMUX.split(',')[0], path.join(root, 'tmux.sock'));
const db = path.join(process.env.ZYLOS_DIR, 'comm-bridge/c4.db');
assert.equal(fs.realpathSync(db), db);
console.info('after-reply child isolation', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
  PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, socket: path.join(root, 'tmux.sock'), db }));
mock.method(VersionChecker.prototype, 'start', () => {});
const { createServer } = await import('../../src/index.js');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
console.info('after-reply-server-ready', JSON.stringify({ origin: 'http://127.0.0.1:' + server.address().port }));
// The case sandbox stops and awaits the process group on every exit path,
// releasing the entry's timers, transport and database handles before cleanup.
