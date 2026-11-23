import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {serviceRestartFixture} from './helpers/service-restart-fixture.js';
import {step11_startCoreServices, step12_verifyServices} from '../self-upgrade.js';

const require = createRequire(import.meta.url);
const maintenance = require('../upgrade-maintenance.cjs');
const warning = 'Service custom-service is not online; restart it manually.';

// Integration boundary: real restart/verification, finalization and recovery
// modules, with a lifecycle-owned fake PM2 executable under private PM2_HOME.
// Run for service membership, failure policy or warnings/result changes; skip
// unrelated features. The official runner isolates before imports; each fixture
// proves HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/TMUX_TMPDIR and uses no live DB/socket.
// Synchronous fake-PM2 children have 30s command deadlines; t.after reaps roots.
function fixture(t, options) {
  const f = serviceRestartFixture(t, options); f.custom();
  f.j.originalServices.reverse(); // A failed optional restart must not skip Core.
  assert.ok(Buffer.byteLength(path.join(f.env.TMPDIR, 'tmux.sock')) < 100);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) assert.ok(f.env[key].startsWith(f.root + path.sep));
  for (const file of ['comm-bridge/c4.db', 'scheduler/scheduler.db']) assert.ok(path.join(f.env.ZYLOS_DIR, file).startsWith(f.root + path.sep));
  return f;
}
function context(f) { return {journal:f.j, servicesWereRunning:f.j.originalServices.map(service => service.name)}; }
const poll = f => command => command.startsWith('sleep') ? '' : JSON.stringify(f.records());


for (const ecosystem of [true, false]) test(`ecosystem members and unknown ecosystem membership retain strict verification (${ecosystem})`, t => {
    const f = fixture(t, {ecosystem}); f.records([f.record('scheduler'), f.record('custom-service', 'online')]);
    let now = 0; const restore = Date.now; Date.now = () => (now += 40000);
    try { assert.throws(() => maintenance.verifyServices(f.j), /original services did not become online/); }
    finally { Date.now = restore; }
    assert.equal(f.j.originalServices.length, 2);
});

for (const fails of [false, true]) test(`upgrade keeps Core available and returns service warning only when needed (${fails ? 'unavailable' : 'online'})`, t => {
  const f = fixture(t); if (fails) f.fail('custom-service');
  const ctx = context(f);
  const started = step11_startCoreServices(ctx, {zylosDir:f.env.ZYLOS_DIR, ecosystemPath:f.file});
  assert.equal(started.status, 'done', JSON.stringify(started));
  assert.equal(f.records().find(item => item.name === 'scheduler').pm2_env.status, 'online');
  assert.equal(step12_verifyServices(ctx, {execSync:poll(f)}).status, 'done');
  assert.deepEqual(ctx.serviceWarnings, fails ? [warning] : []);
  assert.equal(ctx.servicesWereRunning.length, 2);
});
