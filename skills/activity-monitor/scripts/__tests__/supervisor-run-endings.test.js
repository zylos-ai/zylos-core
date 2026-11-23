import test from 'node:test';
import assert from 'node:assert/strict';
import { runEndingFixture } from './helpers/run-ending-fixture.js';

// Integration boundary: real reconciliation and Store transactions with injected
// scene observations and clock. Run for run-ending/occupancy wiring changes;
// skip unrelated UI. Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR.
// Fixture owns its root and memory SQLite, creates no tmux/runtime/network or
// subprocesses, and closes/removes its resources through test teardown.
test('first reconciliation after restart records each missing run exactly once without a file cache', async t => {
  const f = await runEndingFixture(t); await f.add(); await f.write('origin'); f.context.scenes = [];
  f.now += 31000; await f.step();
  assert.deepEqual(f.records().map(row => row.sessionGroup), ['origin', 'test:a']);
  assert.ok(f.records().every(row => row.reason === 'unexpected' && row.continuationPending === 1));
  assert.equal(f.db.prepare('SELECT count(*) n FROM control_queue').get().n, 0);
  const writes = f.db.prepare('SELECT total_changes() n').get().n;
  const reads = f.fileReads.length, fresh = f.identityReads.length;
  for (let i = 0; i < 3; i++) await f.step();
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, writes);
  assert.equal(f.fileReads.length, reads + 3, 'absent Origin is reread, held ordinary group is no longer a candidate');
  assert.equal(f.identityReads.length, fresh);
  f.restart(); await f.step(); assert.equal(f.records().length, 2);
});

test('an identity read exception never becomes evidence that a running slot is absent', async t => {
  const f = await runEndingFixture(t); await f.add(); f.now += 31000;
  let reads = 0;
  f.service.readIdentity = () => { reads++; throw Object.assign(new Error('tmux timed out'), { code: 'TMUX_TIMEOUT' }); };
  await f.step(); await f.step(60000);
  assert.ok(reads > 0); assert.equal(f.records().length, 0);
  assert.equal(f.slots().length, 1); assert.equal(f.slots()[0].state, 'running');
  assert.equal(f.failures().length, 0);
});

