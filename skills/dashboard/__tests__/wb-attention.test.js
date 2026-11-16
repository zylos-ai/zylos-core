import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelRestartCounter } from '../src/lib/workbench/attention.js';
import { groupAttention } from '../public/js/wb/group-data.js';
const row = (sessionGroup, runtime, flags = {}) => ({ sessionGroup, runtime, flags });

test('request pause is a page reminder and disappears on recovery', () => {
  for (const supervisorPaused of [true, false, null, undefined, 'true']) {
    const result = groupAttention({ supervisorPaused }, {}, []);
    assert.deepEqual(result.problems, [], 'pause does not classify running sessions as failed');
    assert.deepEqual(result.reminders, supervisorPaused === true ? [{ kind: 'supervisor_paused' }] : []);
  }
});
test('page authentication attention includes affected groups without guessing unknown targets', () => {
  const rows = [row('running', 'codex', { blocked: { reason: 'auth_failed' } }),
    row('unknown-target', null, { queued: { count: 1 } }),
    row('unknown-queue', 'codex', { unreadable: { reasons: ['queue_summary_failed'] } })];
  const result = groupAttention({ runtimeHealth: { codex: { health: 'auth_failed' } } }, {}, rows);
  const auth = result.problems.filter(problem => problem.kind === 'auth_failed');
  assert.equal(auth.length, 1); assert.deepEqual(auth[0].groups, ['running']);
  assert.deepEqual(result.problems.filter(problem => problem.kind === 'data_unreadable'),
    [{ kind: 'data_unreadable', group: 'unknown-queue', displayName: 'unknown-queue', reasonCode: 'queue_summary_failed' }]);
});
test('page authentication includes blocked pending and starting rows but not quiet rows', () => {
  const result = groupAttention({ runtimeHealth: { claude: { health: 'auth_failed' } } }, {}, [
    row('pending', 'claude', { blocked: { reason: 'auth_failed' }, queued: { count: 2 } }),
    row('starting', 'claude', { blocked: { reason: 'auth_failed' } }), row('quiet', 'claude')]);
  assert.deepEqual(result.problems[0].groups, ['pending', 'starting']);
});
test('rate recovery is a page reminder and a clean sample has no reminder', () => {
  for (const health of ['rate_limited', 'recovering']) {
    const result = groupAttention({ runtimeHealth: { claude: { health, cooldownUntil: 42 } } }, {}, []);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.reminders, [{ kind: 'rate_limited', runtime: 'claude', until: 42 }]);
  }
  assert.deepEqual(groupAttention({}, {}, []), { problems: [], reminders: [] });
});
test('channel attention uses send failures and restart threshold independently of groups', () => {
  const channels = [{ channel: 'test', service: 'custom-service', status: 'online', lastSendFailed: true, consecutiveFailures: 3, restarts10m: 2 }];
  assert.deepEqual(groupAttention({ services: { channels } }, {}, []).problems,
    [{ kind: 'channel_send_failed', channel: 'test', count: 3 }]);
  channels[0].restarts10m = 3;
  assert.equal(groupAttention({ services: { channels } }, {}, []).problems[1].kind, 'channel_restarting');
  channels[0].lastSendFailed = false; channels[0].restarts10m = 0; channels[0].status = 'stopped';
  assert.equal(groupAttention({ services: { channels } }, {}, []).problems.length, 0);
});
test('page attention retains start failures and every distinct failed source', () => {
  const rows = [row('a', 'claude', { startFailed: { count: 3, lastAt: 5 }, unreadable: {
    reasons: ['status_unreadable', 'c4_groups_failed', 'queue_summary_failed', 'override_list_failed'] } })];
  const result = groupAttention({}, {}, rows);
  assert.equal(result.problems.length, 5); assert.equal(result.problems[0].count30m, 3);
  assert.equal(result.problems.filter(problem => problem.kind === 'data_unreadable').length, 4);
});
test('restart deltas start at zero and expire after ten minutes', () => {
  const counter = createChannelRestartCounter();
  const data = (at, restart_time) => ({ collectedAt: at, processes: [{ name: 'custom-service', pm2_env: { restart_time } }] });
  counter.update(data(1000, 12)); assert.equal(counter.get('custom-service', 1000), 0);
  counter.update(data(2000, 14)); assert.equal(counter.get('custom-service', 2000), 2);
  counter.update(data(3000, 15)); assert.equal(counter.get('custom-service', 3000), 3);
  counter.update(data(3000, 16)); assert.equal(counter.get('custom-service', 3000), 3);
  assert.equal(counter.get('custom-service', 602000), 1);
  assert.equal(counter.get('custom-service', 603000), 0);
  counter.update(data(604000, 0)); counter.update(data(605000, 1));
  assert.equal(counter.get('custom-service', 605000), 1);
  assert.equal(createChannelRestartCounter().get('custom-service', 605000), 0);
});
test('page full-pool reminder counts current offline waits rather than a sampled wait count', () => {
  const counts = { pool: { used: 4, capacity: 3, waiting: 99 }, offline: { waitingSlot: 2 } };
  const result = groupAttention({}, counts, []);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.reminders, [{ kind: 'pool_full', waiting: 2 }]);
  for (const pool of [{ used: null, capacity: 3 }, { used: 2, capacity: 3 }, { used: 3, capacity: null }]) {
    assert.deepEqual(groupAttention({}, { ...counts, pool }, []).reminders, []);
  }
  assert.deepEqual(groupAttention({}, { ...counts, offline: { waitingSlot: 0 } }, []).reminders, []);
});
