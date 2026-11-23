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
  assert.equal(f.row(row.id).status, 'delivered');
  assert.equal(f.db.listSlotOccupancy().length, 0);
});

test('single delivery uses Origin target and records Origin only after verified delivery', async t => {
  const f = deliveryFixture(t, { mode: 'single' });
  const row = f.message('telegram'); await f.delivery.deliverConversation(row);
  const saved = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(row.id);
  assert.equal(saved.status, 'delivered');
  assert.equal(saved.session_group, 'origin');
  assert.ok(f.calls.some(call => call[0] === 'paste' && call[1] === 'origin'));
  assert.ok(f.events.some(event => event.event === 'deliver' && event.session_group === 'origin'));
});
