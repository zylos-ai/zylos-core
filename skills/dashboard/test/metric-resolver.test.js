import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MetricResolver } from '../src/lib/metric-resolver.js';
import { hashApiKey, exchangeApiKeyForToken } from '../src/lib/auth.js';
import { usageServer } from './fixtures/usage-server.js';

const request = (origin, route, options = {}) => fetch(origin + route,
  { ...options, signal: AbortSignal.timeout(3000) });

test('removed five-hour metric never reads current or historical samples while weekly remains', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  for (const runtime of ['claude', 'codex']) {
    let reads = 0;
    const account = runtime === 'claude'
      ? { five_hour: { used_percentage: 73 }, seven_day: { used_percentage: 21, resets_at: future } }
      : { fiveHour: { usedPercentage: 73 }, sevenDay: { usedPercentage: 21, resetsAt: future } };
    const resolver = new MetricResolver({ latestMetric() { assert.fail('historical metrics must not be read'); } },
      { statusline: { getAccountUsage() { reads++; return { runtime, value: account }; } } }, { runtime });
    const removed = resolver.resolve('rate_limit');
    assert.equal(removed.value, null);
    assert.equal(removed.fallback_reason, 'Unknown metric: rate_limit');
    assert.equal(reads, 0);
    const weekly = resolver.resolve('rate_limit_7d');
    assert.equal(weekly.value, 21);
    assert.equal(weekly.dimensions.rate_limit_7d_resets_at, future);
    assert.equal(reads, 1);
  }
});

// HTTP integration: real routes/AuthGate/Store on private random loopback;
// mocked CLI/Core BEFORE index import, owned timers/DB/listener cleanup in
// usageServer. Run for these endpoints/auth/quota payload changes, skip UI-only.
// Runner must isolate HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private tmux socket.
test('usage and host reads enforce auth and removed five-hour routes return unknown', async t => {
  const f = await usageServer(t, { auth: { enabled: true, password: 'scrypt:fixture' } });
  f.core.accountUsage = { seven_day: { used_percentage: 21 }, five_hour: { used_percentage: 73 } };
  f.core.accountUsageRecord = { recordedAt: 1000, live: false };
  f.store.insertApiKey({ name: 'reader', keyHash: hashApiKey('zylos_ak_usage_fixture'), scope: 'read' });
  const headers = { Authorization: `Bearer ${exchangeApiKeyForToken('zylos_ak_usage_fixture').token}` };
  for (const route of ['/api/workbench/usage', '/api/workbench/host', '/api/state', '/api/metrics/rate_limit_7d']) {
    assert.equal((await request(f.origin, route)).status, 401);
    assert.equal((await request(f.origin, route, { headers })).status, 200);
  }
  assert.equal((await request(f.origin, '/api/workbench/usage?range=custom&since=2026-01-01&until=2026-01-01', { headers })).status, 400);
  for (const range of ['1d', 'constructor', 'toString', '__proto__']) {
    const invalid = await request(f.origin, '/api/workbench/host?range=' + range, { headers });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'invalid_range');
  }
  const removed = await request(f.origin, '/api/metrics/rate_limit', { headers });
  assert.equal(removed.status, 404);
  assert.equal((await removed.json()).error, 'unknown_metric');
  const weekly = await request(f.origin, '/api/metrics/rate_limit_7d', { headers });
  assert.equal(weekly.status, 200);
  const recordedMetric = await weekly.json();
  assert.equal(recordedMetric.value, null);
  assert.equal(recordedMetric.confidence, 'none');
  f.core.observation = { usage: { valid: true, sampledAt: Date.now(), value: { context_window: { used_percentage: 37 } } } };
  const context = await (await request(f.origin, '/api/metrics/context_pct', { headers })).json();
  assert.equal(context.value, 37, 'recorded weekly quota must not suppress the independent context metric');
  assert.equal(context.confidence, 'actual');
  const state = await (await request(f.origin, '/api/state', { headers })).json();
  assert.equal(Object.hasOwn(state, 'rate_limit_pct'), false);
  assert.equal(state.rate_limit_7d_pct, 21);
  assert.equal(state.rate_limit_7d_live, false);
  assert.equal(state.rate_limit_7d_recorded_at, 1000);
  f.core.accountUsageRecord = { recordedAt: 2000, live: true };
  const liveState = await (await request(f.origin, '/api/state', { headers })).json();
  assert.equal(liveState.rate_limit_7d_live, true);
  assert.equal(liveState.rate_limit_7d_recorded_at, 2000);
  const liveMetric = await (await request(f.origin, '/api/metrics/rate_limit_7d', { headers })).json();
  assert.equal(liveMetric.value, 21);
  assert.equal(liveMetric.confidence, 'actual');
  f.core.accountUsage = null; f.core.accountUsageRecord = null;
  const emptyState = await (await request(f.origin, '/api/state', { headers })).json();
  for (const key of ['rate_limit_7d_pct', 'rate_limit_7d_live', 'rate_limit_7d_recorded_at']) assert.equal(emptyState[key], null);
  const emptyMetric = await (await request(f.origin, '/api/metrics/rate_limit_7d', { headers })).json();
  assert.equal(emptyMetric.value, null);
  assert.equal(emptyMetric.confidence, 'none');
  assert.equal((await request(f.origin, '/api/workbench/groups/a/name', { method: 'PUT',
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
  const response = await request(f.origin, '/api/workbench/usage?summary=cost');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(Object.keys(result), ['costSummary']);
  assert.equal(result.costSummary.today.total, 5);
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
    const response = await request(f.origin, route);
    assert.equal(response.status, 200, route);
    return response.json();
  };
  const usage = await read('/api/workbench/usage?range=7d');
  const strip = (await read('/api/workbench/usage?summary=cost')).costSummary;
  const pricing = await read('/api/workbench/pricing');
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
  assert.equal(strip.sevenDay.total, usage.totals.cost);
  assert.equal(strip.today.total, 15);
  assert.equal(Object.hasOwn(usage, 'costSummary'), false);
  assert.equal(strip.daily.length, 7);
  assert.equal(strip.daily.reduce((sum, day) => sum + day.total, 0), usage.totals.cost);
  assert.equal(f.store.aggregateCost(usage), usage.totals.cost);
  assert.equal(f.store.aggregateCost({ since: '2026-11-05T16:00:00.000Z', until: usage.until }), strip.today.total);
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
    const response = await request(f.origin, '/api/workbench/usage?range=custom&' + query);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error.code, 'invalid_range', query);
  }
  const accepted = await request(f.origin,
    '/api/workbench/usage?range=custom&since=2025-01-01T00:00:00.000Z&until=2026-01-02T00:00:00.000Z');
  assert.equal(accepted.status, 200);
});

// Real aggregate HTTP route locks the changed 7/30-natural-day boundary and
// UTC fallback contract. Fixed Date affects range selection only; listener and
// request deadlines remain real. Same private usageServer lifecycle as above.
test('aggregate HTTP periods include exactly seven or thirty natural days', async t => {
  const now = new Date('2026-11-06T04:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const f = await usageServer(t);
  for (const [period, start] of [
    ['7d', '2026-10-30T16:00:00.000Z'], ['30d', '2026-10-07T16:00:00.000Z'],
  ]) {
    const before = new Date(new Date(start).getTime() - 1).toISOString();
    for (const [timestamp, cost] of [[before, 1000], [start, 3], [now.toISOString(), 5]]) {
      f.store.insertMetric({ timestamp, runtime: 'claude', metric_name: 'usage_event', metric_value: cost,
        dimensions: { cost, total_input: cost, output: 1 }, source: 'jsonl_usage', confidence: 'actual' });
    }
    for (const metric of ['cost', 'tokens']) {
      const response = await request(f.origin, `/api/metrics/aggregate?metric=${metric}&period=${period}&tz=Asia%2FSingapore`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.since, start);
      assert.equal(body.until, now.toISOString());
      if (metric === 'cost') assert.equal(body.value, 8);
      else assert.deepEqual(body.value, { input: 8, output: 2, cache_read: 0, cache_rate: 0 });
    }
    f.store.db.prepare('DELETE FROM metric_points').run();
  }
  const fallback = await request(f.origin, '/api/metrics/aggregate?metric=cost&period=7d&tz=invalid-zone');
  assert.equal(fallback.status, 200);
  assert.equal((await fallback.json()).since, '2026-10-31T00:00:00.000Z');
});

// Subprocess integration: real statusline CJS through stdin and an owned random
// loopback recipient. Run when ingest extraction/transport changes; skip other
// UI/query changes. Private config is written/read back BEFORE spawn; no default
// port can be used. Private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; child timeout/kill,
// bounded request payload and server connections are tied to this test cleanup.
test('statusline ingest emits weekly dimensions and drops five-hour dimensions', { timeout: 5000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ingest-'));
  let child, timer;
  const server = http.createServer();
  t.after(async () => {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL'); await exited;
    }
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  const configPath = path.join(dir, 'components/dashboard/config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ port: address.port }));
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).port, address.port);
  const received = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('statusline fixture received no request')), 2500);
    server.on('request', (req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy(new Error('fixture payload too large')); });
      req.on('error', reject);
      req.on('end', () => {
        try { resolve({ url: req.url, method: req.method, value: JSON.parse(body) }); }
        catch (error) { reject(error); }
        res.end('{}');
      });
    });
  });
  const env = { ...process.env, HOME: dir, ZYLOS_DIR: dir, PM2_HOME: path.join(dir, 'pm2'),
    TMPDIR: dir, NODE_OPTIONS: '' };
  delete env.ZYLOS_SESSION_GROUP; delete env.TMUX;
  child = spawn(process.execPath, [fileURLToPath(new URL('../src/lib/statusline-ingest.cjs', import.meta.url))],
    { env, stdio: ['pipe', 'ignore', 'pipe'], timeout: 2500, killSignal: 'SIGKILL' });
  let errors = '';
  child.stderr.on('data', chunk => { if (errors.length < 4096) errors += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  child.stdin.end(JSON.stringify({ session_id: 'fixture', rate_limits: {
    five_hour: { used_percentage: 73, resets_at: 123 }, seven_day: { used_percentage: 21, resets_at: 456 }
  } }));
  const [requestData, exit] = await Promise.all([received, exited]);
  clearTimeout(timer);
  assert.equal(exit.code, 0, errors);
  assert.equal(exit.signal, null);
  assert.equal(requestData.url, '/api/ingest/statusline');
  assert.equal(requestData.method, 'POST');
  assert.equal(requestData.value.metrics.length, 1);
  assert.deepEqual(requestData.value.metrics[0].dimensions, { rate_limit_7d: 21, rate_limit_7d_resets_at: 456 });
});

test('today and seven-day costs are counted in the instance time zone read on every call', () => {
  const calls = [];
  const store = { aggregateCost(bounds) { calls.push(bounds); return 0; } };
  let zone = 'Asia/Shanghai';
  const resolver = new MetricResolver(store, {}, {}, { timeZone: () => zone });
  const midnight = (iso, timeZone) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(iso));
  for (const next of ['Asia/Shanghai', 'America/Los_Angeles', null]) {
    zone = next; calls.length = 0;
    resolver.resolveAggregated('cost');
    const [today, week] = calls;
    assert.equal(midnight(today.since, next ?? 'UTC'), '00:00', `today starts at midnight in ${next ?? 'UTC'}`);
    assert.equal(midnight(week.since, next ?? 'UTC'), '00:00');
  }
});
