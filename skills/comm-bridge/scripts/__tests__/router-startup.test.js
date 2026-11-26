import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionPoolBaseline } from '../../../../cli/lib/session-pool-config.js';
import { routerFixture } from './helpers/router-fixture.js';

test('pool baseline uses environment then file then memory, minimum one', () => {
  const hardware = { platform: 'darwin', totalMemoryBytes: 8 * 1024 ** 3 };
  assert.deepEqual(resolveSessionPoolBaseline({ ...hardware, env: {}, config: {} }), { k: 6, fixed: false });
  assert.equal(resolveSessionPoolBaseline({ ...hardware, env: { ZYLOS_SESSION_POOL_SIZE: '25' }, config: { session_pool_size: 3 } }).k, 25);
  for (const value of ['0', '-1', '1.5', 'bogus', true, null]) {
    assert.equal(resolveSessionPoolBaseline({ ...hardware, env: { ZYLOS_SESSION_POOL_SIZE: value }, config: { session_pool_size: 3 } }).k, 3);
    assert.equal(resolveSessionPoolBaseline({ ...hardware, env: {}, config: { session_pool_size: value } }).k, 6);
  }
  assert.equal(resolveSessionPoolBaseline({ platform: 'darwin', totalMemoryBytes: 1024 ** 3, env: {}, config: {} }).k, 1);
});

test('router startup expires only running controls without an ack deadline', async t => {
  const f = routerFixture(t);
  f.put('origin');
  const orphan = f.db.insertControl('startup prompt', { sessionGroup: 'origin', appendAckSuffix: false });
  const awaitingAck = f.db.insertControl('heartbeat', { sessionGroup: 'origin', ackDeadlineAt: f.now() / 1000 + 300 });
  assert.equal(f.db.claimControl(orphan.id), true);
  assert.equal(f.db.claimControl(awaitingAck.id), true);
  const heartbeatBefore = f.db.getControlById(awaitingAck.id);
  f.advance(1000);

  await f.create().initialize();

  const expired = f.db.getControlById(orphan.id);
  assert.equal(expired.status, 'timeout');
  assert.equal(expired.last_error, 'ORPHAN_EXPIRED');
  assert.equal(expired.updated_at, f.now() / 1000);
  assert.deepEqual(f.db.getControlById(awaitingAck.id), heartbeatBefore);
  assert.equal(f.db.countNonTerminalControls({ sessionGroup: 'origin' }).running, 1);
  const summary = f.events.find(event => event.event === 'orphan_recovery_summary');
  assert.deepEqual(summary.controlsExpired, { ids: [orphan.id], count: 1 });
});
