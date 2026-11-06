import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, durationOf, sortRows, countRows } from '../src/lib/workbench/group-state.js';
const now = 1800000000000;
const row = patch => ({ sessionGroup: 'a', presence: 'running', queue: { pending: { oldestAt: now - 3000 } },
  live: { runId: 'run', status: { valid: true, state: 'busy', idleSeconds: 4 } }, wait: null, ...patch });
test('classification prioritizes source errors and invalid sampled status over idle', () => {
  assert.equal(classify(row(), { statusError: 'status_unreadable' }).reason, 'status_unreadable');
  assert.equal(classify(row({ presence: 'unknown', reason: 'group_list_failed' })).reason, 'group_list_failed');
  assert.equal(classify(row({ live: { error: { code: 'READ_FAILED' } } })).reason, 'READ_FAILED');
  const invalid = classify(row({ live: { status: { valid: false, reason: 'stale', sampledAt: 11 } } }));
  assert.equal(invalid.kind, 'unknown');assert.equal(invalid.reason, 'stale');assert.equal(invalid.sampledAt, 11);
});
test('busy remains visible with unknown wait, but authentication and starting are waiting', () => {
  for (const wait of [null, { kind: 'queued' }, { kind: 'unknown', reason: 'runtime_health_unreadable' }]) assert.equal(classify(row({ wait })).kind, 'busy');
  for (const kind of ['auth_wait', 'rate_wait', 'fenced', 'starting']) assert.equal(classify(row({ wait: { kind } })).kind, 'waiting');
  assert.equal(classify(row({ wait: { kind: 'start_failed' } })).kind, 'error');
});
test('queue failure does not turn absent or idle groups into waiting', () => {
  const wait = { kind: 'unknown', reason: 'queue_summary_failed', pendingKnown: false };
  assert.equal(classify(row({ presence: 'not_running', wait })).kind, 'not_running');
  assert.equal(classify(row({ wait, live: { status: { valid: true, state: 'idle' } } })).kind, 'idle');
  assert.equal(classify(row({ wait: { kind: 'unknown', reason: 'no_rule' }, live: { status: { valid: true, state: 'idle' } } })).kind, 'waiting');
  assert.equal(classify(row({ presence: 'starting' })).kind, 'unknown');
});
test('durations use current-run prompt, idle seconds, and correctly scaled wait times', () => {
  const events = [{ session_group: 'a', run_id: 'old', event_type: 'user_prompt_submit', timestamp: now - 100 },
    { session_group: 'a', run_id: 'run', event_type: 'user_prompt_submit', timestamp: new Date(now - 5000).toISOString() }];
  assert.equal(durationOf(row({ state: { kind: 'busy' } }), { now, events }), 5);
  assert.equal(durationOf(row({ state: { kind: 'busy' } }), { now }), null);
  assert.equal(durationOf(row({ state: { kind: 'busy' } }), { now, events: [...events, { session_group: 'a', run_id: 'run', event_type: 'stop', timestamp: now - 1 }] }), null);
  assert.equal(durationOf(row({ state: { kind: 'idle' } }), { now }), 4);
  assert.equal(durationOf(row({ state: { kind: 'waiting' }, wait: { kind: 'starting' }, createdAt: now / 1000 - 2 }), { now }), 2);
  assert.equal(durationOf(row({ state: { kind: 'waiting' }, wait: { kind: 'fenced' }, fence: { createdAt: now / 1000 - 6 } }), { now }), 6);
  assert.equal(durationOf(row({ state: { kind: 'waiting' }, wait: { kind: 'auth_wait' } }), { now }), 3);
  assert.equal(durationOf(row({ state: { kind: 'waiting' }, wait: { kind: 'starting' }, createdAt: null }), { now }), null);
  for (const kind of ['not_running', 'unknown', 'error']) assert.equal(durationOf(row({ state: { kind } }), { now }), null);
});
test('sorting keeps Origin first, then attention, state order and latest activity with null last', () => {
  const make = (sessionGroup, kind, lastActivityAt, attention = [], origin = false) => ({ sessionGroup, state: { kind }, c4: { lastActivityAt }, attention, origin });
  const rows = [make('absent', 'not_running', 99), make('busy-old', 'busy', null), make('idle', 'idle', 100),
    make('busy-new', 'busy', 10), make('alert', 'not_running', null, [{}]), make('origin', 'not_running', null, [], true), make('unknown', 'unknown', 90), make('waiting', 'waiting', 4), make('error', 'error', 5)];
  assert.deepEqual(sortRows(rows).map(row => row.sessionGroup), ['origin', 'alert', 'busy-new', 'busy-old', 'error', 'waiting', 'unknown', 'idle', 'absent']);
  assert.deepEqual(countRows(rows), { busy: 2, waiting: 1, error: 1, unknown: 1, idle: 1, not_running: 3 });
  assert.equal(rows[0].sessionGroup, 'absent');
});
