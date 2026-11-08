import test from 'node:test';
import assert from 'node:assert/strict';
import { observerPageUsable, observerRecoveryReason, viewedAccess, runningObserverGroups, observerGroupRow, observerGroupName, switchObserverTarget } from '../public/js/wb/observer-page.js';

const healthy = { state: 'installed', desired: { enabled: true } };

test('the observer page shows the live view only for a healthy observer reached with a key that may control it', () => {
  assert.equal(observerPageUsable(healthy, { viewingRemote: false, access: 'read' }), true, 'this machine needs no remote key');
  assert.equal(observerPageUsable(healthy, { viewingRemote: true, access: 'admin' }), true, 'an admin key opens the live view');
  assert.equal(observerPageUsable(healthy, { viewingRemote: true, access: 'read' }), false, 'a read-only key shows the empty state');
  assert.equal(observerPageUsable(healthy, { viewingRemote: true }), false, 'an unknown access level counts as read-only');
  assert.equal(observerPageUsable(healthy, { access: 'read' }), false, 'without being told it is this machine, the view counts as remote');
  assert.equal(observerPageUsable(healthy), false);
});

test('a missing, disabled or broken observer never opens the live view', () => {
  assert.equal(observerPageUsable(null, { viewingRemote: false }), false);
  assert.equal(observerPageUsable({ state: 'not_installed' }, { viewingRemote: false }), false);
  assert.equal(observerPageUsable({ state: 'installed', desired: { enabled: false } }, { viewingRemote: false }), false);
  const broken = [
    { ...healthy, runtime: { state: 'blocked' } },
    { ...healthy, startupError: 'spawn_failed' },
    { state: 'installed', desired: { enabled: true, lastError: 'boom' } },
    { state: 'installed', desired: { enabled: true, removalState: 'removing' } },
    { state: 'installed', desired: { enabled: true, teardownFence: true } },
  ];
  for (const status of broken) {
    assert.ok(observerRecoveryReason(status), JSON.stringify(status));
    assert.equal(observerPageUsable(status, { viewingRemote: false }), false, JSON.stringify(status));
  }
  assert.equal(observerRecoveryReason({ ...healthy, runtime: { state: 'blocked', error: 'kill_failed' } }), 'kill_failed');
  assert.equal(observerRecoveryReason({ ...healthy, runtime: { state: 'blocked' } }), 'teardown_failed');
  assert.equal(observerRecoveryReason({ state: 'installed', desired: { enabled: false, teardownFence: true } }), null, 'a fence on a disabled observer is not a recovery case');
  assert.equal(observerRecoveryReason(healthy), null);
});

test('the viewed machine\'s access comes from its key: only an admin key may control a remote machine', () => {
  const fleetAgents = [{ name: 'eva', access: 'read' }, { name: 'lab', access: 'admin' }];
  assert.deepEqual(viewedAccess({ fleetAgents }), { viewingRemote: false, access: 'admin' }, 'this machine');
  assert.deepEqual(viewedAccess({ remoteAgent: 'eva', fleetAgents }), { viewingRemote: true, access: 'read' });
  assert.deepEqual(viewedAccess({ remoteAgent: 'lab', fleetAgents }), { viewingRemote: true, access: 'admin' });
  assert.deepEqual(viewedAccess({ remoteAgent: 'gone', fleetAgents }), { viewingRemote: true, access: 'read' }, 'an unknown machine counts as read-only');
  assert.deepEqual(viewedAccess({ pageRemoteAgent: 'eva', pageRemoteAccess: 'admin' }), { viewingRemote: true, access: 'admin' }, 'a page opened through another machine\'s address');
  assert.deepEqual(viewedAccess({ pageRemoteAgent: 'eva', pageRemoteAccess: 'other' }), { viewingRemote: true, access: 'read' });
  assert.deepEqual(viewedAccess({ remoteAgent: 'eva', fleetAgents, pageRemoteAgent: 'lab', pageRemoteAccess: 'admin' }), { viewingRemote: true, access: 'read' }, 'the machine chosen in the page wins');
  assert.equal(observerPageUsable(healthy, viewedAccess({ remoteAgent: 'eva', fleetAgents })), false, 'a read-only key shows the empty state');
  assert.equal(observerPageUsable(healthy, viewedAccess({ remoteAgent: 'lab', fleetAgents })), true);
  assert.equal(observerPageUsable(healthy, viewedAccess({ fleetAgents })), true);
});


test('the running group chooser counts actual live identities while Origin sleeps', () => {
  const snapshot = { rows: [
    { sessionGroup: 'origin', presence: 'not_running', live: null },
    { sessionGroup: 'telegram:alpha', presence: 'running', live: { runId: 'run-a' }, name: { displayName: 'Alpha' } },
    { sessionGroup: 'cron:daily', presence: 'running', live: { runId: 'run-b' } },
    { sessionGroup: 'telegram:pending', presence: 'starting', live: null },
    { sessionGroup: 'telegram:booting', presence: 'starting', live: { runId: 'booting-run' } },
    { sessionGroup: 'telegram:old', presence: 'not_running', live: { runId: 'old' } }
  ] };
  assert.equal(runningObserverGroups(snapshot).length, 2, 'starting sessions remain unavailable even after they receive a run identity');
  assert.equal(runningObserverGroups(snapshot).some(row => row.sessionGroup === 'telegram:booting'), false);
  assert.equal(runningObserverGroups(snapshot)[0].sessionGroup, 'telegram:alpha');
  assert.equal(observerGroupRow(snapshot, undefined), null, 'no selection does not default to Origin in multi');
  assert.equal(observerGroupRow(snapshot, 'origin').live, null, 'sleeping selection stays available for history');
  assert.equal(observerGroupName(observerGroupRow(snapshot, 'telegram:alpha'), 'telegram:alpha', 'Origin'), 'Alpha');
  assert.equal(observerGroupName(null, 'cron:daily', 'Origin'), 'cron:daily');
  assert.equal(observerGroupName(null, null, 'Origin'), 'Origin');
  assert.equal(runningObserverGroups(null).length, 0);
  assert.equal(observerGroupRow({ rows: [{ sessionGroup: null }] }, 'origin').sessionGroup, null, 'single uses the sole session');
});

test('choosing a group waits for the old viewer to disconnect and its lease to release', async () => {
  const observer = { selectionGeneration: 0 };
  const steps = [];
  let release;
  const change = switchObserverTarget(observer, {
    identity: () => 'local',
    disconnect: () => { steps.push('disconnect'); return new Promise(resolve => { release = resolve; }); },
    apply: () => steps.push('connect-next')
  });
  assert.equal(steps.join(','), 'disconnect');
  release();
  assert.equal(await change, true);
  assert.equal(steps.join(','), 'disconnect,connect-next');
});

test('a newer group choice or machine switch cancels an older pending choice', async () => {
  const observer = { selectionGeneration: 0 };
  let machine = 'local';
  let release;
  const connected = [];
  const old = switchObserverTarget(observer, {
    identity: () => machine, disconnect: () => new Promise(resolve => { release = resolve; }),
    apply: () => connected.push('old')
  });
  assert.equal(await switchObserverTarget(observer, {
    identity: () => machine, disconnect: async () => {}, apply: () => connected.push('new')
  }), true);
  release();
  assert.equal(await old, false);
  assert.equal(connected.join(','), 'new');
  const pending = switchObserverTarget(observer, {
    identity: () => machine, disconnect: () => new Promise(resolve => { release = resolve; }),
    apply: () => connected.push('wrong-machine')
  });
  machine = 'remote';
  release();
  assert.equal(await pending, false);
  assert.equal(connected.join(','), 'new');
});
