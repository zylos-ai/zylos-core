import { createCgroupCollector } from '../src/lib/cgroup-resources.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PM2Collector } from '../src/lib/collectors/pm2-collector.js';
import { SystemCollector } from '../src/lib/collectors/system-collector.js';
import { runMetricMaintenance } from '../src/lib/metric-maintenance.js';
import { Store } from '../src/lib/store.js';
import { usageTokenRows, costRows } from '../src/lib/workbench/cost-query.js';

const cgroupCollector = createCgroupCollector({ readFile: () => { throw new Error('fixture: no cgroup'); } });

function tmpDir(prefix = 'metric-collectors-') {
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
    const collector = new SystemCollector(store, { zylosDir: dir, runtime: 'codex' }, { cgroupCollector });
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
  const bounds = { since: '2026-05-23T00:00:00.000Z', until: '2026-05-23T02:00:00.000Z', bucket: 'hour', tz: 'UTC' };
  const tokens = usageTokenRows(store, bounds);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].inputTokens, 1000);
  assert.equal(tokens[0].outputTokens, 200);
  assert.equal(tokens[0].cacheReadTokens, 250);
  assert.equal(tokens[0].cacheReadTokens / tokens[0].inputTokens, 0.25);
  assert.equal(store.aggregateCacheRate({ sessionId: 'session-1' }), 0.25);
  assert.equal(costRows(store, bounds)[0].value, 0.42);
  assert.equal(store.getProjectDistribution({
    since: '2026-05-23T00:00:00.000Z',
    until: '2026-05-23T02:00:00.000Z'
  }).items[0].name, 'zylos-dashboard');
}));
