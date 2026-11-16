import assert from 'node:assert/strict';
import test from 'node:test';
import { fleetGroupSummary, sanitizeFleetGroupSummary } from '../src/lib/workbench/fleet-summary.js';
import { projectGroup } from '../src/lib/workbench/groups-api.js';
import { classify } from '../src/lib/workbench/group-state.js';
import { objectResponse, flushObjectReads } from './fixtures/fleet-object-api.js';
import { FleetPoller, stateToFleetRecord, fleetStateFromObjects } from '../src/lib/fleet-poller.js';

function row(sessionGroup, kind = 'idle', extra = {}) {
  return { sessionGroup, presence: 'running', state: { kind }, ...extra };
}
function snapshot(rows = [], extra = {}) {
  return { mode: 'multi', rows, listKnown: true, instance: { pool: { used: 7, capacity: 12 } }, ...extra };
}

test('running summary includes unknown-presence groups, with each in exactly one category', () => {
  const result = fleetGroupSummary(snapshot([
    row('busy', 'busy'), row('idle'), row('starting', 'waiting', { presence: 'starting' }),
    row('unknown', 'unknown'), row('error', 'error'), row('unexpected', 'future_state'),
    row('reclaimed', 'error', { presence: 'not_running' }), row('unreadable', 'busy', { presence: 'unknown' }),
  ]));
  assert.equal(result.running, 7);
  assert.deepEqual(result.counts, { busy: 2, idle: 1, waiting: 1, unknown: 2, error: 1, no_response: 0 });
  assert.equal(Object.values(result.counts).reduce((sum, count) => sum + count, 0), result.running);
  assert.deepEqual(result.pool, { used: 7, capacity: 12 });
  assert.equal(result.problemCount, 1);
  assert.equal(result.problems[0].sessionGroup, 'error');
});

test('existing runtime errors override busy and idle; full problem count survives the two-row limit', () => {
  const result = fleetGroupSummary(snapshot([
    row('auth', 'busy', { flags: { blocked: { reason: 'auth_failed' } }, name: { displayName: 'Saved <运维> name' },
      createdAt: 123, c4: { componentName: 'lark', sessionGroupName: 'raw address' } }),
    row('start', 'idle', { flags: { startFailed: { count: 1 } } }),
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
  assert.ok(!(result.attention ?? []).some(item => item.kind === 'start_failed' && item.group === 'start'));
});

test('sample age, long durations, queue waits and read errors never create runtime failures', () => {
  const result = fleetGroupSummary(snapshot([
    row('long-busy', 'busy', { duration: 864000, live: { status: { sampledAt: 0 } } }),
    row('long-idle', 'idle', { duration: 864000 }),
    row('pool', 'waiting', { wait: { kind: 'pool_wait' }, flags: { waitingSlot: { position: 1 } } }),
    row('stale', 'unknown', { flags: { unreadable: { reasons: ['status'] } } }),
  ]));
  assert.deepEqual(result.counts, { busy: 1, idle: 1, waiting: 1, unknown: 1, error: 0, no_response: 0 });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.noResponse, { count: 0 });
  // A snapshot that did not count restarts leaves the count unknown rather than zero.
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

test('remote sanitizer enforces partition and bounded whitelisted problems', () => {
  const value = fleetGroupSummary(snapshot([row('failure', 'error')]));
  assert.deepEqual(sanitizeFleetGroupSummary(value), value);
  const polluted = structuredClone(value);
  Object.assign(polluted, { secret: 'discard' });
  Object.assign(polluted.problems[0], { durationSeconds: 300, tool: 'discard' });
  assert.deepEqual(sanitizeFleetGroupSummary(polluted), value);
  for (const mutate of [
    item => { item.running = -1; }, item => { item.counts.idle = 1; },
    item => { item.counts.error = 0.5; }, item => { item.problemCount = 0; },
    item => { item.problems = []; }, item => { item.problems[0].reason = 'future_reason'; },
    item => { item.problems[0].sessionGroup = null; },
    item => { item.counts.no_response = 1; }, item => { item.counts.no_response = -1; },
  ]) {
    const invalid = structuredClone(value); mutate(invalid);
    assert.equal(sanitizeFleetGroupSummary(invalid), null);
  }
  for (const invalid of [null, {}, [], { running: 0 }]) assert.equal(sanitizeFleetGroupSummary(invalid), null);
});

test('a reminded group without a response since is counted as no response, after errors, with its silent time', () => {
  const readAt = Date.parse('2026-11-14T10:00:00Z');
  const result = fleetGroupSummary(snapshot([
    row('silent', 'busy', { noResponse: { since: readAt - 125_000 }, name: { displayName: 'Ops' } }),
    row('failed-and-silent', 'busy', { flags: { blocked: { reason: 'auth_failed' } }, noResponse: { since: readAt - 5000 } }),
    row('busy', 'busy', { noResponse: null }),
  ], { readAt, instance: { pool: { used: 3, capacity: 12 }, autoRestarts: { count: 2 } } }));
  assert.deepEqual(result.counts, { busy: 1, idle: 0, waiting: 0, unknown: 0, error: 1, no_response: 1 });
  assert.equal(result.problemCount, 2);
  assert.deepEqual(result.problems.map(item => [item.sessionGroup, item.reason, item.durationSeconds]),
    [['failed-and-silent', 'auth_failed', null], ['silent', 'no_response', 125]]);
  assert.deepEqual(result.noResponse, { count: 1 });
  assert.deepEqual(result.autoRestarts, { count: 2 });
  assert.deepEqual(sanitizeFleetGroupSummary(result), result);
  // Without a read time the silent duration is unknown, not zero.
  assert.equal(fleetGroupSummary(snapshot([row('silent', 'busy', { noResponse: { since: readAt } })])).problems[0].durationSeconds, null);
});

test('remote sanitizer accepts no-response counts, keeps silent time only for no response, and reads older instances', () => {
  const readAt = Date.parse('2026-11-14T10:00:00Z');
  const value = fleetGroupSummary(snapshot([row('silent', 'busy', { noResponse: { since: readAt - 60_000 } })],
    { readAt, instance: { autoRestarts: { count: 0 } } }));
  assert.deepEqual(sanitizeFleetGroupSummary(value), value);
  for (const [field, bad] of [['durationSeconds', -1], ['durationSeconds', 1.5], ['durationSeconds', '60']]) {
    const invalid = structuredClone(value); invalid.problems[0][field] = bad;
    assert.equal(sanitizeFleetGroupSummary(invalid).problems[0].durationSeconds, null);
  }
  for (const bad of [{ count: -1 }, { count: 0.5 }, { count: '2' }, null, undefined]) {
    const invalid = structuredClone(value); invalid.autoRestarts = bad;
    assert.equal(sanitizeFleetGroupSummary(invalid).autoRestarts, null);
  }
  // An instance from before no response was counted reports null counts and signals.
  const older = { running: 1, counts: { busy: 0, idle: 0, waiting: 0, unknown: 0, error: 1, no_response: null },
    problems: [{ sessionGroup: 'g', reason: 'start_failed', durationSeconds: null }], problemCount: 1, listKnown: true,
    pool: { used: null, capacity: null }, noResponse: null, autoRestarts: null };
  const read = sanitizeFleetGroupSummary(older);
  assert.equal(read.counts.no_response, 0);
  assert.deepEqual(read.noResponse, { count: 0 });
  assert.equal(read.autoRestarts, null);
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

test('HTTP and SSE object reads carry the same running summary and clear it after a failed read', async () => {
  const agent = { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'fixture' };
  let working = 1;
  const poller = new FleetPoller({ fleet: { agents: [agent] } }, { fetch: async url =>
    url.endsWith('/api/auth/token') ? new Response(JSON.stringify({ token: 'fixture' }))
      : objectResponse(url, { working, idle: 1, unknown: 1, instance: { session_mode: { sessionMode: 'multi' } } }), now: () => 0 });
  const expected = busy => ({ running: busy + 2, counts: { busy, idle: 1, waiting: 0, unknown: 1, error: 0, no_response: 0 },
    problems: [], problemCount: 0, listKnown: true, pool: { used: busy + 1, capacity: 12 },
    noResponse: { count: 0 }, autoRestarts: { count: 0 } });
  await poller.pollOnce();
  assert.deepEqual(poller.getFleet().agents[0].group_summary, expected(1));
  working = 2;
  poller._handleSseEvent(agent, { event: 'groups', data: '{}' });
  await flushObjectReads();
  assert.deepEqual(poller.getFleet().agents[0].group_summary, expected(2));
  poller._setFailure(agent, 'timeout');
  const failed = poller.getFleet().agents[0];
  assert.equal(failed.session_mode, null);
  assert.equal(failed.group_summary, null);
});


test('instance authentication health takes precedence over group busy and starting state in Fleet', () => {
  const rows = [
    row('busy', 'busy', { target: { runtime: 'codex' }, queue: { pending: { count: 0 } },
      live: { status: { valid: true, state: 'busy' } } }),
    row('starting', 'waiting', { presence: 'starting', target: { runtime: 'codex' },
      queue: { pending: { count: 0 } }, wait: { kind: 'auth_wait' } }),
    row('reclaimed', 'not_running', { presence: 'not_running', target: { runtime: 'codex' },
      queue: { pending: { count: 1 } }, wait: { kind: 'auth_wait' } }),
  ];
  const value = snapshot(rows, { sources: {}, instance: { pool: {}, runtimeHealth: { codex: { health: 'auth_failed' } } } });
  value.readAt = 1800000000000;
  for (const item of rows) {
    item.state = classify(item);
    item.flags = projectGroup(item, value).flags;
  }
  assert.equal(rows[0].state.kind, 'busy');
  assert.equal(rows[1].state.kind, 'waiting');
  const result = fleetGroupSummary(value);
  assert.equal(result.running, 2);
  assert.equal(result.counts.error, 2);
  assert.equal(result.problemCount, 2);
  assert.deepEqual(result.problems.map(problem => problem.sessionGroup), ['busy', 'starting']);
});


test('object fleet projection maps compact auth and start flags and retains unknown groups', () => {
  const rows = [
    { id: 'busy', displayName: 'Busy', state: { kind: 'working' }, flags: {} },
    { id: 'auth', displayName: 'Auth', state: { kind: 'working' }, flags: { blocked: { reason: 'auth_failed' } } },
    { id: 'failed', displayName: 'Failed', state: { kind: 'starting' }, flags: { startFailed: { count: 1 } } },
    { id: 'unknown', displayName: null, state: { kind: 'unknown' }, flags: { unreadable: { reasons: ['status'] } } },
    { id: 'waiting', displayName: null, state: { kind: 'stopping' }, flags: { queued: { count: 1 } } },
  ];
  const mapped = fleetStateFromObjects({ session_mode: { sessionMode: 'multi' } },
    { readAt: 10000, listKnown: true, running: { total: 5, states: { working: 2, idle: 0, starting: 1, stopping: 1, unknown: 1 } }, pool: { used: 3, capacity: 12 } },
    { today: { cost: 0 }, sevenDay: { cost: 0 } }, { rows });
  assert.equal(mapped.session_mode, 'multi');
  assert.equal(mapped.group_summary.running, 5);
  assert.deepEqual(mapped.group_summary.counts, { busy: 1, idle: 0, waiting: 1, unknown: 1, error: 2, no_response: 0 });
  assert.deepEqual(mapped.group_summary.problems.map(item => [item.sessionGroup, item.displayName, item.reason]),
    [['auth', 'Auth', 'auth_failed'], ['failed', 'Failed', 'start_failed']]);
  assert.equal(mapped.group_summary.problemCount, 2);
  assert.deepEqual(stateToFleetRecord({}, mapped).group_summary, mapped.group_summary);
});

test('object fleet counts authentication failures for starting and unknown running-list rows', () => {
  const instance = { session_mode: { sessionMode: 'multi' }, runtimeHealth: { codex: { health: 'auth_failed' } } };
  const counts = { readAt: 10000, listKnown: true, running: { total: 2,
    states: { working: 0, idle: 0, starting: 1, stopping: 0, unknown: 1 } } };
  const running = { rows: [
    { id: 'starting', runtime: 'codex', state: { kind: 'starting' }, flags: {} },
    { id: 'unknown', runtime: 'codex', state: { kind: 'unknown' }, flags: {} },
  ] };
  const usage = { today: { cost: 0 }, sevenDay: { cost: 0 } };
  const value = fleetStateFromObjects(instance, counts, usage, running).group_summary;
  assert.deepEqual(value.counts, { busy: 0, idle: 0, waiting: 0, unknown: 0, error: 2, no_response: 0 });
  assert.deepEqual(value.problems.map(row => [row.sessionGroup, row.reason]), [['starting', 'auth_failed'], ['unknown', 'auth_failed']]);
  instance.runtimeHealth = { codex: { source: 'unreadable' } };
  const unreadable = fleetStateFromObjects(instance, counts, usage, running).group_summary;
  assert.equal(unreadable.counts.error, 0); assert.equal(unreadable.counts.waiting, 1); assert.equal(unreadable.counts.unknown, 1);
});

test('an explicitly unreadable instance mode remains unknown instead of an offline transport failure', () => {
  const value = fleetStateFromObjects({session_mode:{sessionMode:null}},
    {listKnown:false,running:{total:0,states:{working:0,idle:0,starting:0,stopping:0,unknown:0}}},
    {today:{cost:null},sevenDay:{cost:null}}, {rows:[]});
  assert.equal(value.state,'UNKNOWN');
  assert.equal(stateToFleetRecord({},value).session_mode,null);
});


test('compact no-response flags restore silent durations while the independent count comes from counts', () => {
  const readAt = Date.parse('2026-11-15T17:00:00Z');
  const rows = [
    { id: 'auth', displayName: 'Auth', state: { kind: 'working' }, flags: { blocked: { reason: 'auth_failed' }, noResponse: { since: new Date(readAt - 5000).toISOString() } } },
    { id: 'silent', displayName: 'Ops', state: { kind: 'idle' }, flags: { noResponse: { since: new Date(readAt - 125000).toISOString() } } },
  ];
  const counts = { readAt, listKnown: true, running: { total: 2, states: { working: 1, idle: 1, starting: 0, stopping: 0, unknown: 0 }, flags: { noResponse: 2 } } };
  const value = fleetStateFromObjects({ session_mode: { sessionMode: 'multi' } }, counts,
    { today: { cost: 0 }, sevenDay: { cost: 0 } }, { rows });
  assert.deepEqual(value.group_summary.counts, { busy: 0, idle: 0, waiting: 0, unknown: 0, error: 1, no_response: 1 });
  assert.equal(value.group_summary.noResponse.count, counts.running.flags.noResponse);
  assert.deepEqual(value.group_summary.problems.map(row => [row.sessionGroup, row.reason, row.durationSeconds]),
    [['auth', 'auth_failed', null], ['silent', 'no_response', 125]]);
  assert.deepEqual(stateToFleetRecord({}, value).group_summary, value.group_summary);
  counts.running.flags.noResponse = 3;
  assert.equal(stateToFleetRecord({}, fleetStateFromObjects({ session_mode: { sessionMode: 'multi' } }, counts,
    { today: { cost: 0 }, sevenDay: { cost: 0 } }, { rows })).group_summary, null, 'an impossible independent count is not published');
});
