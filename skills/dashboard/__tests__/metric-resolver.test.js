import { usageSummary } from '../src/lib/workbench/usage-api.js';
import { Store } from '../src/lib/store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashApiKey, exchangeApiKeyForToken } from '../src/lib/auth.js';
import { usageServer } from './fixtures/usage-server.js';

const request = (f, route, options = {}) => fetch(f.origin + route,
  { ...options, headers: { ...f.headers, ...options.headers }, signal: AbortSignal.timeout(3000) });


// HTTP integration: real routes/AuthGate/Store on private random loopback;
// mocked CLI/Core BEFORE index import, owned timers/DB/listener cleanup in
// usageServer. Run for these endpoints/auth/quota payload changes, skip UI-only.
// Runner must isolate HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private tmux socket.
test('usage and resource reads enforce auth while retired metric routes return 404', async t => {
  let accountRecord = { recordedAt: 1000, live: false };
  const f = await usageServer(t, { auth: { password: 'scrypt:fixture' } }, { snapshot: core => ({
    readAt: Date.now(), rows: [], sources: {}, instance: { accounts: { claude: core.accountUsage ? { ...core.accountUsage.seven_day, ...accountRecord } : null } }
  }) });
  f.core.accountUsage = { seven_day: { used_percentage: 21 }, five_hour: { used_percentage: 73 } };
  f.store.insertApiKey({ name: 'reader', keyHash: hashApiKey('zylos_ak_usage_fixture'), scope: 'read' });
  const headers = { Authorization: `Bearer ${exchangeApiKeyForToken('zylos_ak_usage_fixture').token}` };
  for (const route of ['/api/usage/series', '/api/instance/resources', '/api/instance', '/api/usage/summary']) {
    assert.equal((await request(f, route)).status, 401);
    assert.equal((await request(f, route, { headers })).status, 200);
  }
  assert.equal((await request(f, '/api/usage/series?range=custom&since=2026-01-01&until=2026-01-01', { headers })).status, 400);
  for (const range of ['1d', 'constructor', 'toString', '__proto__']) {
    const invalid = await request(f, '/api/instance/resources?range=' + range, { headers });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'invalid_range');
  }
  for (const route of ['/api/metrics/rate_limit', '/api/metrics/rate_limit_7d', '/api/metrics/context_pct', '/api/state']) {
    assert.equal((await request(f, route, { headers })).status, 404, route);
  }
  const readAccount = async () => (await (await request(f, '/api/instance', { headers })).json()).accounts.claude;
  let account = await readAccount();
  assert.equal(account.used_percentage, 21);
  assert.equal(account.live, false);
  assert.equal(account.recordedAt, new Date(1000).toISOString());
  assert.equal(Object.hasOwn(account, 'five_hour'), false);
  accountRecord = { recordedAt: 2000, live: true };
  account = await readAccount();
  assert.equal(account.used_percentage, 21);
  assert.equal(account.live, true);
  assert.equal(account.recordedAt, new Date(2000).toISOString());
  f.core.accountUsage = null; accountRecord = null;
  assert.equal(await readAccount(), null);
  assert.equal((await request(f, '/api/groups/a/name', { method: 'PUT',
    body: JSON.stringify({ name: 'fixture' }), headers: { ...headers, 'content-type': 'application/json' } })).status, 403);
  assert.equal(f.store.queryMetrics({ name: 'account_quota' }).length, 0);
});

// Same isolated HTTP lifecycle; run for summary projection/query ownership.
// Throws on expensive full-usage readers to prove strip refresh reads cost only.
test('cost summary projection skips message and project aggregation', async t => {
  const f = await usageServer(t);
  t.mock.method(f.reader, 'getMessageSeries', () => assert.fail('summary must not read messages'));
  t.mock.method(f.store, 'getProjectDistribution', () => assert.fail('summary must not read projects'));
  f.store.insertMetric({ timestamp: new Date().toISOString(), runtime: 'claude',
    metric_name: 'api_request_cost', metric_value: 5, dimensions: {}, source: 'jsonl_usage', confidence: 'actual' });
  const response = await request(f, '/api/usage/summary');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.scope, 'all_groups');
  assert.equal(result.today.cost, 5);
  assert.equal(Object.hasOwn(result, 'buckets'), false);
});

// Real HTTP routes and private Store prove the three consumers share both the
// cost UNION and seven-natural-day bounds, including legacy costs without a
// model. Run when any shared cost consumer changes; skip UI-only changes. Same
// isolated usageServer lifecycle, loopback listener and mocked-before-import
// Core/CLI as above; Date alone is fixed, request/cleanup timers stay real.
test('pricing usage and strip costs share natural days and include legacy rows', async t => {
  const now = new Date('2026-11-06T04:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const oldTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Singapore';
  t.after(() => {
    if (oldTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = oldTimezone;
  });
  const f = await usageServer(t);
  const metric = (timestamp, runtime, dimensions, metric_name = 'usage_event', metric_value = 9999) =>
    f.store.insertMetric({ timestamp, runtime, session_group: runtime === 'claude' ? 'a' : 'b',
      metric_name, metric_value, dimensions, source: 'jsonl_usage', confidence: 'actual' });
  for (const day of ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']) {
    metric(day + 'T01:00:00.000Z', 'claude', { model: 'claude-fixture', cost: 1, total_input: 10 });
    metric(day + 'T01:00:00.000Z', 'codex', { model: 'codex-fixture', cost: 2, output: 20 });
  }
  metric('2026-11-06T02:00:00.000Z', 'claude', { model: 'claude-fixture' }, 'api_request_cost', 5);
  metric('2026-11-06T02:00:00.000Z', 'codex', {}, 'api_request_cost', 7);
  metric('2026-11-06T02:00:00.000Z', 'codex', { model: 'unpriced', total_input: 1000, output: 400 });
  metric('2026-10-30T15:59:59.999Z', 'claude', { model: 'outside-before', cost: 997 });
  metric('2026-11-06T04:00:00.001Z', 'codex', { model: 'outside-after', cost: 998 });
  metric('2026-11-06T04:00:00.001Z', 'codex', { model: 'unpriced-future', total_input: 9999 });
  const read = async route => {
    const response = await request(f, route);
    assert.equal(response.status, 200, route);
    return response.json();
  };
  const usage = await read('/api/usage/series?range=7d');
  const strip = await read('/api/usage/summary');
  const pricing = await read('/api/usage/pricing');
  assert.equal(usage.since, '2026-10-30T16:00:00.000Z');
  assert.equal(usage.until, now.toISOString());
  assert.equal(usage.buckets.length, 7);
  assert.equal(usage.totals.cost, 33);
  assert.deepEqual(usage.totals.costByRuntime, { claude: 12, codex: 21 });
  assert.equal(pricing.models.reduce((sum, row) => sum + row.cost, 0), usage.totals.cost);
  for (const runtime of ['claude', 'codex']) assert.equal(
    pricing.models.filter(row => row.runtime === runtime).reduce((sum, row) => sum + row.cost, 0),
    usage.totals.costByRuntime[runtime]);
  assert.equal(pricing.models.find(row => row.runtime === 'codex' && row.model === null).cost, 7);
  assert.equal(pricing.models.length, 3);
  assert.equal(new Set(pricing.models.map(({ runtime, model }) => JSON.stringify([runtime, model]))).size, pricing.models.length);
  assert.equal(pricing.models.find(row => row.runtime === 'claude' && row.model === 'claude-fixture').cost, 12);
  assert.equal(pricing.models.find(row => row.runtime === 'codex' && row.model === 'codex-fixture').cost, 14);
  assert.equal(pricing.models.some(row => row.model?.startsWith('outside-')), false);
  assert.deepEqual(pricing.unmatched, [{ runtime: 'codex', model: 'unpriced', tokens: 1400 }]);
  assert.equal(strip.sevenDay.cost, usage.totals.cost);
  assert.equal(strip.today.cost, 15);
  assert.equal(Object.hasOwn(usage, 'costSummary'), false);
  assert.deepEqual(Object.keys(strip).sort(), ['scope', 'sevenDay', 'today', 'tz', 'tzFallback'], 'the strip summary has no per-day series');
  assert.equal(f.store.aggregateCost(usage), usage.totals.cost);
  assert.equal(f.store.aggregateCost({ since: '2026-11-05T16:00:00.000Z', until: usage.until }), strip.today.cost);
});

// HTTP range validation uses the real route and private usageServer lifecycle.
// Run for usage range parsing/limits; skip unrelated UI changes. The fixture's
// loopback listener, DB, HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and cleanup are isolated.
test('custom usage requires both bounds and caps the selected span at 366 days', async t => {
  const f = await usageServer(t);
  for (const query of [
    'until=2026-11-06', 'since=2026-01-01', 'since=&until=2026-11-06',
    'since=2026-01-01&until=', 'since=0&until=2026-11-06',
    'since=2025-01-01&until=2026-01-03',
    'since=2025-01-01T00:00:00.000Z&until=2026-01-02T00:00:00.001Z',
  ]) {
    const response = await request(f, '/api/usage/series?range=custom&' + query);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error.code, 'invalid_range', query);
  }
  const accepted = await request(f,
    '/api/usage/series?range=custom&since=2025-01-01T00:00:00.000Z&until=2026-01-02T00:00:00.000Z');
  assert.equal(accepted.status, 200);
});

// Real usage-series HTTP route locks the 7/30-natural-day boundary and
// UTC fallback contract. Fixed Date affects range selection only; listener and
// request deadlines remain real. Same private usageServer lifecycle as above.
test('usage series periods include exactly seven or thirty natural days', async t => {
  const now = new Date('2026-11-06T04:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const oldTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Singapore';
  t.after(() => { if (oldTimezone === undefined) delete process.env.TZ; else process.env.TZ = oldTimezone; });
  const f = await usageServer(t);
  assert.equal((await request(f, '/api/metrics/aggregate?metric=cost&period=7d')).status, 404);
  for (const [period, start] of [['7d', '2026-10-30T16:00:00.000Z'], ['30d', '2026-10-07T16:00:00.000Z']]) {
    const before = new Date(new Date(start).getTime() - 1).toISOString();
    for (const [timestamp, cost] of [[before, 1000], [start, 3], [now.toISOString(), 5]]) {
      f.store.insertMetric({ timestamp, runtime: 'claude', metric_name: 'usage_event', metric_value: cost,
        dimensions: { cost, total_input: cost, output: 1 }, source: 'jsonl_usage', confidence: 'actual' });
    }
    const response = await request(f, `/api/usage/series?range=${period}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.since, start);
    assert.equal(body.until, now.toISOString());
    assert.equal(body.totals.cost, 8);
    assert.equal(body.totals.inputTokens, 8);
    assert.equal(body.totals.tokens, 10);
    assert.equal(body.totals.cacheReadTokens, 0);
    assert.equal(body.totals.cacheHitRate, 0);
    f.store.db.prepare('DELETE FROM metric_points').run();
  }
  process.env.TZ = 'invalid-zone';
  const fallback = await request(f, '/api/usage/series?range=7d');
  assert.equal(fallback.status, 200);
  const value = await fallback.json();
  assert.equal(value.since, '2026-10-31T00:00:00.000Z');
  assert.equal(value.tzFallback, true);
});

test('today and seven-day costs use the current requested instance time zone on every read', () => {
  const store = new Store(':memory:');
  try {
    const midnight = (iso, timeZone) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
    for (const zone of ['Asia/Shanghai', 'America/Los_Angeles', null]) {
      const result = usageSummary(store, { tz: zone });
      assert.equal(midnight(result.today.since, zone ?? 'UTC'), '00:00');
      assert.equal(midnight(result.sevenDay.since, zone ?? 'UTC'), '00:00');
    }
  } finally { store.close(); }
});
