import test from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture, flush } from './helpers/router-fixture.js';

// Integration boundary: real Router and C4 store, injected scene/runtime I/O
// and clock. Run for ready-session adoption or capacity ordering changes; skip
// unrelated UI work. Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short
// TMPDIR; SQLite is private and no tmux, PM2, network or runtime is contacted.
// Router work is stopped by the fixture; every held launch is released in cleanup.
function ready(f, group, runId, values = {}) {
  const live = f.identity(group, { runId, ...values });
  f.scene.set(group, live);
  if (live.ready) f.current.set(group, { runId, sessionId: live.sessionId, startupControlIds: [], ts: f.now() });
  return live;
}
async function start(f, rounds = 2) {
  f.put('origin', { runtime: 'codex' });
  await f.create().initialize();
  await f.router.idle();
  await f.rounds(rounds);
}
function countAdoptions(f) {
  const adopt = f.db.adoptSlot;
  const calls = [];
  f.db.adoptSlot = (group, options) => { calls.push([group, options.runId]); return adopt(group, options); };
  return calls;
}
async function pump(count = 6) { for (let i = 0; i < count; i++) await flush(); }

test('ready sessions are adopted before an observed waiting group receives newly free capacity', async t => {
  const f = routerFixture(t, { poolSize: 1, readyTimeoutMs: 10000 });
  f.db.takeSlot('blocker', { runId: 'blocker-run', k: 1 });
  const waiting = f.add('waiting');
  ready(f, 'arrived', 'late-run', { ready: false });
  const adoptions = countAdoptions(f);
  await start(f);
  assert.equal(f.router.state.live.get('waiting').present, false);
  ready(f, 'arrived', 'late-run');
  f.router.tick(); await pump();
  assert.equal(f.router.state.live.get('arrived').ready, true);
  assert.equal(adoptions.length, 0, 'this round observed readiness after synchronous scheduling');
  assert.deepEqual(f.db.releaseSlot('blocker', { runId: 'blocker-run', prior: null }), { released: true });
  assert.equal(f.db.listSlotOccupancy().length, 0);
  f.router.tick();
  assert.deepEqual(adoptions, [['arrived', 'late-run']]);
  assert.equal(f.db.listSlotOccupancy().length, 1);
  assert.equal(f.router.availableCapacity(), 0);
  await f.router.idle(); await pump();
  assert.equal(f.calls.filter(row => row[0] === 'launch').length, 0);
  assert.equal(f.row(waiting.id).status, 'pending');
});

test('a stale ready observation cannot restore deleted occupancy and block queued recreation', async t => {
  const f = routerFixture(t, { poolSize: 1 });
  f.put('a', { runId: 'deleted-run' });
  const old = f.add('a');
  await start(f);
  assert.equal(f.row(old.id).status, 'delivered');
  const targetKey = JSON.stringify(['group', 'a']);
  f.db.beginGroupDeletion('a', { ...f.db.getDeletionPreviewBoundary(targetKey), operationId: 'delete-a', runId: 'deleted-run', actor: 'password:owner', preview: {} });
  f.db.recordRunEnd('a', { runId: 'deleted-run', reason: 'delete' });
  f.scene.delete('a'); f.current.delete('a');
  const deliver = f.deps.deliverConversation;
  f.deps.deliverConversation = async (row, live) => {
    // The terminal boundary rejects a target that vanished after observation.
    // Real delivery requeues this guarded send; keep that behavior in the seam.
    if (!f.scene.has('a')) { f.db.requeueConversation(row.id); return; }
    return deliver(row, live);
  };
  f.db.finalizeGroupDeletion('a', { operationId: 'delete-a' });
  const queued = f.add('a');
  assert.equal(f.db.listSlotOccupancy().length, 0);
  assert.equal(f.router.state.listed.has('a'), true);
  assert.equal(f.router.state.live.get('a').runId, 'deleted-run', 'Router still holds the pre-deletion observation');
  f.router.tick();
  assert.equal(f.db.listSlotOccupancy().length, 0, 'Synchronous adoption must reject the old observation before its async refresh');
  assert.equal(f.router.state.slots.has('a'), false);
  await f.router.idle(); await f.rounds(5);
  assert.equal(f.row(queued.id).status, 'delivered');
  assert.equal(f.calls.filter(row => row[0] === 'launch' && row[1].sessionGroup === 'a').length, 1);
  assert.notEqual(f.db.listSlotOccupancy()[0].runId, 'deleted-run');
});
