import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelDownCounter } from '../src/lib/workbench/attention.js';
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
    [{ kind: 'data_unreadable', source: 'queue_summary_failed' }]);
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
test('channel service needs two PM2 samples and resets after online without page-driven increments', () => {
  const counter = createChannelDownCounter();
  const data = status => ({ processes: [{ name: 'zylos-telegram', pm2_env: { status } }], collectedAt: 1 });
  const instance = () => ({ services: { channels: [{ service: 'zylos-telegram', status: 'errored', down: counter.get('zylos-telegram') >= 2 }] } });
  counter.update(data('errored'));
  for (let i = 0; i < 3; i++) assert.deepEqual(groupAttention(instance(), {}, []).problems, []);
  counter.update(data('errored'));
  assert.deepEqual(groupAttention(instance(), {}, []).problems,
    [{ kind: 'channel_down', service: 'zylos-telegram', pm2Status: 'errored' }]);
  counter.update(data('online')); assert.equal(counter.get('zylos-telegram'), 0);
  assert.deepEqual(groupAttention(instance(), {}, []).problems, []);
});
test('page attention retains start failures and every distinct failed source', () => {
  const rows = [row('a', 'claude', { startFailed: { count: 3, lastAt: 5 }, unreadable: {
    reasons: ['status_unreadable', 'c4_groups_failed', 'queue_summary_failed', 'override_list_failed'] } })];
  const result = groupAttention({}, {}, rows);
  assert.equal(result.problems.length, 5); assert.equal(result.problems[0].count30m, 3);
  assert.equal(result.problems.filter(problem => problem.kind === 'data_unreadable').length, 4);
});
test('a service never observed in PM2 does not become a channel failure', () => {
  const counter = createChannelDownCounter();
  const online = { processes: [{ name: 'web-console', pm2_env: { status: 'online' } }] };
  counter.update(online); counter.update(online);
  assert.equal(counter.get('zylos-web-console'), 0);
});
test('an observed service disappearing from PM2 counts consecutive offline samples', () => {
  const counter = createChannelDownCounter(), missing = { processes: [] };
  counter.update({ processes: [{ name: 'zylos-telegram', pm2_env: { status: 'online' } }] });
  counter.update(missing); assert.equal(counter.get('zylos-telegram'), 1);
  counter.update(missing); assert.equal(counter.get('zylos-telegram'), 2);
  counter.update({ processes: [{ name: 'zylos-telegram', pm2_env: { status: 'online' } }] });
  assert.equal(counter.get('zylos-telegram'), 0);
  counter.update(missing); assert.equal(counter.get('zylos-telegram'), 1);
  counter.update(missing); assert.equal(counter.get('zylos-telegram'), 2);
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
