import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { mock } from 'node:test';
import { VersionChecker } from '../../src/lib/version-checker.js';
import { SseHub } from '../../src/lib/sse.js';

// This process imports the real HTTP entry and serves the unmodified full app.
// Observe the real hub through a delegating method spy; only the unrelated
// version-network poller is disabled. Collectors/PM2/tmux/model are not started.
const root = fs.realpathSync(process.env.ZYLOS_CHAT_CASE_ROOT);
for (const [key, leaf] of [['HOME', 'home'], ['ZYLOS_DIR', 'instance'], ['PM2_HOME', 'pm2'], ['TMPDIR', 'tmp']]) {
  assert.equal(fs.realpathSync(process.env[key]), path.join(root, leaf));
}
assert.equal(process.env.TMUX_TMPDIR, path.join(root, 'tmp'));
assert.equal(process.env.ZYLOS_CHAT_TMUX_SOCKET, path.join(root, 'tmux.sock'));
assert.equal(process.env.TMUX.split(',')[0], path.join(root, 'tmux.sock'));
const db = path.join(process.env.ZYLOS_DIR, 'comm-bridge/c4.db');
assert.equal(fs.realpathSync(db), db);
console.info('full dashboard child isolation', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
  PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, socket: path.join(root, 'tmux.sock'), db }));
mock.method(VersionChecker.prototype, 'start', () => {});
let hub;
const addClient = SseHub.prototype.addClient;
mock.method(SseHub.prototype, 'addClient', function (...args) { hub = this; return addClient.apply(this, args); });
const { createServer } = await import('../../src/index.js');
const server = createServer();
let streams = 0;
server.prependListener('request', req => { if (new URL(req.url, 'http://127.0.0.1').pathname === '/api/stream') streams++; });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
console.info('recovery-server-ready', JSON.stringify({ origin: 'http://127.0.0.1:' + server.address().port }));
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  if (line.length > 1024) process.exit(1);
  const command = JSON.parse(line);
  if (command.action === 'ordinary') hub?.broadcast('health_update', { marker: 'private-recovery-health' });
  console.info('recovery-server-result', JSON.stringify({ id: command.id, streams, active: hub?.clients.size ?? 0 }));
});
// The sandbox kills and awaits this entire child process group on success,
// failure or timeout, including timers and SQLite handles owned by the entry.
