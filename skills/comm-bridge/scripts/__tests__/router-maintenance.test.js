import test from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture, deferred, flush } from './helpers/router-fixture.js';
import { maintenanceSyncPrompt } from '../../../activity-monitor/scripts/maintenance-session.js';

const launches = f => f.calls.filter(row => row[0] === 'launch');
function requests(f, groups = ['a']) {
  const rows = new Map(groups.map(sessionGroup => [sessionGroup, { id: `sync-${sessionGroup}`, sessionGroup }]));
  const claims = [];
  let active = null;
  f.deps.listMaintenanceRequests = async () => [...rows.values()];
  f.deps.claimMaintenance = async (group, runId) => {
    if (active || !rows.has(group)) return null;
    active = { group, runId }; claims.push(active); rows.delete(group); return active;
  };
  f.deps.cancelMaintenance = async (group, runId) => {
    rows.delete(group);
    if (active?.group === group && (!runId || active.runId === runId)) active = null;
  };
  return { rows, claims, get active() { return active; } };
}

// Real router lanes/activation and private in-memory C4 slot transactions;
// provider launch is injected. Run for maintenance activation/capacity changes;
// unrelated prompts skip. Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR;
// no tmux, PM2, channel, live DB or runtime is contacted; fixture closes SQLite.
test('queued maintenance uses the normal pool slot and group runtime configuration', async t => {
  const f = routerFixture(t, { poolSize: 1 }); f.put('origin');
  const r = requests(f);
  f.db.resolveSessionLaunchConfig = () => ({ runtime: 'codex', model: 'private-model', effort: 'medium', mode: 'override' });
  const router = f.create(); await router.initialize(); await f.rounds(7);
  assert.equal(launches(f).length, 1);
  const input = launches(f)[0][1];
  assert.equal(input.sessionGroup, 'a'); assert.equal(input.launchConfig.runtime, 'codex');
  assert.equal(input.launchConfig.model, 'private-model'); assert.equal(r.claims[0].runId, input.runId);
  assert.equal(f.db.listSlotOccupancy().find(row => row.sessionGroup === 'a').runId, input.runId);
  assert.equal(f.calls.filter(row => row[0] === 'conversation').length, 0);
});

test('a full pool queues maintenance without stopping a session and new input wins', async t => {
  let capacity = 1;
  const f = routerFixture(t, { poolSize: () => capacity }); f.put('origin'); f.put('occupied');
  const r = requests(f);
  const router = f.create(); await router.initialize(); await f.rounds(5);
  assert.equal(launches(f).length, 0); assert.equal(r.claims.length, 0);
  assert.equal(f.calls.filter(row => row[0] === 'stop').length, 0);
  const row = f.add('a'); await f.rounds(3);
  assert.equal(r.rows.has('a'), false); assert.equal(f.row(row.id).status, 'pending');
  capacity = 2;
  await f.rounds(6);
  assert.equal(launches(f).length, 1); assert.equal(r.claims.length, 0);
  assert.equal(f.row(row.id).status, 'delivered');
});

test('concurrent maintenance candidates share the persistent global claim', async t => {
  const f = routerFixture(t, { poolSize: 3 }); f.put('origin'); const r = requests(f, ['a', 'b']);
  const router = f.create(); await router.initialize(); await f.rounds(7);
  assert.equal(r.claims.length, 1); assert.equal(launches(f).length, 1);
  assert.equal(f.db.listSlotOccupancy().length, 1);
});

for (const reason of ['ttl', 'delete']) test(`maintenance cannot launch through a ${reason} fence`, async t => {
  const f = routerFixture(t); f.put('origin'); const r = requests(f);
  if (reason === 'delete') f.db.beginGroupDeletion('a', { operationId: 'deleting-a', actor: 'fixture', cutoffId: 0 });
  else f.db.setDrainFence('a', { reason, runId: 'old-run' });
  const router = f.create(); await router.initialize(); await f.rounds(5);
  assert.equal(launches(f).length, 0); assert.equal(r.claims.length, 0);
});

test('single mode never reads or claims group maintenance', async t => {
  const f = routerFixture(t, { mode: 'single' }); f.put(null); requests(f);
  f.deps.listMaintenanceRequests = () => assert.fail('single mode must skip maintenance');
  const router = f.create(); await router.initialize(); await f.rounds(4);
  assert.equal(launches(f).length, 0);
});

test('Origin maintenance waits for pool capacity despite its normal resident exception', async t => {
  let capacity = 1;
  const f = routerFixture(t, { poolSize: () => capacity }); f.put('occupied');
  const r = requests(f, ['origin']);
  const router = f.create(); await router.initialize(); await f.rounds(5);
  assert.equal(launches(f).length, 0); assert.equal(r.claims.length, 0);
  capacity = 2; await f.rounds(5);
  assert.equal(launches(f).length, 1); assert.equal(launches(f)[0][1].sessionGroup, 'origin');
  assert.equal(r.claims.length, 1);
  assert.equal(f.db.listSlotOccupancy().some(row => row.sessionGroup === 'origin'), false);
});

test('a conversation arriving during maintenance launch converts the same run to ordinary work', async t => {
  const f = routerFixture(t); f.put('origin'); const r = requests(f);
  const hold = deferred(); const adapter = f.deps.getSessionAdapter;
  f.deps.getSessionAdapter = runtime => ({ ...adapter(runtime), launch: async input => {
    f.calls.push(['launch-pending', input]); await hold.promise; return adapter(runtime).launch(input);
  } });
  const router = f.create(); await router.initialize();
  for (let i = 0; i < 8 && !r.active; i++) { router.tick(); await flush(); }
  assert.ok(r.active); const runId = r.active.runId;
  const row = f.add('a'); hold.resolve(); await router.idle(); await f.rounds(5);
  assert.equal(r.active, null); assert.equal(launches(f).length, 1);
  assert.equal(launches(f)[0][1].runId, runId); assert.equal(f.row(row.id).status, 'delivered');
});

test('real input expires a pending maintenance startup control before delivery', async t => {
  const f = routerFixture(t); f.put('origin'); requests(f);
  const adapter = f.deps.getSessionAdapter;
  let startupId;
  f.deps.getSessionAdapter = runtime => ({ ...adapter(runtime), launch: async input => {
    await adapter(runtime).launch(input);
    const control = f.db.insertControl(maintenanceSyncPrompt, { sessionGroup: 'a', appendAckSuffix: true,
      ackDeadlineAt: Math.floor(f.now() / 1000) + 900 });
    startupId = control.id;
    f.current.get('a').startupControlIds = [control.id];
    f.add('a');
  } });
  const router = f.create(); await router.initialize(); await f.rounds(7);
  assert.equal(f.db.getControlById(startupId).status, 'timeout');
  assert.equal(f.calls.filter(row => row[0] === 'control').length, 0);
  assert.equal(f.calls.filter(row => row[0] === 'conversation').length, 1);
});
