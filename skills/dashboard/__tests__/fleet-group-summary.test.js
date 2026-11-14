import assert from 'node:assert/strict';
import test from 'node:test';
import { fleetGroupSummary, sanitizeFleetGroupSummary } from '../src/lib/workbench/fleet-summary.js';
import { buildAttention } from '../src/lib/workbench/attention.js';
import { classify } from '../src/lib/workbench/group-state.js';
import { FleetPoller, stateToFleetRecord } from '../src/lib/fleet-poller.js';

function row(sessionGroup, kind = 'idle', extra = {}) {
  return { sessionGroup, presence: 'running', state: { kind }, ...extra };
}
function snapshot(rows = [], extra = {}) {
  return { mode: 'multi', rows, listKnown: true, instance: { pool: { used: 7, capacity: 12 } }, ...extra };
}

test('running summary counts only live and starting groups, with each in exactly one category', () => {
  const result = fleetGroupSummary(snapshot([
    row('busy', 'busy'), row('idle'), row('starting', 'waiting', { presence: 'starting' }),
    row('unknown', 'unknown'), row('error', 'error'), row('unexpected', 'future_state'),
    row('reclaimed', 'error', { presence: 'not_running' }), row('unreadable', 'busy', { presence: 'unknown' }),
  ]));
  assert.equal(result.running, 6);
  assert.deepEqual(result.counts, { busy: 1, idle: 1, waiting: 1, unknown: 2, error: 1, no_response: null });
  assert.equal(Object.values(result.counts).reduce((sum, count) => sum + (count ?? 0), 0), result.running);
  assert.deepEqual(result.pool, { used: 7, capacity: 12 });
  assert.equal(result.problemCount, 1);
  assert.equal(result.problems[0].sessionGroup, 'error');
});

test('existing runtime errors override busy and idle; full problem count survives the two-row limit', () => {
  const result = fleetGroupSummary(snapshot([
    row('auth', 'busy', { attention: [{ kind: 'auth_failed' }], name: { displayName: 'Saved <运维> name' },
      createdAt: 123, c4: { componentName: 'lark', sessionGroupName: 'raw address' } }),
    row('start', 'idle', { attention: [{ kind: 'start_failed' }] }),
    row('third', 'error'),
  ]));
  assert.equal(result.counts.error, 3);
  assert.equal(result.counts.busy, 0);
  assert.equal(result.counts.idle, 0);
  assert.equal(result.problemCount, 3);
  assert.equal(result.problems.length, 2);
  assert.deepEqual(result.problems[0], { sessionGroup: 'auth', displayName: 'Saved <运维> name',
    name: { displayName: 'Saved <运维> name' }, createdAt: 123, c4: { componentName: 'lark' },
    reason: 'auth_failed', durationSeconds: null });
  assert.equal(result.problems[1].reason, 'start_failed');
});

test('sample age, long durations, queue waits and read errors never create runtime failures', () => {
  const result = fleetGroupSummary(snapshot([
    row('long-busy', 'busy', { duration: 864000, live: { status: { sampledAt: 0 } } }),
    row('long-idle', 'idle', { duration: 864000 }),
    row('pool', 'waiting', { wait: { kind: 'pool_wait' }, attention: [{ kind: 'pool_full' }] }),
    row('stale', 'unknown', { attention: [{ kind: 'data_unreadable' }] }),
  ]));
  assert.deepEqual(result.counts, { busy: 1, idle: 1, waiting: 1, unknown: 1, error: 0, no_response: null });
  assert.deepEqual(result.problems, []);
  assert.equal(result.noResponse, null);
  assert.equal(result.autoRestarts, null);
});

test('missing snapshot, single mode and unreadable list preserve uncertainty', () => {
  for (const value of [null, {}, { mode: 'single', rows: [] }, { mode: 'multi' }]) {
    assert.equal(fleetGroupSummary(value), null);
  }
  const incomplete = fleetGroupSummary(snapshot([], { listKnown: false }));
  assert.equal(incomplete.running, 0);
  assert.equal(incomplete.listKnown, false);
  assert.deepEqual(sanitizeFleetGroupSummary(incomplete), incomplete);
});

test('remote sanitizer enforces partition and bounded whitelisted problems; future signals stay null', () => {
  const value = fleetGroupSummary(snapshot([row('failure', 'error')]));
  assert.deepEqual(sanitizeFleetGroupSummary(value), value);
  const polluted = structuredClone(value);
  Object.assign(polluted, { noResponse: { count: 99 }, autoRestarts: { count: 5 }, secret: 'discard' });
  polluted.counts.no_response = 99;
  Object.assign(polluted.problems[0], { durationSeconds: 300, tool: 'discard' });
  assert.deepEqual(sanitizeFleetGroupSummary(polluted), value);
  for (const mutate of [
    item => { item.running = -1; }, item => { item.counts.idle = 1; },
    item => { item.counts.error = 0.5; }, item => { item.problemCount = 0; },
    item => { item.problems = []; }, item => { item.problems[0].reason = 'no_response'; },
    item => { item.problems[0].sessionGroup = null; },
  ]) {
    const invalid = structuredClone(value); mutate(invalid);
    assert.equal(sanitizeFleetGroupSummary(invalid), null);
  }
  for (const invalid of [null, {}, [], { running: 0 }]) assert.equal(sanitizeFleetGroupSummary(invalid), null);
});

test('fleet remote mode is explicit and legacy/malformed summaries degrade to null', () => {
  const group_summary = fleetGroupSummary(snapshot([row('x')]));
  for (const session_mode of ['single', 'multi', null, undefined, 'unknown', true]) {
    const record = stateToFleetRecord({ name: 'Remote' }, { state: 'IDLE', session_mode, group_summary });
    assert.equal(record.session_mode, ['single', 'multi'].includes(session_mode) ? session_mode : null);
    assert.deepEqual(record.group_summary, session_mode === 'multi' ? group_summary : null);
  }
  assert.equal(stateToFleetRecord({}, { state: 'IDLE' }).group_summary, null);
  assert.equal(stateToFleetRecord({}, { state: 'IDLE', session_mode: 'multi', group_summary: {} }).group_summary, null);
});

test('HTTP and SSE remote ingestion carry the same summary and clear it after a failed read', async () => {
  const group_summary = fleetGroupSummary(snapshot([row('x', 'error')]));
  const agent = { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'fixture' };
  const payload = { state: 'BUSY', session_mode: 'multi', group_summary };
  const poller = new FleetPoller({ fleet: { agents: [agent] } }, { fetch: async url =>
    new Response(JSON.stringify(url.endsWith('/api/auth/token') ? { token: 'fixture' } : payload)), now: () => 0 });
  await poller.pollOnce();
  assert.deepEqual(poller.getFleet().agents[0].group_summary, group_summary);
  poller._handleSseEvent(agent, { event: 'fleet_state', data: JSON.stringify(payload) });
  assert.deepEqual(poller.getFleet().agents[0].group_summary, group_summary);
  poller._setFailure(agent, 'timeout');
  const failed = poller.getFleet().agents[0];
  assert.equal(failed.session_mode, null);
  assert.equal(failed.group_summary, null);
});


test('Workbench auth attention takes precedence over its busy/waiting classification in Fleet', () => {
  const rows = [
    row('busy', 'busy', { target: { runtime: 'codex' }, queue: { pending: { count: 0 } },
      live: { status: { valid: true, state: 'busy' } } }),
    row('starting', 'waiting', { presence: 'starting', target: { runtime: 'codex' },
      queue: { pending: { count: 0 } }, wait: { kind: 'auth_wait' } }),
    row('reclaimed', 'not_running', { presence: 'not_running', target: { runtime: 'codex' },
      queue: { pending: { count: 1 } }, wait: { kind: 'auth_wait' } }),
  ];
  const value = snapshot(rows, { sources: {}, instance: { pool: {}, runtimeHealth: { codex: { health: 'auth_failed' } } } });
  const attention = buildAttention(value);
  for (const item of rows) {
    item.state = classify(item);
    item.attention = attention.problems.filter(problem => problem.groups?.includes(item.sessionGroup));
  }
  assert.equal(rows[0].state.kind, 'busy');
  assert.equal(rows[1].state.kind, 'waiting');
  const result = fleetGroupSummary(value);
  assert.equal(result.running, 2);
  assert.equal(result.counts.error, 2);
  assert.equal(result.problemCount, 2);
  assert.deepEqual(result.problems.map(problem => problem.sessionGroup), ['busy', 'starting']);
});

test('an explicit Fleet read refreshes a remote summary after a healthy stream cached an earlier snapshot', async () => {
  const agent = { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'fixture' };
  const first = fleetGroupSummary(snapshot([row('first', 'busy')]));
  const next = fleetGroupSummary(snapshot([row('second'), row('third', 'error')]));
  let payload = { state: 'IDLE', session_mode: 'multi', group_summary: first };
  let stateReads = 0;
  const poller = new FleetPoller({ fleet: { agents: [agent] } }, { fetch: async url => {
    if (url.endsWith('/api/auth/token')) return new Response(JSON.stringify({ token: 'fixture' }));
    stateReads++;
    return new Response(JSON.stringify(payload));
  }, now: () => 0 });
  await poller.pollOnce();
  poller._handleSseEvent(agent, { event: 'fleet_state', data: JSON.stringify(payload) });
  payload = { ...payload, group_summary: next };
  const refreshed = await poller.pollOnce();
  assert.equal(stateReads, 2);
  assert.equal(refreshed.agents[0].group_summary.running, 2);
  assert.equal(refreshed.agents[0].group_summary.counts.busy, 0);
  assert.equal(refreshed.agents[0].group_summary.counts.error, 1);
  assert.equal(refreshed.agents[0].group_summary.problems[0].sessionGroup, 'third');
});
