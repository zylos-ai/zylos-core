import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import { VersionChecker } from '../../src/lib/version-checker.js';

// Real Dashboard HTTP entry, with unrelated outbound version discovery disabled.
// No model, runtime collector, PM2 service or tmux server is started.
const root = fs.realpathSync(process.env.ZYLOS_CHAT_CASE_ROOT);
for (const [key, leaf] of [['HOME', 'home'], ['ZYLOS_DIR', 'instance'], ['PM2_HOME', 'pm2'], ['TMPDIR', 'tmp']]) {
  assert.equal(fs.realpathSync(process.env[key]), path.join(root, leaf));
}
assert.equal(process.env.TMUX_TMPDIR, path.join(root, 'tmp'));
assert.equal(process.env.TMUX.split(',')[0], path.join(root, 'tmux.sock'));
const databases = ['comm-bridge/c4.db', 'components/dashboard/dashboard.db'].map(leaf => path.join(process.env.ZYLOS_DIR, leaf));
for (const filename of databases) assert.equal(fs.realpathSync(filename), filename);
console.info('markdown-emphasis child isolation', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
  PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, socket: path.join(root, 'tmux.sock'), databases }));
mock.method(VersionChecker.prototype, 'start', () => {});
const { createServer } = await import('../../src/index.js');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
console.info('markdown-emphasis-server-ready', JSON.stringify({ origin: 'http://127.0.0.1:' + server.address().port }));
// The parent sandbox stops and awaits this process group on success, failure
// and timeout, releasing HTTP timers and SQLite handles before root cleanup.
