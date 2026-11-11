import test from 'node:test';
import assert from 'node:assert/strict';
import { hostSeries } from '../src/lib/workbench/host-series.js';
import { usageFixture } from './fixtures/usage-store.js';

// SQLite integration: real Store, private fixture database, no collectors or
// subprocesses. Run for host query/bucket/aggregation changes; skip UI-only.
// Runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private tmux namespace;
// fixture closes all database handles before removing its owned directory.
test('host buckets average each field independently and retain null gaps and actual peak', t => {
  const f = usageFixture(t), now = new Date('2026-11-06T06:00:15.000Z');
  f.metric('2026-11-06T00:00:20.000Z', 'claude', { cpu_pct: 10, mem_used_pct: 50, disk_used_pct: null }, 'system_summary');
  f.metric('2026-11-06T00:00:50.000Z', 'claude', { cpu_pct: 30, mem_used_pct: null, disk_used_pct: 80 }, 'system_summary');
  f.metric(now.toISOString(), 'claude', { cpu_pct: 99, mem_used_pct: 60, disk_used_pct: 70 }, 'system_summary');
  const result = hostSeries(f.store, { now, pm2Data: { processes: [
    { pm2_env: { status: 'online' } }, { pm2_env: { status: 'stopped' } }
  ], collectedAt: now.getTime() } });
  assert.equal(result.series.length, 360);
  assert.deepEqual(result.series[0].cpu, { avg: 20, max: 30 });
  assert.deepEqual(result.series[0].mem, { avg: 50, max: 50 });
  assert.deepEqual(result.series[0].disk, { avg: 80, max: 80 });
  assert.equal(result.series[1].cpu, null);
  assert.equal(result.series[1].mem, null);
  assert.equal(result.series[1].disk, null);
  assert.equal(result.series.at(-1).cpu.max, 99);
  assert.deepEqual(result.cpuPeak, { value: 99, at: now.toISOString() });
  assert.deepEqual(result.current, { cpu_pct: 99, mem_used_pct: 60, disk_used_pct: 70, at: now.toISOString() });
  assert.deepEqual(result.pm2, { online: 1, total: 2, at: now.toISOString() });
});

// Same private Store boundary; run for range/null semantics, skip view changes.
test('host ranges have exactly the requested bucket counts and invalid ranges fail', t => {
  const f = usageFixture(t), now = new Date('2026-11-06T06:00:15.000Z');
  for (const [range, bucketSeconds, count] of [['6h', 60, 360], ['24h', 300, 288], ['7d', 1800, 336]]) {
    const result = hostSeries(f.store, { range, now });
    assert.equal(result.bucketSeconds, bucketSeconds);
    assert.equal(result.series.length, count);
    assert.equal(result.cpuPeak, null);
    assert.equal(result.pm2, null);
    assert.equal(result.current.cpu_pct, null);
    assert.equal(result.current.at, null);
    assert.ok(result.series.every(row => row.cpu === null && row.mem === null && row.disk === null));
  }
  for (const range of ['1d', 'constructor', 'toString', '__proto__']) {
    assert.throws(() => hostSeries(f.store, { range, now }), { code: 'invalid_range', statusCode: 400 });
  }
});
