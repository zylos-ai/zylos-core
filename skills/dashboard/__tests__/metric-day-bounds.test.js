import assert from 'node:assert/strict';
import test from 'node:test';
import { dayBoundsUTC, MetricResolver } from '../src/lib/metric-resolver.js';
import { Store } from '../src/lib/store.js';

for (const [zone, expected] of [
  ['UTC', '2026-10-27T00:00:00.000Z'],
  ['Asia/Shanghai', '2026-10-26T16:00:00.000Z'],
  ['America/Los_Angeles', '2026-10-27T07:00:00.000Z'],
]) {
  for (const ms of ['000', '562', '999']) {
    test(`${zone} midnight is stable with current milliseconds .${ms}`, (t) => {
      const timestamp = `2026-10-27T12:00:00.${ms}Z`;
      t.mock.timers.enable({ apis: ['Date'], now: new Date(timestamp) });
      assert.deepEqual(dayBoundsUTC(zone), { since: expected, until: timestamp });
    });
  }
}

for (const [timestamp, today, week] of [
  ['2026-03-08T18:00:00.562Z', '2026-03-08T08:00:00.000Z', '2026-03-01T08:00:00.000Z'],
  ['2026-11-01T18:00:00.562Z', '2026-11-01T07:00:00.000Z', '2026-10-25T07:00:00.000Z'],
  ['2026-03-15T18:00:00.562Z', '2026-03-15T07:00:00.000Z', '2026-03-08T08:00:00.000Z'],
  ['2026-11-08T18:00:00.562Z', '2026-11-08T08:00:00.000Z', '2026-11-01T07:00:00.000Z'],
]) {
  test(`LA calendar boundaries use each midnight's offset at ${timestamp}`, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(timestamp) });
    assert.deepEqual(dayBoundsUTC('America/Los_Angeles'), { since: today, until: timestamp });
    assert.deepEqual(dayBoundsUTC('America/Los_Angeles', 7), { since: week, until: timestamp });
  });
}

test('midnight formats as hour zero and retains the correct local date', () => {
  assert.equal(dayBoundsUTC('UTC', 0, new Date('2026-10-27T00:00:00.562Z')).since,
    '2026-10-27T00:00:00.000Z');
  assert.equal(dayBoundsUTC('Asia/Shanghai', 0, new Date('2026-10-26T16:00:00.562Z')).since,
    '2026-10-26T16:00:00.000Z');
});

test('usage_event within the first second is consistently included in the daily aggregate', (t) => {
  const oldTZ = process.env.TZ;
  process.env.TZ = 'UTC';
  t.after(() => {
    if (oldTZ === undefined) delete process.env.TZ;
    else process.env.TZ = oldTZ;
  });
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-27T12:00:00.000Z') });
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (const [timestamp, cost] of [
    ['2026-10-26T23:59:59.999Z', 10],
    ['2026-10-27T00:00:00.562Z', 2],
    ['2026-10-27T12:01:00.000Z', 20],
  ]) {
    store.insertMetric({ timestamp, runtime: 'codex', metric_name: 'usage_event',
      metric_value: 100, dimensions: { cost }, source: 'jsonl_usage', confidence: 'actual' });
  }
  const resolver = new MetricResolver(store, {}, { runtime: 'codex' });
  for (const ms of ['000', '562', '999']) {
    t.mock.timers.setTime(new Date(`2026-10-27T12:00:00.${ms}Z`).getTime());
    assert.equal(resolver.resolveAggregated('cost').today, 2);
  }
});
