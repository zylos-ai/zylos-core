import test from 'node:test';
import assert from 'node:assert/strict';
import { observerPageUsable, observerRecoveryReason } from '../public/js/wb/observer-page.js';

const healthy = { state: 'installed', desired: { enabled: true } };

test('the observer page shows the live view only for a healthy observer reached with a key that may control it', () => {
  assert.equal(observerPageUsable(healthy, { readOnly: false }), true, 'an admin key opens the live view');
  assert.equal(observerPageUsable(healthy, { readOnly: true }), false, 'a read-only key shows the empty state');
  assert.equal(observerPageUsable(healthy), false, 'without being told the key may control it, the page stays read-only');
  assert.equal(observerPageUsable(healthy, {}), false);
});

test('a missing, disabled or broken observer never opens the live view', () => {
  assert.equal(observerPageUsable(null, { readOnly: false }), false);
  assert.equal(observerPageUsable({ state: 'not_installed' }, { readOnly: false }), false);
  assert.equal(observerPageUsable({ state: 'installed', desired: { enabled: false } }, { readOnly: false }), false);
  const broken = [
    { ...healthy, runtime: { state: 'blocked' } },
    { ...healthy, startupError: 'spawn_failed' },
    { state: 'installed', desired: { enabled: true, lastError: 'boom' } },
    { state: 'installed', desired: { enabled: true, removalState: 'removing' } },
    { state: 'installed', desired: { enabled: true, teardownFence: true } },
  ];
  for (const status of broken) {
    assert.ok(observerRecoveryReason(status), JSON.stringify(status));
    assert.equal(observerPageUsable(status, { readOnly: false }), false, JSON.stringify(status));
  }
  assert.equal(observerRecoveryReason({ ...healthy, runtime: { state: 'blocked', error: 'kill_failed' } }), 'kill_failed');
  assert.equal(observerRecoveryReason({ ...healthy, runtime: { state: 'blocked' } }), 'teardown_failed');
  assert.equal(observerRecoveryReason({ state: 'installed', desired: { enabled: false, teardownFence: true } }), null, 'a fence on a disabled observer is not a recovery case');
  assert.equal(observerRecoveryReason(healthy), null);
});
