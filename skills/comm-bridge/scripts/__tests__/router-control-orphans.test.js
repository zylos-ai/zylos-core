import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deferred, flush, routerFixture } from './helpers/router-fixture.js';

test('router sweeps abandoned controls while preserving active deliveries', async t => {
  const f = routerFixture(t);
  f.put('origin');
  const delivery = deferred();
  const deliver = f.deps.deliverControl;
  f.deps.deliverControl = async (...args) => {
    await delivery.promise;
    return deliver(...args);
  };
  const router = f.create();
  await router.initialize();
  await router.idle();

  const orphan = f.db.insertControl('abandoned', { sessionGroup: 'origin', appendAckSuffix: false });
  const active = f.db.insertControl('active', { sessionGroup: 'origin', appendAckSuffix: false });
  assert.equal(f.db.claimControl(orphan.id), true);
  try {
    router.tick();
    await flush();
    assert.equal(f.db.getControlById(active.id).status, 'running');

    router.tick();
    const expired = f.db.getControlById(orphan.id);
    assert.equal(expired.status, 'timeout');
    assert.equal(expired.last_error, 'ORPHAN_EXPIRED');
    assert.equal(f.db.getControlById(active.id).status, 'running');
    assert.deepEqual(f.events.filter(event => event.event === 'control_expired').map(event => event.control_id), [orphan.id]);
  } finally {
    delivery.resolve();
    await router.idle();
  }
  assert.equal(f.db.getControlById(active.id).status, 'done');
});
