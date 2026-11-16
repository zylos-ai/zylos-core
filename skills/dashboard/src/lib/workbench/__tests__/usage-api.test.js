import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../store.js';
import { usageSummary, usagePricing } from '../usage-api.js';
import { usageSeries } from '../usage-series.js';

function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let sequence = 0;
  const metric = (timestamp, group, runtime, dimensions, metricName = 'usage_event', value = 9999, sessionId = null) => {
    store.insertMetric({ timestamp, runtime, session_group: group,
      session_id: sessionId ?? `request-${++sequence}`, metric_name: metricName,
      metric_value: value, dimensions, source: 'jsonl_usage', confidence: 'actual' });
  };
  return { store, metric };
}

// SQLite integration uses only an in-memory real Store. No filesystem paths,
// child, tmux, PM2, runtime or network resource is opened. Run when usage queries,
// group attribution, timezone windows or cache arithmetic change; skip UI-only work.
test('instance and per-group usage share calendar windows and add to the same totals', t => {
  const { store, metric } = fixture(t), now = new Date('2026-11-15T02:00:00.000Z');
  metric('2026-11-14T16:00:00.000Z', 'telegram:alpha', 'claude', { total_input: 100, output: 20, cache_read: 20, cost: 1 });
  metric('2026-11-15T01:00:00.000Z', 'telegram:beta', 'codex', { total_input: 300, output: 30, cache_read: 270, cost: 3 });
  metric('2026-11-14T15:59:59.999Z', null, 'claude', { total_input: 50, output: 5, cache_read: 10, cost: 0.5 });
  metric('2026-11-08T16:00:00.000Z', 'origin', 'codex', { total_input: 200, output: 50, cache_read: 100 }, 'api_request_tokens', 200, 'legacy');
  metric('2026-11-08T16:00:00.000Z', null, 'codex', { model: 'legacy' }, 'api_request_cost', 2, 'legacy');
  metric('2026-11-08T15:59:59.999Z', 'telegram:alpha', 'claude', { total_input: 5000, output: 100, cache_read: 3000, cost: 50 });
  metric('2026-11-15T02:00:00.001Z', 'telegram:beta', 'codex', { total_input: 9000, cost: 100 });
  const summary = usageSummary(store, { tz: 'Asia/Singapore', now });
  assert.equal(summary.today.since, '2026-11-14T16:00:00.000Z');
  assert.equal(summary.sevenDay.since, '2026-11-08T16:00:00.000Z');
  assert.equal(summary.today.tokens, 450);
  assert.equal(summary.today.cacheHitRate, 290 / 400);
  assert.equal(summary.today.cost, 4);
  assert.equal(summary.sevenDay.tokens, 755);
  assert.equal(summary.sevenDay.cost, 6.5);
  assert.equal(summary.today.byRuntime.claude.cacheHitRate, 0.2);
  assert.equal(summary.today.byRuntime.codex.tokens, 330);
  const groups = ['origin', 'telegram:alpha', 'telegram:beta'].map(group => usageSummary(store, { tz: summary.tz, now, group }));
  assert.equal(groups[0].sevenDay.tokens, 305, 'NULL group history belongs to Origin');
  assert.equal(groups[0].sevenDay.cost, 2.5);
  for (const period of ['today', 'sevenDay']) {
    for (const field of ['tokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cost']) {
      assert.equal(groups.reduce((sum, group) => sum + group[period][field], 0), summary[period][field], `${period}.${field}`);
    }
  }
  const missing = usageSummary(store, { tz: summary.tz, now, group: 'not-present' });
  assert.equal(missing.today.tokens, 0);
  assert.equal(missing.today.cacheHitRate, null);
});

// Same in-memory integration boundary; run for day-boundary and fallback changes.
test('usage days follow the instance timezone through DST and label fallback timezone', t => {
  const { store, metric } = fixture(t), now = new Date('2026-11-01T18:00:00.000Z');
  metric('2026-11-01T04:00:00.000Z', 'origin', 'claude', { total_input: 20, cache_read: 10, cost: 1 });
  metric('2026-11-01T03:59:59.999Z', 'origin', 'claude', { total_input: 40, cost: 2 });
  const summary = usageSummary(store, { tz: 'America/New_York', now });
  assert.equal(summary.today.since, '2026-11-01T04:00:00.000Z');
  assert.equal(summary.today.cost, 1);
  assert.equal(summary.sevenDay.since, '2026-10-26T04:00:00.000Z');
  assert.equal(summary.sevenDay.cost, 3);
  const fallback = usageSummary(store, { tz: 'not-a-zone', now });
  assert.equal(fallback.tz, 'UTC');
  assert.equal(fallback.tzFallback, true);
  assert.equal(fallback.today.cost, 3);
});

// Same in-memory boundary with only C4 message aggregation injected; no messages
// are needed to verify product usage/cache bucket arithmetic. Run for series changes.
test('series combines weighted cache rates with legacy tokens in the same buckets', t => {
  const { store, metric } = fixture(t), now = new Date('2026-11-15T02:00:00.000Z');
  metric('2026-11-15T00:10:00.000Z', 'a', 'claude', { total_input: 100, output: 20, cache_read: 20, cost: 1 });
  metric('2026-11-15T00:30:00.000Z', null, 'codex', { total_input: 300, output: 30, cache_read: 270 }, 'api_request_tokens', 9999);
  const reader = { getMessageSeries: () => ({ points: [], total: { in: 0, out: 0 } }) };
  const series = usageSeries(store, reader, { range: '24h', tz: 'Asia/Singapore', now });
  assert.equal(series.buckets.length, 24);
  assert.equal(series.cache.length, series.buckets.length);
  assert.equal(series.totals.tokens, 450);
  assert.equal(series.totals.cacheHitRate, 290 / 400);
  assert.equal(series.cache.find(row => row.at === '2026-11-15T00:00:00.000Z').value, 290 / 400);
  assert.equal(series.cache[0].value, null, 'no input is unknown cache rate');
  for (let index = 0; index < series.cache.length; index++) assert.equal(series.cache[index].at, series.buckets[index]);
  for (const range of ['7d', '30d']) {
    const value = usageSeries(store, reader, { range, tz: 'Asia/Singapore', now });
    assert.equal(value.buckets.length, range === '7d' ? 7 : 30);
    assert.equal(value.totals.tokens, 450);
    assert.equal(value.cache.at(-1).value, 290 / 400);
  }
});

// Same private in-memory Store; run when model cost matching or legacy usage changes.
test('pricing reports priced models and missing prices within seven local days', t => {
  const { store, metric } = fixture(t), now = new Date('2026-11-15T02:00:00.000Z');
  metric('2026-11-15T00:00:00.000Z', 'a', 'claude', { total_input: 100, output: 20, cost: 1, model: 'known' });
  metric('2026-11-15T00:00:00.000Z', 'a', 'claude', { total_input: 200, output: 30, model: 'missing' });
  metric('2026-11-15T00:00:00.000Z', null, 'codex', { total_input: 400, output: 40, model: 'legacy' }, 'api_request_tokens', 400, 'legacy');
  metric('2026-11-15T00:00:00.000Z', null, 'codex', { model: 'legacy' }, 'api_request_cost', 2, 'legacy');
  metric('2026-11-08T15:59:59.999Z', 'a', 'claude', { total_input: 999, model: 'old' });
  const value = usagePricing(store, { tz: 'Asia/Singapore', now });
  assert.equal(value.models.length, 2);
  assert.equal(value.models.find(row => row.model === 'known').cost, 1);
  assert.equal(value.unmatched.length, 1);
  assert.equal(value.unmatched[0].model, 'missing');
  assert.equal(value.unmatched[0].tokens, 230);
});

// Same in-memory Store boundary; run for normalized token dimensions or legacy
// fallbacks. Output-only modern requests must not use the metric's scalar value.
test('modern output-only and empty usage never invent input tokens from scalar values', t => {
  const { store, metric } = fixture(t), now = new Date('2026-11-15T02:00:00.000Z');
  metric('2026-11-15T00:00:00.000Z', 'origin', 'codex', { model: 'output-only', output: 400 });
  metric('2026-11-15T00:00:00.000Z', 'origin', 'codex', { model: 'empty' });
  metric('2026-11-15T00:00:00.000Z', null, 'claude', { model: 'legacy', cache_read: 40 }, 'api_request_tokens', 100);
  const summary = usageSummary(store, { tz: 'UTC', now });
  assert.equal(summary.today.inputTokens, 100);
  assert.equal(summary.today.tokens, 500);
  assert.equal(summary.today.cacheHitRate, 0.4);
  const pricing = usagePricing(store, { tz: 'UTC', now });
  assert.equal(pricing.unmatched.length, 2);
  assert.equal(pricing.unmatched.find(row => row.model === 'output-only').tokens, 400);
  assert.equal(pricing.unmatched.find(row => row.model === 'legacy').tokens, 100);
});
