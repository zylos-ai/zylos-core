import test from 'node:test';
import assert from 'node:assert/strict';
import { activityBuckets } from '../src/lib/workbench/activity-buckets.js';

const minute = 60000, hour = 60 * minute, now = 6 * hour + 30000;
const event = (type, at, extra = {}) => ({ event_type: type, timestamp: new Date(at).toISOString(),
  session_group: 'chat:a', run_id: 'run-a', metadata: {}, ...extra });
const row = (key = 'chat:a', runId = 'run-a') => ({ sessionGroup: key, live: { runId } });
const result = (events, extra = {}) => activityBuckets({ range: '60m', now, rows: [row()], events, ttlMs: 24 * hour, ...extra });
const cell = (output, at, key = 'chat:a') => output.groups[key].cells[Math.floor((at - output.start) / (output.cellSeconds * 1000))];

test('activity ranges have the exact aligned windows and reject unsupported ranges', () => {
  for (const [range, count, width] of [['60m', 60, minute], ['6h', 72, 5 * minute]]) {
    const output = result([], { range });
    assert.equal(output.range, range); assert.equal(output.cellSeconds, width / 1000);
    assert.equal(output.start, Math.floor(now / width) * width - (count - 1) * width);
    assert.equal(output.groups['chat:a'].cells.length, count);
    assert.ok(output.groups['chat:a'].cells.every(value => value === 'idle'));
  }
  assert.throws(() => result([], { range: '1d' }), { code: 'invalid_range', statusCode: 400 });
});

for (const endType of ['post_tool_use', 'post_tool_failure']) {
test(`a tool closed by ${endType} spans intersecting cells and then becomes idle`, () => {
  const at = 5 * hour + 10 * minute;
  const output = result([
    event('session_start', at),
    event('pre_tool_use', at + 30000, { metadata: { tool_use_id: 'tool-a' } }),
    event(endType, at + 90000, { metadata: { tool_use_id: 'tool-a' } }),
  ]);
  assert.equal(cell(output, at), 'busy'); assert.equal(cell(output, at + minute), 'busy');
  assert.equal(cell(output, at + 2 * minute), 'idle'); assert.equal(cell(output, now), 'idle');
});
}

test('unmatched tools end at the next stop or the historical run endpoint', () => {
  const at = 5 * hour + 10 * minute;
  const stopped = result([
    event('session_start', at), event('pre_tool_use', at + 1000, { metadata: { tool_use_id: 'open' } }),
    event('stop', at + minute),
  ]);
  assert.equal(cell(stopped, at), 'busy'); assert.equal(cell(stopped, at + 2 * minute), 'idle');
  const ended = result([
    event('session_start', at), event('pre_tool_use', at + 1000, { metadata: { tool_use_id: 'open' } }),
    event('reclaim_done', at + 2 * minute),
  ], { rows: [row('chat:a', null)] });
  assert.equal(cell(ended, at + minute), 'busy'); assert.equal(cell(ended, at + 3 * minute), 'none');
  const current = result([event('session_start', at), event('pre_tool_use', at + 1000, { metadata: { tool_use_id: 'open' } })]);
  assert.equal(cell(current, now), 'busy');
});

test('a thinking-only turn is busy until stop without requiring a tool event', () => {
  const at = 5 * hour + 10 * minute;
  const output = result([event('session_start', at), event('user_prompt_submit', at + 1000), event('stop', at + 2 * minute)]);
  assert.equal(cell(output, at), 'busy'); assert.equal(cell(output, at + minute), 'busy');
  assert.equal(cell(output, at + 3 * minute), 'idle');
  const current = result([event('session_start', at), event('user_prompt_submit', at + 1000)]);
  assert.equal(cell(current, now), 'busy');
});

for (const source of ['hook', 'rollout']) {
  test(`a ${source} subagent remains busy after its parent turn stops`, () => {
    const at = 5 * hour + 10 * minute;
    const output = result([
      event('session_start', at), event('user_prompt_submit', at + 1000),
      event('subagent_start', at + 10000, { source, metadata: { agent_id: 'child' } }),
      event('stop', at + minute),
      event('subagent_stop', at + 3 * minute, { source, metadata: { agent_id: 'child' } }),
    ]);
    assert.equal(cell(output, at + 2 * minute), 'busy');
    assert.equal(cell(output, at + 4 * minute), 'idle');
    const unended = result([
      event('session_start', at), event('subagent_start', at + 10000, { source, metadata: { agent_id: 'child' } }),
      event('stop', at + minute),
    ]);
    assert.equal(cell(unended, now), 'busy');
  });
}

test('tool and child matching never crosses group or run identities', () => {
  const at = 5 * hour + 10 * minute;
  const output = result([
    event('session_start', at), event('pre_tool_use', at + 1000, { metadata: { tool_use_id: 'same' } }),
    event('post_tool_failure', at + minute, { session_group: 'chat:b', run_id: 'run-a', metadata: { tool_use_id: 'same' } }),
    event('post_tool_use', at + minute, { run_id: 'other', metadata: { tool_use_id: 'same' } }),
    event('subagent_start', at + 1000, { metadata: { agent_id: 'same-child' } }),
    event('subagent_stop', at + minute, { run_id: 'other', metadata: { agent_id: 'same-child' } }),
  ]);
  assert.equal(cell(output, at + 3 * minute), 'busy');
  assert.equal(Object.hasOwn(output.groups, 'chat:b'), false);
});

test('attention priority is error then waiting then busy then idle', () => {
  const at = 5 * hour + 10 * minute;
  const output = result([
    event('session_start', at), event('user_prompt_submit', at + 1000),
    event('wait_capacity', at + 10000), event('activate_failed', at + minute + 1000),
    event('permission_request', at + 2 * minute + 1000), event('activate_timeout', at + 2 * minute + 2000),
    event('wait_health', at + 3 * minute + 1000), event('stop', at + 4 * minute),
  ]);
  assert.equal(cell(output, at), 'waiting'); assert.equal(cell(output, at + minute), 'error');
  assert.equal(cell(output, at + 2 * minute), 'error'); assert.equal(cell(output, at + 3 * minute), 'waiting');
  assert.equal(cell(output, at + 5 * minute), 'idle');
});

test('separate historical runs leave empty gaps while only the current run extends to now', () => {
  const at = 5 * hour + 10 * minute;
  const output = result([
    event('session_start', at, { run_id: 'old' }), event('stop', at + minute, { run_id: 'old' }),
    event('session_start', at + 5 * minute), event('stop', at + 6 * minute),
  ]);
  assert.equal(cell(output, at), 'idle'); assert.equal(cell(output, at + 3 * minute), 'none');
  assert.equal(cell(output, at + 5 * minute), 'idle'); assert.equal(cell(output, now), 'idle');
});

test('inactive groups and out-of-window inbound are excluded and inputs remain unchanged', () => {
  const at = 5 * hour + 10 * minute;
  const events = [event('session_start', at), event('activate_failed', at + minute, { session_group: 'old:group' })];
  const inbound = [
    { session_group: 'chat:a', timestamp: new Date(at + 2000).toISOString() },
    { session_group: 'old:group', timestamp: new Date(at + 1000).toISOString() },
    { session_group: 'chat:a', timestamp: new Date(now - 2 * hour).toISOString() },
    { session_group: 'chat:a', timestamp: new Date(now + minute).toISOString() },
  ];
  const before = JSON.stringify({ events, inbound });
  const output = result(events, { inbound });
  assert.deepEqual(Object.keys(output.groups), ['chat:a']);
  assert.deepEqual(output.groups['chat:a'].inbound, [at + 2000]);
  assert.equal(JSON.stringify({ events, inbound }), before);
});

test('single view has no group event or inbound projection', () => {
  const output = result([event('session_start', now - minute)], {
    rows: [{ sessionGroup: null, live: { runId: 'single-run' } }],
    inbound: [{ session_group: 'origin', timestamp: new Date(now - 1000).toISOString() }],
  });
  assert.deepEqual(output.groups, {});
});

for (const run_id of [null, undefined]) test('unattributed events paint only waiting or error points: ' + run_id, () => {
  const at = 5 * hour + 10 * minute;
  const output = result([
    event('wait_health', at, { run_id }),
    event('user_prompt_submit', at + minute, { run_id }),
    event('pre_tool_use', at + 2 * minute, { run_id }),
    event('stop', at + 3 * minute, { run_id }),
    event('wait_capacity', at + 30 * minute, { run_id }),
    event('activate_failed', at + 31 * minute, { run_id }),
  ], { rows: [row('chat:a', null)] });
  assert.equal(cell(output, at), 'waiting');
  for (let index = 1; index < 30; index++) assert.equal(cell(output, at + index * minute), 'none');
  assert.equal(cell(output, at + 30 * minute), 'waiting');
  assert.equal(cell(output, at + 31 * minute), 'error');
  assert.equal(cell(output, at + 32 * minute), 'none');
});

test('a point at a cell boundary paints the following cell only', () => {
  const at = 5 * hour + 10 * minute;
  const output = result([event('wait_capacity', at, { run_id: null })], { rows: [row('chat:a', null)] });
  assert.equal(cell(output, at - 1), 'none');
  assert.equal(cell(output, at), 'waiting');
  assert.equal(cell(output, at + minute), 'none');
});

test('an interval ending at a cell boundary excludes the following cell', () => {
  const at = 5 * hour + 10 * minute;
  const output = result([
    event('session_start', at), event('user_prompt_submit', at), event('stop', at + minute),
  ]);
  assert.equal(cell(output, at), 'busy');
  assert.equal(cell(output, at + minute), 'idle');
});

for (const range of ['60m', '6h']) {
  for (const [type, metadata] of [['user_prompt_submit', {}], ['pre_tool_use', { tool_use_id: 'long-tool' }],
    ['subagent_start', { agent_id: 'long-child' }]]) {
    test(`${range} paints an unfinished ${type} from before the window through now`, () => {
      const output = result([event('session_start', 0), event(type, minute, { metadata })], { range });
      assert.ok(output.groups['chat:a'].cells.every(value => value === 'busy'));
    });
  }
}

test('a tool crossing the window start becomes idle after its matching end', () => {
  const end = 5 * hour + 10 * minute;
  const output = result([event('session_start', hour),
    event('pre_tool_use', 2 * hour, { metadata: { tool_use_id: 'long' } }),
    event('post_tool_use', end, { metadata: { tool_use_id: 'long' } })]);
  assert.equal(output.groups['chat:a'].cells[0], 'busy');
  assert.equal(cell(output, end - 1), 'busy');
  assert.equal(cell(output, end), 'idle');
  assert.equal(cell(output, now), 'idle');
});

test('a turn closed before the window contributes no busy cells', () => {
  const output = result([event('session_start', hour), event('user_prompt_submit', 2 * hour), event('stop', 3 * hour)]);
  assert.ok(output.groups['chat:a'].cells.every(value => value === 'idle'));
});

test('a current run without events is idle only after its creation; inactive rows stay empty', () => {
  const createdAt = 5 * hour + 20 * minute;
  const output = result([], { rows: [{ ...row(), createdAt: createdAt / 1000 }, row('inactive', null)] });
  assert.equal(cell(output, createdAt - 1), 'none');
  assert.equal(cell(output, createdAt), 'idle');
  assert.equal(cell(output, now), 'idle');
  assert.ok(output.groups.inactive.cells.every(value => value === 'none'));
  const older = result([], { rows: [{ ...row(), createdAt: hour / 1000 }] });
  assert.ok(older.groups['chat:a'].cells.every(value => value === 'idle'));
});

test('the sampled current cell is covered even when now is exactly on its boundary', () => {
  const at = 6 * hour;
  const idle = result([], { now: at, rows: [{ ...row(), createdAt: at / 1000 }] });
  assert.equal(cell(idle, at), 'idle');
  const busy = result([event('user_prompt_submit', at - 2 * hour)], { now: at });
  assert.ok(busy.groups['chat:a'].cells.every(value => value === 'busy'));
  const stopped = result([event('user_prompt_submit', at - 2 * hour), event('stop', at)], { now: at });
  assert.equal(cell(stopped, at), 'idle');
});

// Freshness checks use the production default; earlier interval-shape cases use
// a long configured TTL to keep their matching/window boundary independent.
test('lost main and child ends expire at their own freshness boundaries', () => {
  const stale = now - 31 * minute;
  for (const [type, metadata] of [['user_prompt_submit', {}], ['subagent_start', { agent_id: 'child' }]]) {
    const output = result([event(type, stale, { metadata })], { ttlMs: 30 * minute });
    assert.equal(cell(output, stale + 29 * minute), 'busy');
    assert.equal(cell(output, now), 'idle');
  }
});

test('any current-run event refreshes a main turn but only child tools refresh a child', () => {
  const stale = now - 31 * minute;
  const main = result([event('user_prompt_submit', stale), event('assistant_message', now - minute)], { ttlMs: 30 * minute });
  assert.equal(cell(main, now), 'busy');
  const child = result([event('subagent_start', stale, { metadata: { agent_id: 'child' } }),
    event('pre_tool_use', now - minute, { metadata: { agent_id: 'child', tool_use_id: 'child-tool' } })], { ttlMs: 30 * minute });
  assert.equal(cell(child, now), 'busy');
  const expired = result([event('subagent_start', stale, { metadata: { agent_id: 'child' } }),
    event('pre_tool_use', stale + 1000, { metadata: { agent_id: 'child', tool_use_id: 'lost' } })], { ttlMs: 30 * minute });
  assert.equal(cell(expired, now), 'idle', 'A lost child tool end cannot become an unmatched main tool');
});

for (const type of ['turn_complete', 'dashboard_interrupt']) test(`${type} closes the main interval while child stops do not`, () => {
  const output = result([event('user_prompt_submit', now - 5 * minute), event(type, now - minute)]);
  assert.equal(cell(output, now), 'idle');
  const childStop = result([event('user_prompt_submit', now - 5 * minute),
    event('stop', now - 4 * minute, { metadata: { agent_id: 'child' } })]);
  assert.equal(cell(childStop, now), 'busy');
});

test('activity tools require an event start while absent tools bound stale unmatched history', () => {
  const events = [event('pre_tool_use', now - 2 * hour, { metadata: { tool_use_id: 'old' } })];
  const absent = result(events, { ttlMs: 30 * minute, rows: [{ ...row(), tools: [] }] });
  assert.equal(cell(absent, now), 'idle');
  const live = result(events, { ttlMs: 30 * minute, rows: [{ ...row(), tools: [{ id: 'old' }] }] });
  assert.equal(cell(live, now), 'busy');
  const unseen = result([], { ttlMs: 30 * minute, rows: [{ ...row(), tools: [{ id: 'missing-start' }] }] });
  assert.equal(cell(unseen, now), 'idle', 'A Core sample cannot invent an event interval');
});
