import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PM2Collector } from '../src/lib/collectors/pm2-collector.js';
import { StatuslineCollector } from '../src/lib/collectors/statusline-collector.js';
import { SystemCollector } from '../src/lib/collectors/system-collector.js';
import { MetricResolver } from '../src/lib/metric-resolver.js';
import { runMetricMaintenance } from '../src/lib/metric-maintenance.js';
import { Store } from '../src/lib/store.js';
import { buildSystemPayload } from '../src/lib/system-api.js';

function tmpDir(prefix = 'metric-aggregation-phase5-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withStore(fn) {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'dashboard.db'));
  try {
    return await fn(store, dir);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('PM2Collector writes one summary row and upserts per-process latest state', async () => {
  await withStore(async (store) => {
    const collector = new PM2Collector(store, { runtime: 'codex' });
    collector._execPm2Jlist = async () => JSON.stringify([
      {
        name: 'zylos-dashboard',
        pm2_env: { status: 'online', restart_time: 2, pm_uptime: Date.now() - 5000 },
        monit: { cpu: 3.5, memory: 104857600 }
      },
      {
        name: 'zylos-telegram',
        pm2_env: { status: 'stopped', restart_time: 1, pm_uptime: Date.now() - 10000 },
        monit: { cpu: 1.25, memory: 52428800 }
      }
    ]);

    await collector.collect();

    const rows = store.queryMetrics({ name: 'pm2_summary' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].metric_value, 2);
    assert.equal(rows[0].runtime, 'codex');
    assert.equal(rows[0].dimensions.total_memory_mb, 150);
    assert.equal(rows[0].dimensions.total_cpu_pct, 4.75);
    assert.equal(rows[0].dimensions.total_restarts, 3);
    assert.equal(rows[0].dimensions.online, 1);
    assert.equal(rows[0].dimensions.stopped, 1);

    const state = store.getAllPm2State();
    assert.deepEqual(state.map(p => p.process_name), ['zylos-dashboard', 'zylos-telegram']);
    assert.equal(state[0].status, 'online');
    assert.equal(state[0].memory_bytes, 104857600);
  });
});

test('SystemCollector writes a single system_summary row', async () => {
  await withStore(async (store, dir) => {
    const collector = new SystemCollector(store, { zylosDir: dir, runtime: 'codex' });
    await collector.collect();

    const rows = store.queryMetrics({ name: 'system_summary' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].runtime, 'codex');
    assert.equal(rows[0].source, 'system');
    assert.equal(rows[0].dimensions.path, dir);
    assert.equal(typeof rows[0].dimensions.mem_total_bytes, 'number');
    assert.equal(typeof rows[0].dimensions.disk_free_bytes, 'number');
  });
});

test('StatuslineCollector writes one statusline_summary row with capacity dimensions', async () => {
  await withStore(async (store, dir) => {
    const statusDir = path.join(dir, 'activity-monitor');
    fs.mkdirSync(statusDir, { recursive: true });
    const sample = {
      session_id: 'claude-session-1',
      model: { id: 'claude-opus-4-6', display_name: 'Opus' },
      effort: { level: 'high' },
      version: '1.2.3',
      context_window: {
        used_percentage: 42.5,
        current_usage: {
          input_tokens: 100,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 100
        }
      },
      cost: { total_cost_usd: 0.1234 },
      rate_limits: {
        five_hour: { used_percentage: 55, resets_at: 1779516000 },
        seven_day: { used_percentage: 11, resets_at: 1780083600 }
      }
    };

    const collector = new StatuslineCollector(store, { zylosDir: dir }, { read: async () => ({
      identity: { present: true, ready: true, runtime: 'claude', runId: 'run-1', sessionId: sample.session_id },
      usage: { valid: true, sampledAt: Date.now(), value: sample }
    }) });
    const result = await collector.collect();

    assert.equal(result.written, 1);
    const rows = store.queryMetrics({ name: 'statusline_summary' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, 'claude-session-1');
    assert.equal(rows[0].dimensions.context_pct, 42.5);
    assert.equal(rows[0].dimensions.session_cost, 0.1234);
    assert.equal(rows[0].dimensions.rate_limit, undefined);
    assert.equal(rows[0].dimensions.rate_limit_7d, undefined);
    assert.equal(rows[0].dimensions.cache_hit_rate, 0.6);
    assert.equal(collector.getRuntimeInfo().model_id, 'claude-opus-4-6');
  });
});

test('usage_event unique index deduplicates null-session replay keys atomically', () => withStore((store) => {
  const point = {
    timestamp: new Date().toISOString(),
    runtime: 'codex',
    session_id: null,
    metric_name: 'usage_event',
    metric_value: 100,
    dimensions: { event_id: 'token-count-null-session', input: 100 },
    source: 'jsonl_usage',
    confidence: 'actual'
  };

  assert.deepEqual(store.insertMetricOnce(point), { inserted: true, changes: 1 });
  assert.deepEqual(store.insertMetricOnce(point), { inserted: false, changes: 0 });
  assert.equal(store.queryMetrics({ name: 'usage_event' }).length, 1);
}));

test('metric maintenance preserves otel data with incremental reclamation', () => withStore(async (store) => {
  const maintenanceNow = new Date('2026-06-07T00:00:00.000Z');
  const oldTimestamp = new Date(maintenanceNow.getTime() - 120 * 24 * 60 * 60 * 1000).toISOString();
  store.insertMetric({
    timestamp: oldTimestamp,
    runtime: 'claude',
    metric_name: 'cache_hit_rate',
    metric_value: 0.1,
    dimensions: null,
    source: 'otel_token_usage',
    confidence: 'actual'
  });
  store.insertMetric({
    timestamp: oldTimestamp,
    runtime: 'claude',
    metric_name: 'cache_hit_rate',
    metric_value: 0.2,
    dimensions: null,
    source: 'statusline',
    confidence: 'actual'
  });

  const result = await runMetricMaintenance(store, { now: maintenanceNow });
  assert.equal(result.conversion, null);
  assert.equal(store.autoVacuumMode(), 2);
  const remaining = store.queryMetrics({ name: 'cache_hit_rate' });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].source, 'otel_token_usage');
}));

test('metric maintenance deletes legacy PM2 detail rows without deleting PM2 summary', () => withStore(async (store) => {
  const now = '2026-06-07T23:59:00.000Z';
  for (const metricName of ['pm2_cpu', 'pm2_memory', 'pm2_restarts', 'pm2_status', 'pm2_uptime', 'pm2_summary']) {
    store.insertMetric({
      timestamp: now,
      runtime: 'codex',
      metric_name: metricName,
      metric_value: 1,
      dimensions: null,
      source: 'pm2',
      confidence: 'actual'
    });
  }

  await runMetricMaintenance(store, {
    now: new Date('2026-06-08T00:00:00.000Z')
  });

  assert.equal(store.queryMetrics({ name: 'pm2_cpu' }).length, 0);
  assert.equal(store.queryMetrics({ name: 'pm2_memory' }).length, 0);
  assert.equal(store.queryMetrics({ name: 'pm2_restarts' }).length, 0);
  assert.equal(store.queryMetrics({ name: 'pm2_status' }).length, 0);
  assert.equal(store.queryMetrics({ name: 'pm2_uptime' }).length, 0);
  assert.equal(store.queryMetrics({ name: 'pm2_summary' }).length, 1);
}));

test('MetricResolver reads summaries first and preserves legacy fallback forms', () => withStore((store) => {
  const now = new Date().toISOString();
  store.insertMetric({
    timestamp: now,
    runtime: 'claude',
    metric_name: 'statusline_summary',
    metric_value: 0,
    dimensions: {
      context_pct: 42.5,
      rate_limit: 55,
      session_cost: 0.1234,
      cache_hit_rate: 0.6
    },
    source: 'statusline',
    confidence: 'actual'
  });
  store.insertMetric({
    timestamp: now,
    runtime: 'claude',
    metric_name: 'system_summary',
    metric_value: 12.5,
    dimensions: {
      cpu_pct: 12.5,
      mem_used_bytes: 123456,
      mem_total_bytes: 999999
    },
    source: 'system',
    confidence: 'actual'
  });

  const resolver = new MetricResolver(store, {}, { metricStalenessSeconds: 120 });
  assert.equal(resolver.resolve('context_pct').value, 42.5);
  assert.equal(resolver.resolve('rate_limit').value, null);
  assert.equal(resolver.resolve('session_cost').value, 0.1234);
  assert.equal(resolver.resolve('cache_hit_rate').value, 0.6);
  assert.equal(resolver.resolve('cpu_pct').value, 12.5);
  assert.equal(resolver.resolve('mem_used_bytes').value, 123456);
}));

test('MetricResolver falls back to legacy individual metric rows when summaries are absent', () => withStore((store) => {
  const now = new Date().toISOString();
  for (const point of [
    ['context_pct', 40, 'statusline'],
    ['rate_limit', 50, 'statusline'],
    ['session_cost', 0.2, 'statusline'],
    ['cache_hit_rate', 0.7, 'statusline_current_usage'],
    ['cpu_pct', 10, 'system'],
    ['mem_used_bytes', 200000, 'system']
  ]) {
    store.insertMetric({
      timestamp: now,
      runtime: 'claude',
      metric_name: point[0],
      metric_value: point[1],
      dimensions: null,
      source: point[2],
      confidence: 'actual'
    });
  }

  const resolver = new MetricResolver(store, {}, { metricStalenessSeconds: 120 });
  assert.equal(resolver.resolve('context_pct').value, 40);
  assert.equal(resolver.resolve('rate_limit').value, null);
  assert.equal(resolver.resolve('session_cost').value, 0.2);
  assert.equal(resolver.resolve('cache_hit_rate').value, 0.7);
  assert.equal(resolver.resolve('cpu_pct').value, 10);
  assert.equal(resolver.resolve('mem_used_bytes').value, 200000);
}));

test('usage_event aggregate readers compute cost, cache, tokens, series, and project totals', () => withStore((store) => {
  store.insertMetric({
    timestamp: '2026-05-23T01:00:00.000Z',
    runtime: 'claude',
    session_id: 'session-1',
    metric_name: 'usage_event',
    metric_value: 1000,
    dimensions: {
      input: 1000,
      total_input: 1000,
      output: 200,
      cache_read: 250,
      cache_creation: 50,
      cost: 0.42,
      cache_hit_rate: 0.25,
      projects: ['zylos-dashboard']
    },
    source: 'jsonl_usage',
    confidence: 'actual'
  });

  assert.equal(store.aggregateCost({ sessionId: 'session-1' }), 0.42);
  assert.deepEqual(store.aggregateTokens({ sessionId: 'session-1' }), {
    input: 1000,
    output: 200,
    cache_read: 250,
    cache_rate: 0.25
  });
  assert.equal(store.aggregateCacheRate({ sessionId: 'session-1' }), 0.25);
  assert.equal(store.aggregateCostSeries({
    since: '2026-05-23T00:00:00.000Z',
    until: '2026-05-23T02:00:00.000Z',
    bucketSeconds: 3600
  })[0].cost_sum, 0.42);
  assert.equal(store.getProjectDistribution({
    since: '2026-05-23T00:00:00.000Z',
    until: '2026-05-23T02:00:00.000Z'
  }).items[0].name, 'zylos-dashboard');
}));

test('/api/system payload uses DB-backed PM2 and system summary fallback after warmup cache is empty', () => {
  const payload = buildSystemPayload({
    pm2Data: null,
    sysData: null,
    pm2State: [
      {
        process_name: 'zylos-dashboard',
        status: 'online',
        memory_bytes: 123456,
        uptime_ms: 5000,
        updated_at: '2026-06-07T01:00:00.000Z'
      }
    ],
    systemSummary: {
      timestamp: '2026-06-07T01:01:00.000Z',
      dimensions: { cpu_pct: 12.5, mem_used_bytes: 123456 }
    },
    scheduler: { running: true }
  });

  assert.equal(payload.pm2[0].name, 'zylos-dashboard');
  assert.equal(payload.pm2[0].memory, 123456);
  assert.equal(payload.pm2[0].uptime, 5000);
  assert.equal(payload.pm2[0].process_name, undefined);
  assert.equal(payload.system.cpu_pct, 12.5);
  assert.equal(payload.scheduler.running, true);
  assert.equal(payload.collected_at.pm2, '2026-06-07T01:00:00.000Z');
  assert.equal(payload.collected_at.system, '2026-06-07T01:01:00.000Z');
});

for (const runtime of ['claude', 'codex']) test(`MetricResolver uses current ${runtime} account windows and never historical fallback`, () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const past = Date.now() - 1000;
  const makeWindow = (value, resets) => runtime === 'claude'
    ? { used_percentage: value, resets_at: resets } : { usedPercentage: value, resetsAt: resets };
  const five = runtime === 'claude' ? 'five_hour' : 'fiveHour';
  const seven = runtime === 'claude' ? 'seven_day' : 'sevenDay';
  let account = { runtime, value: { [five]: makeWindow(73, future), [seven]: makeWindow(21, future) } };
  const resolver = new MetricResolver({ latestMetric() { assert.fail('account limits must not query historical metrics'); } },
    { statusline: { getAccountUsage: () => account } }, { runtime: runtime === 'claude' ? 'codex' : 'claude' });
  for (const [metric, expected] of [['rate_limit', 73], ['rate_limit_7d', 21]]) {
    const result = resolver.resolve(metric);
    assert.equal(result.value, expected);
    assert.equal(result.runtime, runtime, 'live reader runtime wins over baseline config');
    assert.equal(result.selected_source, 'core_account_usage');
    assert.equal(result.dimensions[`${metric}_resets_at`], future);
    assert.equal(result.freshness, null, 'Core account reader does not provide sample timestamp');
  }
  account.value[five] = makeWindow(100, past);
  assert.equal(resolver.resolve('rate_limit').value, null);
  assert.equal(resolver.resolve('rate_limit_7d').value, 21);
  account.value[seven] = makeWindow(100, Math.floor(past / 1000));
  assert.equal(resolver.resolve('rate_limit_7d').value, null);
  account = { runtime, value: null };
  assert.equal(resolver.resolve('rate_limit').value, null);
  assert.equal(resolver.resolve('rate_limit_7d').value, null);
  account = null;
  assert.equal(resolver.resolve('rate_limit').selected_source, null);
});
