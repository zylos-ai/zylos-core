import test from 'node:test';
import assert from 'node:assert/strict';
import { activityBuckets } from '../src/lib/workbench/activity-buckets.js';

const minute = 60000, hour = 60 * minute, now = 6 * hour + 30000;
const event = (type, at, extra = {}) => ({ event_type: type, timestamp: new Date(at).toISOString(),
  session_group: 'chat:a', run_id: 'run-a', metadata: {}, ...extra });
const row = (key = 'chat:a', runId = 'run-a') => ({ sessionGroup: key, live: { runId } });
const result = (events, extra = {}) => activityBuckets({ range: '60m', now, rows: [row()], events, ...extra });
const cell = (output, at, key = 'chat:a') => output.groups[key].cells[Math.floor((at - output.start) / (output.cellSeconds * 1000))];

test('activity ranges have the exact aligned windows and reject unsupported ranges', () => {
  for (const [range, count, width] of [['60m', 60, minute], ['6h', 72, 5 * minute]]) {
    const output = result([], { range });
    assert.equal(output.range, range); assert.equal(output.cellSeconds, width / 1000);
    assert.equal(output.start, Math.floor(now / width) * width - (count - 1) * width);
    assert.equal(output.groups['chat:a'].cells.length, count);
    assert.ok(output.groups['chat:a'].cells.every(value => value === 'none'));
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
  ], { rows: [row('chat:a', 'replacement')] });
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
