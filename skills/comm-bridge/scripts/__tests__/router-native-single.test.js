import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture } from './helpers/router-fixture.js';
import { deliveryFixture } from './helpers/session-delivery-fixture.js';

// Real scheduler/store and delivery policy; runtime and terminal I/O are fixtures.
// The repository runner supplies isolated HOME/ZYLOS_DIR; no service is started.
test('keyed single sleeps without demand, then starts only Origin for other-group inbound', async t => {
  const f = routerFixture(t, { mode: 'single' });
  f.db.setSessionRuntimeConfig({ sessionGroup: 'origin', runtime: 'codex' });
  f.db.setSessionModelConfig({ sessionGroup: 'origin', runtime: 'codex', model: 'origin-model', effort: 'high' });
  const router = f.create(); await router.initialize(); await router.idle();
  f.advance(6000); await f.rounds(2);
  assert.deepEqual([...router.state.lanes.keys()], ['origin']);
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  const row = f.add('other');
  f.db.setSessionRuntimeConfig({ sessionGroup: 'other', runtime: 'agy' });
  await f.rounds(4);
  const launch = f.calls.find(call => call[0] === 'launch')?.[1];
  assert.ok(launch, JSON.stringify(f.events));
  assert.equal(launch.sessionGroup, 'origin'); assert.equal(launch.sessionMode, 'single');
  assert.deepEqual(launch.launchConfig, { runtime: 'codex', mode: 'override', model: 'origin-model', effort: 'high' });
  assert.equal(f.calls.some(call => call[0] === 'prepare'), false);
  assert.equal(f.row(row.id).status, 'delivered');
  assert.equal(f.db.listSlotOccupancy().length, 0);
});

test('keyed single selects Origin controls and alerts for NULL and other-group controls', async t => {
  const f = routerFixture(t, { mode: 'single' }); f.put('origin');
  const origin = f.db.insertControl('origin work', { sessionGroup: 'origin', appendAckSuffix: false });
  const other = f.db.insertControl('other work', { sessionGroup: 'other', appendAckSuffix: false });
  const machine = f.db.insertControl('old machine work', { sessionGroup: 'other', appendAckSuffix: false });
  f.sqlite.prepare('UPDATE control_queue SET session_group=NULL WHERE id=?').run(machine.id);
  await f.create().initialize(); await f.rounds(3);
  assert.equal(f.db.getControlById(origin.id).status, 'done');
  assert.equal(f.db.getControlById(other.id).status, 'pending');
  assert.equal(f.db.getControlById(machine.id).status, 'pending');
  assert.ok(f.events.some(event => event.event === 'mode_mismatch' && event.count === 2));
});

test('Origin fence holds all single-mode inbound and prevents demand startup', async t => {
  const f = routerFixture(t, { mode: 'single' }); const row = f.add('other');
  f.db.setDrainFence('origin', { reason: 'ttl', runId: 'old-run' }); await f.create().initialize(); await f.router.idle();
  f.advance(10000); await f.rounds(3);
  assert.equal(f.row(row.id).status, 'pending');
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  f.db.clearDrainFence('origin'); await f.rounds(4);
  assert.equal(f.row(row.id).status, 'delivered');
});

test('single delivery uses Origin target and records Origin only after verified delivery', async t => {
  for (const keyPresent of [true, false]) await t.test(String(keyPresent), async t => {
    const f = deliveryFixture(t, { mode: 'single', keyPresent });
    const row = f.message('telegram'); await f.delivery.deliverConversation(row);
    const saved = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(row.id);
    assert.equal(saved.status, 'delivered');
    assert.equal(saved.session_group, keyPresent ? 'origin' : 'telegram');
    assert.ok(f.calls.some(call => call[0] === 'paste' && call[1] === (keyPresent ? 'origin' : null)));
    assert.ok(f.events.some(event => event.event === 'deliver' && event.session_group === (keyPresent ? 'origin' : null)));
  });
});

test('health-blocked single delivery retains source attribution and pending status', async t => {
  const f = deliveryFixture(t, { mode: 'single', health: 'auth_failed' });
  const row = f.message('telegram'); const result = await f.delivery.deliverConversation(row);
  const saved = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(row.id);
  assert.equal(result.blocked, true); assert.equal(saved.status, 'pending');
  assert.equal(saved.session_group, 'telegram'); assert.equal(saved.retry_count, 0);
  assert.equal(f.calls.some(call => call[0] === 'paste'), false);
});

for (const health of ['auth_failed', 'rate_limited']) test(`single Origin demand respects ${health} startup gating`, async t => {
  const f = routerFixture(t, { mode: 'single' }); f.health.set('claude', { health });
  const row = f.add('other');
  if (health === 'rate_limited') f.deps.submit = async () => ({ kind: 'accepted', sent: true, reply: { ok: true, result: 'rejected', reason: 'cooldown' } });
  await f.create().initialize(); await f.router.idle(); f.advance(6000); await f.rounds(3);
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  assert.equal(f.row(row.id).status, 'pending'); assert.equal(f.router.state.resident.failures, 0);
});
