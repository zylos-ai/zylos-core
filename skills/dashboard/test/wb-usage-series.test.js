import test from 'node:test';
import assert from 'node:assert/strict';
import { usageBounds, usageSeries } from '../src/lib/workbench/usage-series.js';
import { costRows, costSummary, summarizeCosts, usageIntervals } from '../src/lib/workbench/cost-query.js';
import { usageFixture } from './fixtures/usage-store.js';

// SQLite integration: real Store and private readonly C4Reader, owned fixture
// roots only. Run for cost/range/bucket/query changes; skip presentation changes.
// The runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/tmux namespace. No child,
// daemon or network is started. Fixture closes every DB before removing files.
test('usage combines both runtimes and legacy costs while tokens use dimensions', t => {
  const f = usageFixture(t), now = new Date('2026-11-06T04:00:00.000Z');
  for (let day = 1; day <= 6; day++) {
    const timestamp = `2026-11-0${day}T01:00:00.000Z`;
    f.metric(timestamp, 'claude', { total_input: 100, output: 20, cache_read: 80, cost: 1, projects: ['alpha'] });
    f.metric(timestamp, 'codex', { total_input: 200, output: 30, cost: 2, projects: ['beta'] });
  }
  f.metric('2026-10-31T01:00:00.000Z', 'claude', { total_input: 100, output: 20, cache_read: 80, cost: 1, projects: ['alpha'] });
  f.metric('2026-10-31T01:00:00.000Z', 'codex', { total_input: 200, output: 30, cost: 2, projects: ['beta'] });
  f.metric('2026-11-06T02:00:00.000Z', 'claude', {}, 'api_request_cost', 5);
  f.event('2026-11-06T01:00:00.000Z', 'rotate_done');
  const result = usageSeries(f.store, f.reader, { range: '7d', tz: 'Asia/Singapore', now });
  assert.equal(result.scope, 'all_groups');
  assert.equal(result.totals.cost, 26);
  assert.deepEqual(result.totals.costByRuntime, { claude: 12, codex: 14 });
  assert.equal(result.totals.tokens, 2450);
  assert.equal(result.totals.rotations, 1);
  assert.equal(result.totals.cost, f.store.aggregateCost(result));
  assert.equal(summarizeCosts(costRows(f.store, result)).total, result.totals.cost);
  const summary = costSummary(f.store, { tz: result.tz, now });
  assert.equal(summary.today.total, 8);
  assert.equal(summary.sevenDay.total, result.totals.cost);
  assert.equal(Object.hasOwn(result, 'costSummary'), false, 'full usage must not repeat the summary query');
  assert.equal(summary.daily.reduce((sum, row) => sum + row.total, 0), summary.sevenDay.total);
  assert.equal(result.projects.items[0].name, 'beta');
  assert.equal(result.projects.items[0].outputTokens, 210);
  assert.equal(f.store.queryMetrics({ name: 'account_quota' }).length, 0);
});

test('usage month and custom bounds use natural timezone days and reject invalid ranges', () => {
  const now = new Date('2026-11-06T04:00:00.000Z');
  const month = usageBounds({ range: 'month', tz: 'Asia/Singapore', now });
  assert.equal(month.since, '2026-10-31T16:00:00.000Z');
  assert.equal(month.until, now.toISOString());
  assert.equal(usageBounds({ tz: 'unknown-zone', now }).tzFallback, true);
  assert.equal(usageBounds({ tz: 'unknown-zone', now }).tz, 'UTC');
  for (const range of [{ range: 'custom', since: now.toISOString(), until: now.toISOString() },
    { range: 'custom', since: 'bad', until: now.toISOString() }, { range: 'bad' },
    { range: 'custom', until: now.toISOString() }, { range: 'custom', since: '2026-11-01' },
    { range: 'custom', since: '0', until: now.toISOString() },
    { range: 'custom', since: new Date(now.getTime() - 366 * 86400000 - 1).toISOString(), until: now.toISOString() }]) {
    assert.throws(() => usageBounds(range), { code: 'invalid_range', statusCode: 400 });
  }
  const start = new Date(now.getTime() - 366 * 86400000).toISOString();
  assert.equal(usageBounds({ range: 'custom', since: start, until: now.toISOString() }).since, start);
});

// Same private Store/C4 fixture; run for shared timezone fallback changes.
test('summary and full usage label missing or invalid timezones as UTC fallback', t => {
  const f = usageFixture(t), now = new Date('2026-11-06T04:00:00.000Z');
  f.metric('2026-11-06T01:00:00.000Z', 'claude', { cost: 3 });
  for (const tz of [undefined, 'unknown-zone']) {
    const summary = costSummary(f.store, { tz, now });
    const usage = usageSeries(f.store, f.reader, { tz, now });
    assert.equal(summary.tz, 'UTC');
    assert.equal(summary.tzFallback, true);
    assert.equal(usage.tz, summary.tz);
    assert.equal(usage.tzFallback, summary.tzFallback);
    assert.equal(Object.hasOwn(usage, 'costSummary'), false);
    assert.equal(usage.totals.cost, summary.sevenDay.total);
  }
});

// Same private SQLite fixture; run when shared cost boundaries change. Cross
// midnight/month observations prove each seven-day total equals seven bars.
test('seven-day costs keep seven natural days across midnight and month boundaries', t => {
  const f = usageFixture(t);
  for (let day = 24; day <= 31; day++) f.metric(`2026-10-${day}T17:00:00.000Z`, 'claude', { cost: 1 });
  for (const instant of ['2026-10-31T15:59:00.000Z', '2026-10-31T16:01:00.000Z', '2026-11-01T16:01:00.000Z']) {
    const now = new Date(instant), bounds = usageBounds({ tz: 'Asia/Singapore', now });
    const result = usageSeries(f.store, f.reader, { tz: 'Asia/Singapore', now });
    const summary = costSummary(f.store, { tz: 'Asia/Singapore', now });
    assert.equal(result.buckets.length, 7);
    assert.equal(summary.daily.length, 7);
    assert.equal(summary.sevenDay.total, result.totals.cost);
    assert.equal(summary.daily.reduce((sum, row) => sum + row.total, 0), result.totals.cost);
    assert.equal(result.totals.cost, f.store.aggregateCost(bounds) ?? 0);
    assert.equal(usageIntervals(usageBounds({ range: '24h', tz: 'Asia/Singapore', now })).length, 24);
    assert.equal(usageIntervals(usageBounds({ range: '30d', tz: 'Asia/Singapore', now })).length, 30);
  }
});

// Same isolated SQLite boundary; run when natural-day message aggregation or
// timestamp precision changes. No live C4 access; all messages are fixture rows.
test('messages use exact contiguous natural days with dense ISO bucket identities', t => {
  const f = usageFixture(t);
  const since = '2026-11-01T18:29:00.000Z', until = '2026-11-02T18:31:00.000Z';
  for (const [timestamp, direction] of [
    ['2026-11-01T18:29:59.000Z', 'in'], ['2026-11-01T18:30:00.000Z', 'out'],
    ['2026-11-02T18:29:59.000Z', 'in'], ['2026-11-02T18:30:00.000Z', 'out']
  ]) f.message(timestamp, direction);
  const calls = [], reader = { getMessageSeries(options) { calls.push(options); return f.reader.getMessageSeries(options); } };
  const result = usageSeries(f.store, reader, { range: 'custom', since, until, tz: 'Asia/Kolkata' });
  assert.equal(result.buckets.length, 3);
  assert.equal(result.buckets[0], '2026-10-31T18:30:00.000Z');
  assert.deepEqual(result.messages.map(row => [row.in, row.out]), [[1, 0], [1, 1], [0, 1]]);
  assert.deepEqual(result.totals.messages, { in: 2, out: 2 });
  assert.equal(calls.length, 1, 'all calendar intervals share one C4 query');
  assert.equal(calls[0].intervals.length, 3);
  for (let index = 1; index < calls[0].intervals.length; index++) {
    assert.equal(new Date(calls[0].intervals[index].since) - new Date(calls[0].intervals[index - 1].until), 1);
  }
});

test('calendar intervals follow DST and extreme timezone local midnights', () => {
  const intervals = usageIntervals({ since: '2026-10-31T04:00:00.000Z', until: '2026-11-02T04:59:59.999Z', tz: 'America/New_York' });
  assert.equal(intervals.length, 2);
  assert.equal(new Date(intervals[1].until) - new Date(intervals[1].since) + 1, 25 * 3600000);
  assert.equal(usageIntervals({ since: '2026-11-01T10:00:00.000Z', until: '2026-11-02T09:59:59.999Z', tz: 'Pacific/Kiritimati' })[0].at,
    '2026-11-01T10:00:00.000Z');
});

test('calendar intervals advance through the skipped Santiago midnight', () => {
  const bounds = usageBounds({ range: '7d', tz: 'America/Santiago', now: new Date('2026-09-07T12:00:00.000Z') });
  const intervals = usageIntervals(bounds);
  assert.equal(intervals.length, 7);
  const skipped = intervals.find(row => row.at === '2026-09-06T04:00:00.000Z');
  assert.ok(skipped, 'the local date begins at its first existing instant, 01:00');
  assert.equal(skipped.until, '2026-09-07T02:59:59.999Z');
  for (let index = 1; index < intervals.length; index++) {
    assert.equal(new Date(intervals[index].since) - new Date(intervals[index - 1].until), 1);
  }
});

test('calendar intervals advance through the skipped Havana midnight', () => {
  const bounds = usageBounds({ range: '7d', tz: 'America/Havana', now: new Date('2026-03-09T12:00:00.000Z') });
  const intervals = usageIntervals(bounds);
  assert.equal(intervals.length, 7);
  const skipped = intervals.find(row => row.at === '2026-03-08T05:00:00.000Z');
  assert.ok(skipped, 'the local date begins at its first existing instant, 01:00');
  assert.equal(skipped.until, '2026-03-09T03:59:59.999Z');
  for (let index = 1; index < intervals.length; index++) {
    assert.equal(new Date(intervals[index].since) - new Date(intervals[index - 1].until), 1);
  }
});

// Same owned SQLite fixture; run for timezone bucket/SQL changes. Distinct
// values on either side of local midnight prove actual rows align with labels.
test('token rows align with every natural-day bucket in the selected timezone', t => {
  const f = usageFixture(t);
  for (const [timestamp, runtime, total_input, output] of [
    ['2026-11-01T18:29:59.999Z', 'claude', 10, 1],
    ['2026-11-01T18:30:00.000Z', 'codex', 20, 2],
    ['2026-11-02T18:30:00.000Z', 'claude', 30, 3],
    ['2026-11-03T18:30:00.000Z', 'codex', 40, 4],
  ]) f.metric(timestamp, runtime, { total_input, output });
  const result = usageSeries(f.store, f.reader, { range: 'custom',
    since: '2026-11-01T18:00:00.000Z', until: '2026-11-03T19:00:00.000Z',
    tz: 'Asia/Kolkata', now: new Date('2026-11-04T00:00:00.000Z') });
  assert.deepEqual(result.buckets, [
    '2026-10-31T18:30:00.000Z', '2026-11-01T18:30:00.000Z',
    '2026-11-02T18:30:00.000Z', '2026-11-03T18:30:00.000Z',
  ]);
  assert.deepEqual(result.tokensByRuntime.map(row => [row.at, row.runtime, row.value]), [
    [result.buckets[0], 'claude', 11], [result.buckets[1], 'codex', 22],
    [result.buckets[2], 'claude', 33], [result.buckets[3], 'codex', 44],
  ]);
  assert.equal(result.totals.tokens, 110);
});

// Runtime event retention is a read boundary only; the fixture keeps old rows
// deliberately so zero cannot be mistaken for trustworthy historical coverage.
test('runtime event totals and rankings are unknown outside their retention window', t => {
  const f = usageFixture(t), now = new Date('2026-11-06T04:00:00.000Z');
  f.event('2026-11-06T01:00:00.000Z', 'rotate_done');
  f.event('2026-11-06T01:00:00.000Z', 'post_tool_use', { tool_name: 'recent' });
  f.event('2026-10-10T01:00:00.000Z', 'rotate_done');
  for (const selection of [
    { range: '30d' }, { range: 'month', now: new Date('2026-11-20T04:00:00.000Z') },
    { range: 'custom', since: '2026-10-01T00:00:00.000Z', until: now.toISOString() },
  ]) {
    const result = usageSeries(f.store, f.reader, { tz: 'UTC', now, ...selection });
    assert.equal(result.runtimeEventsUnknown, true);
    assert.equal(result.rotations, null);
    assert.equal(result.tools, null);
    assert.equal(result.totals.rotations, null);
    assert.equal(result.totals.tools, null);
  }
  const week = usageSeries(f.store, f.reader, { range: '7d', tz: 'UTC', now });
  assert.equal(week.runtimeEventsUnknown, false);
  assert.equal(week.totals.rotations, 1);
  assert.deepEqual(week.tools, [{ name: 'recent', count: 1 }]);
});

// Same private Store fixture; run for event query/ranking changes, skip UI-only.
test('tool ranking keeps the top ten in stable order and totals include all tools', t => {
  const f = usageFixture(t), timestamp = '2026-11-06T01:00:00.000Z';
  for (let index = 0; index < 12; index++) f.event(timestamp, 'post_tool_use', { tool_name: `tool-${String(index).padStart(2, '0')}` });
  f.event(timestamp, 'post_tool_use', { tool_name: 'tool-11' });
  const result = usageSeries(f.store, f.reader, { tz: 'UTC', now: new Date('2026-11-06T04:00:00.000Z') });
  assert.equal(result.totals.tools, 13);
  assert.equal(result.tools.length, 10);
  assert.deepEqual(result.tools[0], { name: 'tool-11', count: 2 });
  assert.equal(result.tools[1].name, 'tool-00');
  assert.equal(result.tools[9].name, 'tool-08');
});

// Same private Store/C4 integration; unavailable messages must not affect costs,
// tokens or runtime events, and the next successful read must recover directly.
test('usage preserves unavailable message metadata without changing other totals', t => {
  const f = usageFixture(t), options = { range: '7d', tz: 'UTC', now: new Date('2026-11-06T04:00:00.000Z') };
  f.metric('2026-11-06T01:00:00.000Z', 'claude', { cost: 7, total_input: 10, output: 2 });
  f.event('2026-11-06T01:00:00.000Z', 'rotate_done');
  f.c4.exec('DROP TABLE conversations');
  const failed = usageSeries(f.store, f.reader, options);
  assert.equal(failed.messagesReason, 'messages_unreadable');
  assert.equal(Number.isFinite(Date.parse(failed.messagesSampledAt)), true);
  assert.deepEqual(failed.totals.messages, { in: null, out: null });
  assert.ok(failed.messages.every(row => row.in === null && row.out === null));
  assert.equal(failed.totals.cost, 7);
  assert.equal(failed.totals.tokens, 12);
  assert.equal(failed.totals.rotations, 1);
  f.c4.exec('CREATE TABLE conversations(id INTEGER PRIMARY KEY, timestamp TEXT, direction TEXT)');
  const empty = usageSeries(f.store, f.reader, options);
  assert.equal(empty.messagesReason, null);
  assert.deepEqual(empty.totals.messages, { in: 0, out: 0 });
  assert.ok(empty.messages.every(row => row.in === 0 && row.out === 0));
});

// Calendar rotation placement: three distinct counts across Kolkata midnights;
// pure fixture events keep the shared bucketing assertion sensitive to shifts.
test('rotations align with each natural-day bucket across timezone boundaries', t => {
  const f = usageFixture(t);
  for (const timestamp of [
    '2026-11-01T18:29:59.999Z',
    '2026-11-01T18:30:00.000Z', '2026-11-02T18:29:59.999Z',
    '2026-11-02T18:30:00.000Z', '2026-11-02T19:00:00.000Z', '2026-11-03T18:29:59.999Z',
  ]) f.event(timestamp, 'rotate_done');
  const result = usageSeries(f.store, f.reader, { range: 'custom', tz: 'Asia/Kolkata',
    since: '2026-11-01T18:00:00.000Z', until: '2026-11-03T18:29:59.999Z', now: new Date('2026-11-04T00:00:00.000Z') });
  assert.deepEqual(result.buckets, ['2026-10-31T18:30:00.000Z', '2026-11-01T18:30:00.000Z', '2026-11-02T18:30:00.000Z']);
  assert.deepEqual(result.rotations, [
    { at: result.buckets[0], value: 1 }, { at: result.buckets[1], value: 2 }, { at: result.buckets[2], value: 3 },
  ]);
  assert.equal(result.totals.rotations, 6);
});
