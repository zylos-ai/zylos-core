import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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

for (const gate of ['legacy single', 'transition', 'global fence', 'group fence', 'live snapshot', 'old file']) {
  test(`reconciliation does not record through ${gate}`, async t => {
    const f = await runEndingFixture(t); await f.add(); f.now += 31000;
    if (gate === 'legacy single') {
      f.context.configuration = { mode: 'single', legacy: true };
      f.context.scenes = [];
      await f.write('origin');
    }
    if (gate === 'transition') f.service.db = { ...f.store, getModeTransition: () => ({ phase: 'gating' }) };
    if (gate === 'global fence') f.store.setDrainFence('*');
    if (gate === 'group fence') f.store.setDrainFence('test:a', { reason: 'upgrade', runId: 'r1' });
    if (gate === 'live snapshot') f.context.scenes.push({ sessionGroup: 'test:a', present: true, ready: false });
    if (gate === 'old file') f.service.db = { ...f.store, getLastCompletedModeTransition: () => ({ target_mode: 'multi', updated_at: f.now / 1000 }) };
    await f.step(); assert.equal(f.records().length, 0);
  });
}

test('fresh identity lookup follows current-session read and closes the snapshot-to-file race', async t => {
  const f = await runEndingFixture(t); await f.add('test:a', 'new-run'); f.now += 31000;
  const order = [], read = f.service.readFile;
  f.service.readFile = (...args) => { order.push('file'); return read(...args); };
  f.service.readIdentity = () => { order.push('tmux'); return { present: true, runId: 'new-run' }; };
  await f.step(); assert.equal(order[0], 'file'); assert.equal(order[1], 'tmux'); assert.equal(f.records().length, 0);
  f.service.readIdentity = () => ({ present: false }); await f.step();
  assert.equal(f.records()[0].runId, 'new-run');
});

test('an unavailable server does not block reconciliation on another server', async t => {
  const f = await runEndingFixture(t); await f.add('test:a'); await f.add('test:b'); f.now += 31000;
  f.hidden.add('test:a'); await f.step();
  assert.deepEqual(f.records().map(row => row.sessionGroup), ['test:b']);
  assert.deepEqual(f.fileReads, ['test:b']);
  assert.equal(f.slots().find(row => row.sessionGroup === 'test:a').state, 'running');
});

test('TTL records and live clear or compact sessions do not create another ending', async t => {
  const f = await runEndingFixture(t); await f.add();
  f.store.recordRunEnd('test:a', { runId: 'r1', reason: 'ttl' });
  for (let i = 0; i < 3; i++) await f.step();
  assert.equal(f.records()[0].reason, 'ttl'); assert.equal(f.store.listPendingContinuations().length, 0);
  f.context.scenes.push({ sessionGroup: 'test:a', present: true, runId: 'r2' });
  f.store.takeSlot('test:a', { runId: 'r2', k: 2 });
  for (let i = 0; i < 3; i++) { await f.write('test:a', 'r2', f.now + i); await f.step(); }
  assert.equal(f.records()[0].reason, 'ttl'); assert.equal(f.identityReads.length, 0);
});

test('five short unexpected runs alert while long and intentional runs reset the counter', async t => {
  const f = await runEndingFixture(t);
  for (let i = 1; i <= 6; i++) {
    if (i > 1) f.store.takeSlot('test:a', { runId: 'r' + i, k: 2 });
    else f.store.takeSlot('test:a', { runId: 'r1', k: 2 });
    await f.write('test:a', 'r' + i); await f.step();
    assert.equal(f.alerts.filter(event => event.event === 'repeated_unexpected_run_end').length, i < 5 ? 0 : 1);
  }
  assert.equal(f.service.shortRuns.get('test:a'), 6);
  f.store.takeSlot('test:a', { runId: 'intent', k: 2 });
  f.store.recordRunEnd('test:a', { runId: 'intent', reason: 'upgrade' });
  await f.write('test:a', 'intent');
  // A running row makes the intentionally ended identity a reconciliation candidate.
  f.db.prepare("UPDATE slot_occupancy SET state='running',held_until=NULL WHERE session_group='test:a'").run();
  await f.step(); assert.equal(f.service.shortRuns.has('test:a'), false);
  f.store.releaseSlot('test:a', { runId: 'intent', prior: null });
  f.store.takeSlot('test:a', { runId: 'long', k: 2 }); await f.write('test:a', 'long', f.now - 600000);
  await f.step(); assert.equal(f.service.shortRuns.has('test:a'), false);
});

test('session files are read afresh after invalid contents and become usable on the next round', async t => {
  const f = await runEndingFixture(t); await f.add(); f.now += 31000;
  await fs.writeFile(f.file('test:a'), '{'); await f.step(); await f.step();
  assert.equal(f.fileReads.length, 2); assert.equal(f.records().length, 0); assert.equal(f.slots().length, 1);
  await f.write(); await f.step(); assert.equal(f.records()[0].reason, 'unexpected'); assert.equal(f.slots()[0].state, 'held');
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

test('an invalid session timestamp starts failure grace and is never recorded as a real ending', async t => {
  const f = await runEndingFixture(t); await f.add(); f.now += 31000;
  await fs.writeFile(f.file('test:a'), JSON.stringify({ runId: 'r1', ts: 'invalid' }));
  await f.step(); assert.equal(f.slots().length, 1); assert.equal(f.service.failures.has('test:a'), true);
  await f.step(59000); assert.equal(f.slots().length, 1); assert.equal(f.failures().length, 0);
  await f.step(1000); assert.equal(f.slots().length, 0); assert.equal(f.records().length, 0);
  assert.equal(f.failures().length, 1); assert.equal(f.failures()[0].slot_deleted, true);
  assert.equal(f.failures()[0].session_group, 'test:a');
});

// Cross-module boundary: real completed-transition query feeds real reconciliation.
// Run for transition-history filters; no services or external resources are used.
test('native switches do not hide an Origin crash behind a newer completion time', async t => {
  const f = await runEndingFixture(t);
  await f.write('origin');
  const sessionTime = f.now / 1000;
  f.db.prepare(`INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,cutoff,created_at,updated_at)
    VALUES('old-conversion','single','multi','complete',0,?,?)`).run(sessionTime-20,sessionTime-10);
  f.db.prepare(`INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at)
    VALUES('new-switch','single','multi','complete',?,?)`).run(sessionTime+10,sessionTime+20);
  // A newer conversion to single also must not obscure the older multi conversion.
  f.db.prepare(`INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,cutoff,created_at,updated_at)
    VALUES('single-conversion','multi','single','complete',0,?,?)`).run(sessionTime+30,sessionTime+40);
  f.now += 60000; f.context.scenes=[];
  await f.step();
  assert.equal(f.records().find(row=>row.sessionGroup==='origin')?.continuationPending,1);
});

// Reconciliation must retain the multi-conversion boundary across later native
// completion. Real Store transitions, session file, occupancy and continuation query.
test('an ordinary group crash remains eligible after a later native switch completes', async t => {
  const f = await runEndingFixture(t);
  const conversion = f.store.beginModeTransition('single', 'multi', { kind: 'first_migration' });
  f.store.setDrainFence('*');
  f.store.absorbForTransition(conversion.runId);
  f.store.setModeTransitionPhase(conversion.runId, 'cutover');
  f.store.setModeTransitionPhase(conversion.runId, 'complete');
  const convertedAt = f.now;

  f.now += 10000;
  await f.add('test:a', 'crashed-run');
  // No live identity exists, but reconciliation has not observed the crash yet.
  assert.equal(f.records('test:a').length, 0);
  assert.equal(f.store.listPendingContinuations().length, 0);
  f.now += 10000;
  const native = f.store.beginModeTransition('single', 'multi', { kind: 'switch' });
  f.store.setDrainFence('*');
  f.store.setModeTransitionPhase(native.runId, 'cutover');
  const completed = f.store.setModeTransitionPhase(native.runId, 'complete');
  assert.equal(completed.kind, 'switch');
  assert.equal(completed.cutoff, null);
  assert.ok(completed.updated_at * 1000 > convertedAt);

  await f.step(31000);
  const ending = f.records('test:a')[0];
  assert.equal(ending?.runId, 'crashed-run');
  assert.equal(ending.reason, 'unexpected');
  assert.equal(ending.continuationPending, 1);
  assert.deepEqual(f.store.listPendingContinuations(), [{ sessionGroup: 'test:a', endedAt: ending.endedAt }]);
  assert.equal(f.slots().find(row => row.sessionGroup === 'test:a')?.state, 'held');
  assert.deepEqual(f.errors, []);
});
