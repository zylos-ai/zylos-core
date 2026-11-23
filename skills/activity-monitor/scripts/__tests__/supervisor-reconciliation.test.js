import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runEndingFixture } from './helpers/run-ending-fixture.js';

// Integration boundary: real reconciliation/Store/SQLite and private current
// session files; scene, clock and failure boundaries are injected. Run when
// reconciliation candidates, failure grace or cleanup notifications change;
// skip unrelated UI. The official runner isolates HOME/ZYLOS_DIR/PM2_HOME and
// short TMPDIR. These fixtures create no tmux/runtime/network or child processes;
// test teardown closes the memory database and removes its owned temporary root.
const fail = message => Object.assign(new Error(message), { code: 'DB_BUSY' });

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

for (const failedRead of ['listDrainFences', 'listSlotOccupancy']) {
  test(`an initial ${failedRead} failure uses a global timer and never deletes unknown rows`, async t => {
    const f = await runEndingFixture(t); await f.add(); f.now += 31000;
    f.service.db = { ...f.store, [failedRead]() { throw fail(failedRead); } };
    await f.step(); await f.step(59000); assert.equal(f.failures().length, 0);
    await f.step(1000); assert.equal(f.slots().length, 1);
    assert.ok(f.failures().some(event => event.session_group === '*' && event.status === 'retained' && !event.slot_deleted));
  });
}

