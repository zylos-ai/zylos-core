import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import { CoreLogImporter } from '../../src/lib/core-log-importer.js';
import { Store } from '../../src/lib/store.js';
import { SseHub } from '../../src/lib/sse.js';
import { VersionChecker } from '../../src/lib/version-checker.js';

const root = fs.realpathSync(process.env.ZYLOS_CHAT_CASE_ROOT);
for (const [key, leaf] of [['HOME', 'home'], ['ZYLOS_DIR', 'instance'], ['PM2_HOME', 'pm2'], ['TMPDIR', 'tmp']]) {
  assert.equal(fs.realpathSync(process.env[key]), path.join(root, leaf));
}
assert.equal(process.env.TMUX_TMPDIR, path.join(root, 'tmp'));
assert.equal(process.env.TMUX.split(',')[0], path.join(root, 'tmux.sock'));
const db = path.join(process.env.ZYLOS_DIR, 'comm-bridge/c4.db');
assert.equal(fs.realpathSync(db), db);
console.info('activity-poll child isolation', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
  PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, socket: path.join(root, 'tmux.sock'), db }));

// Serve the real Dashboard entry without starting model/runtime collectors.
// The real importer consumes its native private JSONL streams with its default
// interval and the same history_changed broadcast as the HTTP entry. This
// delegating spy only obtains that entry's real hub; no activity response or
// importer normalization/storage logic is substituted.
let hub;
const addClient = SseHub.prototype.addClient;
mock.method(SseHub.prototype, 'addClient', function (...args) { hub = this; return addClient.apply(this, args); });
mock.method(VersionChecker.prototype, 'start', () => {});
const { createServer } = await import('../../src/index.js');
const store = new Store(path.join(process.env.ZYLOS_DIR, 'components/dashboard/dashboard.db'));
let reportedStop = false;
const importer = new CoreLogImporter({ store, zylosDir: process.env.ZYLOS_DIR,
  onImport() {
    hub?.broadcast('history_changed', {});
    if (!reportedStop && store.db.prepare("SELECT 1 FROM runtime_events WHERE event_type='stop' AND source='core-log' LIMIT 1").get()) {
      reportedStop = true;
      console.info('activity-poll-stop-imported', JSON.stringify({ at: Date.now() }));
    }
  } });
await importer.poll();
importer.start();
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
console.info('activity-poll-server-ready', JSON.stringify({ origin: 'http://127.0.0.1:' + server.address().port }));
// Parent sandbox owns and awaits this entire process group on every exit path,
// closing the import loop, HTTP timers/transport and SQLite handles before root cleanup.
