import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import * as database from '../../c4-db.js';
import { createDispatcher } from '../../router/factory.js';
import { routerFixture, flush } from './router-fixture.js';

const paths = Object.fromEntries(['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR','TMUX_TMPDIR'].map(key => [key, process.env[key]]));
const realHome = os.userInfo().homedir;
for (const value of Object.values(paths)) assert.ok(value && !value.startsWith(realHome + '/') && value !== realHome);
assert.ok(paths.ZYLOS_DIR.startsWith(paths.HOME + '/'));
assert.ok(paths.PM2_HOME.startsWith(paths.HOME + '/'));
const socket = path.join(paths.TMUX_TMPDIR, 'tmux-1000', 'fixture');
assert.ok(Buffer.byteLength(socket) < 104);
assert.ok(database.getDb().name.startsWith(paths.ZYLOS_DIR + '/'));
console.log(JSON.stringify({ paths, socket, database: database.getDb().name }));

const cleanups = [];
const f = routerFixture({ after: callback => cleanups.push(callback) });
assert.equal(f.filename, ':memory:');
f.put('origin');
const row = f.add('a');
f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(row.id);
const control = f.db.recordRunEnd('a', { runId: 'old', reason: 'unexpected' }).continuationControlId;
const config = { runtime: 'claude', session_mode: 'multi', alert_target: 'telegram:fixture-owner' };
const logs = [];
const adapter = f.deps.getSessionAdapter;
const deps = { ...f.deps, env: process.env,
  readZylosConfigStrict: () => ({ state: 'ok', config }),
  diagnostics: { diagnostic: f.deps.diagnostic, maintain() {} },
  log: message => { if (logs.length < 20) logs.push(String(message)); },
  getSessionAdapter: runtime => ({ ...adapter(runtime), launch: async input => {
    f.calls.push(['launch', input]);
    throw Object.assign(Error('private launch detail'), { code: 'TRANSPORT_FAILURE' });
  } }),
};
delete deps.alert;
const { poolSize, ...options } = f.options;
const dispatcher = createDispatcher(deps, { ...options, delivery: { periodicEnabled: false } });
try {
  const rounds = async n => { for (let i = 0; i < n; i++) { dispatcher.tick(); await dispatcher.idle(); await flush(); } };
  await dispatcher.initialize(); await rounds(2);
  for (const ms of [5000,10000,20000,40000,60000]) { f.advance(ms); await rounds(3); }
  assert.equal(f.calls.filter(row => row[0] === 'launch').length, 5);
  assert.equal(f.db.getControlById(control).status, 'pending');
  const wanted = ['configured','destination_hangs'].includes(process.env.ALERT_TRANSPORT_MODE) ? 1 : 2;
  let delivered = false;
  for (let i = 0; i < 200; i++) {
    const records = fs.existsSync(process.env.ALERT_TRANSPORT_RECORDS)
      ? fs.readFileSync(process.env.ALERT_TRANSPORT_RECORDS, 'utf8').trim().split('\n').filter(Boolean) : [];
    assert.ok(records.length <= 2, 'Only one alert and its fallback are permitted');
    if (records.length === wanted) { delivered = true; break; }
    await delay(20);
  }
  assert.ok(delivered, `Default transport did not reach its channel: ${logs.join('; ')}`);
} finally {
  await dispatcher.stop();
  for (const cleanup of cleanups.reverse()) await cleanup();
  database.close();
}
console.log(JSON.stringify({ stoppedAt: Date.now(), databaseClosed: true }));
