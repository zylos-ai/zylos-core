import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttention, createChannelDownCounter } from '../src/lib/workbench/attention.js';
const row = (sessionGroup, runtime, presence, queue = { pending: { count: 0 } }) => ({ sessionGroup, target: { runtime }, presence, queue });
const snapshot = (rows = [], runtimeHealth = {}) => ({ readAt: 10, rows, instance: { runtimeHealth }, sources: {} });
test('request pause is instance attention and disappears on recovery', () => {
  const snap = snapshot();
  for (const supervisorPaused of [true, false, null, undefined, 'true']) {
    snap.instance.supervisorPaused = supervisorPaused;
    assert.deepEqual(buildAttention(snap).problems, supervisorPaused === true ? [{ kind: 'supervisor_paused' }] : []);
  }
});
test('authentication attention distinguishes affected running groups from unknown targets or queues', () => {
  const result = buildAttention(snapshot([row('running', 'codex', 'running'), row('unknown-target', null, 'not_running', { pending: { count: 1 } }), row('unknown-queue', 'codex', 'not_running', { known: false })], { codex: { health: 'auth_failed' } }));
  assert.equal(result.problems.length, 1);assert.deepEqual(result.problems[0].groups, ['running']);assert.equal(result.problems[0].extraUnknown, 2);
});
test('authentication includes pending and starting groups but not absent empty queues', () => {
  const result = buildAttention(snapshot([row('pending', 'claude', 'not_running', { pending: { count: 2 } }), row('starting', 'claude', 'starting'), row('quiet', 'claude', 'not_running')], { claude: { health: 'auth_failed' } }));
  assert.deepEqual(result.problems[0].groups, ['pending', 'starting']);assert.equal(result.problems[0].extraUnknown, 0);
});
test('rate recovery is a reminder only and a clean sample reports ok without a sample time', () => {
  for (const health of ['rate_limited', 'recovering']) {
    const result = buildAttention(snapshot([], { claude: { health, cooldownUntil: 42 } }));
    assert.equal(result.problems.length, 0);assert.deepEqual(result.reminders, [{ kind: 'rate_limited', runtime: 'claude', until: 42 }]);assert.equal(result.ok, false);
  }
  assert.equal(buildAttention(snapshot()).ok, true);assert.equal(Object.hasOwn(buildAttention(snapshot()), 'sampledAt'), false);
});
test('channel service needs two PM2 samples and resets after online without snapshot-driven increments', () => {
  const counter = createChannelDownCounter(), snap = snapshot([{ ...row('a', 'claude', 'not_running'), c4: { componentName: 'telegram' } }]);
  const data = status => ({ processes: [{ name: 'zylos-telegram', pm2_env: { status } }], collectedAt: 1 });
  counter.update(data('errored'));
  for (let i = 0; i < 3; i++) assert.equal(buildAttention(snap, { channelDownCounter: counter, pm2Data: data('errored') }).problems.length, 0);
  counter.update(data('errored'));const result = buildAttention(snap, { channelDownCounter: counter, pm2Data: data('errored') });
  assert.equal(result.problems[0].kind, 'channel_down');assert.equal(result.problems[0].service, 'zylos-telegram');assert.equal(result.problems[0].pm2Status, 'errored');
  counter.update(data('online'));assert.equal(counter.get('zylos-telegram'), 0);assert.equal(buildAttention(snap, { channelDownCounter: counter }).ok, true);
});
test('start failures and every failed source become problems', () => {
  const snap = snapshot([{ ...row('a', 'claude', 'not_running'), wait: { kind: 'start_failed', count30m: 3, lastAt: 5 } }]);
  for (const [source, reason] of [['status', 'status_unreadable'], ['c4', 'c4_groups_failed'], ['q', 'queue_summary_failed'], ['ov', 'override_list_failed']]) snap.sources[source] = { ok: false, reason };
  const result = buildAttention(snap);assert.equal(result.problems.length, 5);assert.equal(result.problems[0].count30m, 3);
  assert.equal(result.problems.filter(problem => problem.kind === 'data_unreadable').length, 4);
});
test('a service never observed in PM2 does not become a channel failure', () => {
  const counter = createChannelDownCounter();
  const online = { processes: [{ name: 'web-console', pm2_env: { status: 'online' } }] };
  const snap = snapshot([{ ...row('a', 'claude', 'not_running'), c4: { componentName: 'web-console' } }]);
  counter.update(online); counter.update(online);
  assert.equal(counter.get('zylos-web-console'), 0);
  assert.equal(buildAttention(snap, { channelDownCounter: counter, pm2Data: online }).ok, true);
});
test('an observed service disappearing from PM2 counts consecutive offline samples', () => {
  const counter = createChannelDownCounter(), missing = { processes: [] };
  const snap = snapshot([{ ...row('a', 'claude', 'not_running'), c4: { componentName: 'telegram' } }]);
  const attention = () => buildAttention(snap, { channelDownCounter: counter, pm2Data: missing });
  counter.update({ processes: [{ name: 'zylos-telegram', pm2_env: { status: 'online' } }] });
  counter.update(missing); assert.equal(attention().ok, true);
  counter.update(missing);
  assert.deepEqual(attention().problems, [{ kind: 'channel_down', service: 'zylos-telegram', pm2Status: null }]);
  counter.update({ processes: [{ name: 'zylos-telegram', pm2_env: { status: 'online' } }] });
  assert.equal(attention().ok, true);
  counter.update(missing); assert.equal(attention().ok, true);
  counter.update(missing); assert.equal(attention().problems[0].kind, 'channel_down');
});

test('full pool produces one reminder counting current pool waits rather than sampled waiting', () => {
  const snap = snapshot([
    { ...row('b', 'claude', 'not_running'), wait: { kind: 'pool_wait', position: 1 } },
    { ...row('c', 'claude', 'not_running'), wait: { kind: 'pool_wait', position: 2 } },
    { ...row('auth', 'claude', 'not_running'), wait: { kind: 'auth_wait' } },
  ]);
  snap.instance.pool = { used: 4, capacity: 3, waiting: 99 };
  const result = buildAttention(snap);
  assert.equal(result.problems.length, 0);
  assert.deepEqual(result.reminders, [{ kind: 'pool_full', waiting: 2 }]);
  assert.equal(result.ok, false);
  for (const pool of [{ used: null, capacity: 3 }, { used: 2, capacity: 3 }, { used: 3, capacity: null }]) {
    snap.instance.pool = pool;
    assert.equal(buildAttention(snap).reminders.length, 0);
  }
  snap.instance.pool = { used: 3, capacity: 3, waiting: 99 };
  snap.rows = snap.rows.slice(2);
  assert.equal(buildAttention(snap).reminders.length, 0);
});
