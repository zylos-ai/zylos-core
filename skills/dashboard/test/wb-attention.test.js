import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttention, createChannelDownCounter } from '../src/lib/workbench/attention.js';
const row = (sessionGroup, runtime, presence, queue = { pending: { count: 0 } }) => ({ sessionGroup, target: { runtime }, presence, queue });
const snapshot = (rows = [], runtimeHealth = {}) => ({ readAt: 10, rows, instance: { runtimeHealth }, sources: {} });
test('authentication attention distinguishes affected running groups from unknown targets or queues', () => {
  const result = buildAttention(snapshot([row('running', 'codex', 'running'), row('unknown-target', null, 'not_running', { pending: { count: 1 } }), row('unknown-queue', 'codex', 'not_running', { known: false })], { codex: { health: 'auth_failed' } }));
  assert.equal(result.problems.length, 1);assert.deepEqual(result.problems[0].groups, ['running']);assert.equal(result.problems[0].extraUnknown, 2);
});
test('authentication includes pending and starting groups but not absent empty queues', () => {
  const result = buildAttention(snapshot([row('pending', 'claude', 'not_running', { pending: { count: 2 } }), row('starting', 'claude', 'starting'), row('quiet', 'claude', 'not_running')], { claude: { health: 'auth_failed' } }));
  assert.deepEqual(result.problems[0].groups, ['pending', 'starting']);assert.equal(result.problems[0].extraUnknown, 0);
});
test('rate recovery is a reminder only and a clean sample reports its read time', () => {
  for (const health of ['rate_limited', 'recovering']) {
    const result = buildAttention(snapshot([], { claude: { health, cooldownUntil: 42 } }));
    assert.equal(result.problems.length, 0);assert.deepEqual(result.reminders, [{ kind: 'rate_limited', runtime: 'claude', until: 42 }]);assert.equal(result.ok, false);
  }
  assert.equal(buildAttention(snapshot()).ok, true);assert.equal(buildAttention(snapshot()).sampledAt, 10);
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
test('a service absent from PM2 samples is down and recovers when it appears online', () => {
  const counter = createChannelDownCounter(), missing = { processes: [] };
  const snap = snapshot([{ ...row('a', 'claude', 'not_running'), c4: { componentName: 'telegram' } }]);
  const attention = () => buildAttention(snap, { channelDownCounter: counter, pm2Data: missing });
  assert.equal(counter.get('zylos-telegram'), 0);
  counter.update(missing); assert.equal(attention().ok, true);
  counter.update(missing);
  assert.deepEqual(attention().problems, [{ kind: 'channel_down', service: 'zylos-telegram', pm2Status: null }]);
  counter.update({ processes: [{ name: 'zylos-telegram', pm2_env: { status: 'online' } }] });
  assert.equal(attention().ok, true);
  counter.update(missing); assert.equal(attention().ok, true);
  counter.update(missing); assert.equal(attention().problems[0].kind, 'channel_down');
});
