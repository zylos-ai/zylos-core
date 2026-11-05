import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runEndingFixture } from './helpers/run-ending-fixture.js';

// Integration boundary: real reconciliation/Store/SQLite and private current
// session files; scene, clock and failure boundaries are injected. Run when
// reconciliation candidates, failure grace or cleanup notifications change;
// skip unrelated UI. The official runner isolates HOME/ZYLOS_DIR/PM2_HOME and
// short TMPDIR. These fixtures create no tmux/runtime/network or child processes;
// test teardown closes the memory database and removes its owned temporary root.
const fail = message => Object.assign(new Error(message), { code: 'DB_BUSY' });
async function failedWriteFixture(t) {
  const f = await runEndingFixture(t); await f.add(); f.now += 31000;
  f.service.db = { ...f.store, recordRunEnd() { throw fail('write unavailable'); } };
  return f;
}

for (const failure of ['listRunEndings', 'getLastCompletedModeTransition', 'recordRunEnd', 'file read', 'file parse']) {
  test(`a ${failure} failure retains occupancy until exactly sixty seconds`, async t => {
    const f = await runEndingFixture(t); await f.add(); f.now += 31000;
    if (failure === 'file read') f.service.readFile = async () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); };
    else if (failure === 'file parse') await fs.writeFile(f.file('test:a'), '{');
    else f.service.db = { ...f.store, [failure]() { throw fail(failure); } };
    await f.step(); assert.equal(f.slots()[0].state, 'running');
    await f.step(59000); assert.equal(f.slots().length, 1); assert.equal(f.failures().length, 0);
    assert.equal(f.store.takeSlot('test:a', { runId: 'blocked', k: 4 }).reason, 'own_running');
    await f.step(1000); assert.equal(f.slots().length, 0);
    assert.equal(f.failures().length, 1); assert.equal(f.failures()[0].session_group, 'test:a');
    assert.equal(f.failures()[0].slot_deleted, true); assert.equal(f.failures()[0].status, 'deleted');
    assert.equal(f.records().length, 0); assert.equal(f.store.listPendingContinuations().length, 0);
    await f.step(); assert.equal(f.failures().length, 1, 'deleted row stops being a candidate');
    assert.equal(f.store.takeSlot('test:a', { runId: 'new', k: 4 }).taken, true);
    f.service.db = f.store; f.service.readFile = f.deps.readFile; await f.write('test:a', 'r1'); await f.step();
    assert.equal(f.records().length, 0, 'old current-session identity cannot end the replacement row');
    assert.equal(f.slots()[0].runId, 'new');
  });
}

for (const failure of ['recordRunEnd', 'file read']) {
  test(`a transient ${failure} failure keeps a crashed run eligible for retained continuation`, async t => {
    const f = await runEndingFixture(t); await f.add(); f.now += 31000;
    let once = true;
    if (failure === 'file read') {
      const read = f.service.readFile;
      f.service.readFile = (...args) => { if (once) { once = false; throw new Error('once'); } return read(...args); };
    } else {
      f.service.db = { ...f.store, recordRunEnd(...args) { if (once) { once = false; throw new Error('once'); } return f.store.recordRunEnd(...args); } };
    }
    await f.step(); assert.equal(f.slots()[0].state, 'running');
    assert.equal(f.store.takeSlot('test:a', { runId: 'blocked', k: 2 }).reason, 'own_running');
    await f.step(); assert.equal(f.slots()[0].state, 'held'); assert.equal(f.store.listPendingContinuations().length, 1);
    assert.equal(f.failures().length, 0); assert.equal(f.store.takeSlot('test:a', { runId: 'next', k: 2 }).taken, true);
  });
}

test('candidate reads are bounded to running occupancy and Origin despite historical directories', async t => {
  let directoryReads = 0, stats = 0;
  const readdir = fs.readdir, stat = fs.stat;
  t.mock.method(fs, 'readdir', (...args) => { directoryReads++; return readdir(...args); });
  t.mock.method(fs, 'stat', (...args) => { stats++; return stat(...args); });
  const f = await runEndingFixture(t); await f.add(); await f.write('origin'); f.context.scenes = []; f.now += 31000;
  const base = path.dirname(f.file('test:a'));
  for (let i = 0; i < 1000; i++) {
    const file = path.join(path.dirname(base), 'history:' + i, 'current-session.json');
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify({ runId: 'history', ts: f.now }));
  }
  const requested = [], list = f.store.listRunEndings;
  f.service.db = { ...f.store, listRunEndings(groups) { requested.push([...groups].sort()); return list(groups); } };
  directoryReads = 0; stats = 0;
  await f.step();
  assert.equal(directoryReads, 0); assert.equal(stats, 0);
  assert.deepEqual(requested, [['origin', 'test:a']]);
  assert.deepEqual([...f.fileReads].sort(), ['origin', 'test:a']);
  assert.equal(f.records().length, 2); assert.equal(f.store.listPendingContinuations().length, 1);
});

test('one hundred live rounds do not query candidate records, current files or fresh identities', async t => {
  let directoryReads = 0, stats = 0;
  const readdir = fs.readdir, stat = fs.stat;
  t.mock.method(fs, 'readdir', (...args) => { directoryReads++; return readdir(...args); });
  t.mock.method(fs, 'stat', (...args) => { stats++; return stat(...args); });
  const f = await runEndingFixture(t); await f.add();
  f.context.scenes.push({ sessionGroup: 'test:a', present: true, runId: 'r1' });
  f.service.db = { ...f.store, listRunEndings() { assert.fail('no candidates'); } };
  const changes = f.db.prepare('SELECT total_changes() n').get().n;
  directoryReads = 0; stats = 0;
  for (let i = 0; i < 100; i++) await f.step();
  assert.equal(directoryReads, 0); assert.equal(stats, 0);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
  assert.equal(f.fileReads.length, 0); assert.equal(f.identityReads.length, 0); assert.equal(f.failures().length, 0);
});

test('a failure episode follows the row run identity and restarts for a later run', async t => {
  const f = await failedWriteFixture(t); await f.step(); await f.step(30000);
  f.service.db = f.store; await f.step(); assert.equal(f.slots()[0].state, 'held');
  f.store.takeSlot('test:a', { runId: 'r2', k: 2 }); await f.write('test:a', 'r2');
  f.service.db = { ...f.store, recordRunEnd() { throw fail('again'); } };
  await f.step(); await f.step(59000); assert.equal(f.slots()[0].runId, 'r2'); assert.equal(f.failures().length, 0);
  await f.step(1000); assert.equal(f.slots().length, 0); assert.equal(f.failures()[0].run_id, 'r2');
});

test('alternating record read and write failures share one sixty-second episode', async t => {
  const f = await failedWriteFixture(t); const read = f.store.listRunEndings;
  let unreadable = true;
  f.service.db = { ...f.service.db, listRunEndings(groups) { if (unreadable) throw fail('read'); return read(groups); } };
  await f.step(); unreadable = false; await f.step(30000); unreadable = true; await f.step(29000);
  assert.equal(f.slots().length, 1); assert.equal(f.failures().length, 0);
  unreadable = false; await f.step(1000); assert.equal(f.slots().length, 0); assert.equal(f.failures()[0].slot_deleted, true);
});

test('server unobservability and fences preserve the existing timer without starting a new one', async t => {
  const f = await failedWriteFixture(t); await f.step();
  f.hidden.add('test:a'); await f.step(30000); f.hidden.delete('test:a'); await f.step(29000);
  f.store.setDrainFence('test:a', { reason: 'upgrade', runId: 'r1' }); await f.step(1000);
  assert.equal(f.slots().length, 1, 'fenced row cannot be pruned at its failure deadline');
  f.store.clearDrainFence('test:a'); f.hidden.add('test:a'); await f.step(); assert.equal(f.slots().length, 1);
  f.hidden.delete('test:a'); await f.step(); assert.equal(f.slots().length, 0);
  assert.equal(f.failures().filter(event => event.slot_deleted).length, 1);
});

for (const skip of ['unobservable server', 'mode transition', 'global fence']) {
  test(`a stale present snapshot during ${skip} does not reset a running failure episode`, async t => {
    const f = await failedWriteFixture(t); await f.step();
    f.context.scenes.push({ sessionGroup: 'test:a', present: true, runId: 'r1' });
    if (skip === 'unobservable server') f.hidden.add('test:a');
    if (skip === 'mode transition') f.service.db.getModeTransition = () => ({ phase: 'gating' });
    if (skip === 'global fence') f.service.db.listDrainFences = () => [{ sessionGroup: '*' }];
    await f.step(30000);
    assert.equal(f.slots().length, 1); assert.equal(f.failures().length, 0);
    f.context.scenes = [{ sessionGroup: 'origin', present: true }];
    f.hidden.clear(); f.service.db.getModeTransition = f.store.getModeTransition;
    if (skip === 'global fence') f.service.db.listDrainFences = f.store.listDrainFences;
    await f.step(30000);
    assert.equal(f.slots().length, 0, 'the skipped round must preserve the original failure deadline');
    assert.equal(f.failures().length, 1);
    assert.equal(f.failures()[0].session_group, 'test:a');
    assert.equal(f.failures()[0].status, 'deleted');
    assert.equal(f.failures()[0].slot_deleted, true);
  });
}

test('read failures before a group disappears do not consume its later grace period', async t => {
  const f = await runEndingFixture(t); await f.add(); await f.write('origin'); f.now += 31000;
  f.context.scenes = [{ sessionGroup: 'test:a', present: true }];
  let failedReads = 0;
  f.service.db = { ...f.store, listRunEndings() { failedReads++; throw fail('read'); } };
  await f.step(); await f.step(300000); assert.equal(failedReads, 2);
  assert.equal(f.failures().filter(event => event.session_group === 'test:a').length, 0);
  f.context.scenes = []; await f.step();
  await f.step(59000); assert.equal(f.slots().length, 1);
  assert.equal(f.failures().filter(event => event.session_group === 'test:a').length, 0);
  await f.step(1000); assert.equal(f.slots().length, 0);
  assert.equal(f.failures().filter(event => event.session_group === 'test:a')[0].slot_deleted, true);
});

test('each failed run deletion sends its own unthrottled notification', async t => {
  const f = await failedWriteFixture(t);
  for (const runId of ['r1', 'r2']) {
    if (runId === 'r2') { f.store.takeSlot('test:a', { runId, k: 2 }); await f.write('test:a', runId); f.now += 31000; }
    await f.step(); await f.step(60000);
    assert.equal(f.slots().length, 0);
  }
  assert.deepEqual(f.failures().map(event => event.run_id), ['r1', 'r2']);
  assert.ok(f.failures().every(event => event.slot_deleted));
});

test('restarting the service restarts its in-memory grace clock', async t => {
  const f = await failedWriteFixture(t); f.deps.db = f.service.db;
  await f.step(); await f.step(59000); f.restart(); await f.step();
  await f.step(59000); assert.equal(f.slots().length, 1); assert.equal(f.failures().length, 0);
  await f.step(1000); assert.equal(f.slots().length, 0);
});

for (const fact of ['missing file', 'different run', 'recorded run', 'file before multi', 'live snapshot', 'fresh live']) {
  test(`${fact} clears an existing failure episode`, async t => {
    const f = await failedWriteFixture(t); await f.step(); await f.step(30000);
    if (fact === 'missing file') await fs.rm(f.file('test:a'));
    if (fact === 'different run') await f.write('test:a', 'other');
    if (fact === 'recorded run') f.store.recordRunEnd('test:a', { runId: 'r1', reason: 'unexpected' });
    if (fact === 'file before multi') f.service.db.getLastCompletedModeTransition = () => ({ target_mode: 'multi', updated_at: f.now / 1000 });
    if (fact === 'live snapshot') f.context.scenes.push({ sessionGroup: 'test:a', present: true });
    if (fact === 'fresh live') f.live.set('test:a', { present: true });
    await f.step();
    if (fact === 'recorded run') {
      f.store.takeSlot('test:a', { runId: 'r2', k: 2 }); await f.write('test:a', 'r2');
    } else {
      // The nonfailure conclusion can prune an old orphan. Reinsert its identity
      // only to verify that no stale failure deadline carries into a new episode.
      if (!f.slots().length) f.store.takeSlot('test:a', { runId: 'r1', k: 2 });
      await f.write(); f.context.scenes = [{ sessionGroup: 'origin', present: true }]; f.live.clear();
      f.service.db.getLastCompletedModeTransition = f.store.getLastCompletedModeTransition;
    }
    await f.step(); await f.step(31000);
    assert.equal(f.slots().length, 1, 'the old failure time must not expire this new episode');
  });
}

for (const failure of ['pruneSlots', 'cleanup occupancy read', 'cleanup fences read']) {
  test(`${failure} failure retains the row and throttles retained notices until actual deletion`, async t => {
    const f = await failedWriteFixture(t); const broken = { ...f.service.db };
    if (failure === 'pruneSlots') broken.pruneSlots = () => { throw fail('prune'); };
    if (failure === 'cleanup occupancy read') {
      let reads = 0; broken.listSlotOccupancy = () => { if (++reads % 2 === 0) throw fail('cleanup slots'); return f.store.listSlotOccupancy(); };
    }
    if (failure === 'cleanup fences read') {
      let reads = 0; broken.listDrainFences = () => { if (++reads % 2 === 0) throw fail('cleanup fences'); return f.store.listDrainFences(); };
    }
    f.service.db = broken;
    await f.step(); await f.step(60000); assert.equal(f.slots().length, 1);
    assert.ok(f.failures().some(event => event.status === 'retained' && event.slot_deleted === false));
    const count = f.failures().length; await f.step(1000); assert.equal(f.failures().length, count);
    f.service.db = { ...f.store, recordRunEnd() { throw fail('write'); } };
    await f.step(); assert.equal(f.slots().length, 0);
    assert.equal(f.failures().at(-1).status, 'deleted');
  });
}

test('cleanup reports only the failed row actually deleted after another row is adopted', async t => {
  const f = await failedWriteFixture(t); await f.add('test:b');
  const prune = f.store.pruneSlots; let race = false;
  f.service.db.pruneSlots = options => {
    if (race) { f.store.adoptSlot('test:a', { runId: 'new-a' }); race = false; }
    return prune(options);
  };
  await f.step(); race = true; await f.step(60000);
  assert.deepEqual(f.slots().map(row => [row.sessionGroup, row.runId]), [['test:a', 'new-a']]);
  assert.deepEqual(f.failures().filter(event => event.slot_deleted).map(event => event.session_group), ['test:b']);
  assert.equal(f.service.failures.has('test:a'), false, 'adopted identity ends the old failure episode');
  assert.equal(f.failures().some(event => event.session_group === 'test:a'), false, 'do not report obsolete occupancy as retained');
});

test('Origin read failures notify without a slot and recover into one continuation', async t => {
  const f = await runEndingFixture(t); await f.write('origin'); f.context.scenes = [];
  f.service.db = { ...f.store, listRunEndings() { throw fail('read'); } };
  await f.step(); await f.step(59000); assert.equal(f.failures().length, 0);
  await f.step(1000); assert.equal(f.failures().length, 1);
  assert.equal(f.failures()[0].session_group, 'origin'); assert.equal(f.failures()[0].status, 'no_slot');
  await f.step(1799999); assert.equal(f.failures().length, 1);
  await f.step(1); assert.equal(f.failures().length, 2);
  f.service.db = f.store; await f.step(); assert.equal(f.records('origin')[0].reason, 'unexpected');
  assert.equal(f.db.prepare("SELECT count(*) n FROM control_queue WHERE session_group='origin' AND status='pending'").get().n, 1);
});

for (const failedRead of ['listDrainFences', 'listSlotOccupancy']) {
  test(`an initial ${failedRead} failure uses a global timer and never deletes unknown rows`, async t => {
    const f = await runEndingFixture(t); await f.add(); f.now += 31000;
    f.service.db = { ...f.store, [failedRead]() { throw fail(failedRead); } };
    await f.step(); await f.step(59000); assert.equal(f.failures().length, 0);
    await f.step(1000); assert.equal(f.slots().length, 1);
    assert.ok(f.failures().some(event => event.session_group === '*' && event.status === 'retained' && !event.slot_deleted));
  });
}

test('pre-reconciliation read failures share the global timer and reset after recovery', async t => {
  const f = await runEndingFixture(t);
  f.service.reportReadFailure(fail('mode')); f.now += 30000; f.service.reportReadFailure(fail('fences'));
  f.now += 29999; f.service.reportReadFailure(fail('mode')); await Promise.resolve(); assert.equal(f.failures().length, 0);
  f.now++; f.service.reportReadFailure(fail('mode')); await Promise.resolve(); assert.equal(f.failures().length, 1);
  assert.equal(f.failures()[0].status, 'retained');
  await f.step(); assert.equal(f.service.globalFailure, null);
  f.now += 60000; f.service.reportReadFailure(fail('again')); await Promise.resolve();
  assert.equal(f.service.globalFailure.since, f.now);
  assert.equal(f.failures().length, 1, 'a recovered round starts a new episode');
});


for (const readAt of ['before reconciliation', 'before cleanup']) {
  test(`unreadable fences ${readAt} still allow expired held rows to be physically pruned`, async t => {
    const f = await runEndingFixture(t); await f.add();
    f.store.recordRunEnd('test:a', { runId: 'r1', reason: 'upgrade' });
    f.now += 120000; f.store.takeSlot('test:b', { runId: 'unseen-b', k: 4 });
    let reads = 0;
    f.service.db = { ...f.store, listDrainFences() {
      reads++;
      if (readAt === 'before reconciliation' || reads % 2 === 0) throw fail('fences unreadable');
      return [];
    } };
    await f.step();
    assert.equal(f.db.prepare("SELECT count(*) n FROM slot_occupancy WHERE session_group='test:a'").get().n, 0);
    assert.equal(f.slots().length, 1); assert.equal(f.slots()[0].runId, 'unseen-b');
    assert.equal(f.records('test:a')[0].reason, 'upgrade');
    assert.ok(f.errors.some(error => error.message === 'fences unreadable'));
  });
}

test('a direct transition read failure retains a candidate until its grace deadline, then notifies its deletion', async t => {
  const f = await runEndingFixture(t); await f.add(); f.now += 31000;
  f.service.db = { ...f.store, getModeTransition() { throw fail('transition unreadable'); } };
  await f.step(); assert.equal(f.slots().length, 1);
  await f.step(59000); assert.equal(f.slots().length, 1); assert.equal(f.failures().length, 0);
  await f.step(1000); assert.equal(f.slots().length, 0);
  const deleted = f.failures().filter(event => event.slot_deleted);
  assert.equal(deleted.length, 1); assert.equal(deleted[0].session_group, 'test:a');
});

test('a vanished running row clears its failure clock without a no-slot notification', async t => {
  const f = await failedWriteFixture(t); await f.step();
  assert.equal(f.service.failures.has('test:a'), true);
  assert.deepEqual(f.store.releaseSlot('test:a', { runId: 'r1', prior: null }), { released: true });
  await f.step(60000);
  assert.equal(f.service.failures.has('test:a'), false);
  assert.equal(f.failures().length, 0); assert.equal(f.records().length, 0);
});
