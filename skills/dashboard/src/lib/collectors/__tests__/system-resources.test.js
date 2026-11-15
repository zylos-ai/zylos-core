import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import { createCgroupCollector } from '../../cgroup-resources.js';
import { SystemCollector } from '../system-collector.js';

function fixture({ unlimited = false, host = false } = {}) {
  let usage = 1_000_000;
  let now = 1000;
  const files = host ? {} : {
    '/fixture/cpu.max': unlimited ? 'max 100000' : '150000 100000',
    '/fixture/cpu.stat': () => `usage_usec ${usage}`,
    '/fixture/memory.max': unlimited ? 'max' : '800000000',
    '/fixture/memory.current': '400000000',
    '/fixture/memory.stat': 'inactive_file 100000000',
  };
  const cgroupCollector = createCgroupCollector({
    cgroupRoot: '/fixture',
    readFile: file => {
      assert.ok(file.startsWith('/fixture/'), 'never access live cgroups');
      const value = files[file];
      if (value === undefined) throw new Error('ENOENT');
      return typeof value === 'function' ? value() : value;
    },
    now: () => now,
  });
  const metrics = [];
  const collector = new SystemCollector({ insertMetric: row => metrics.push(row), upsertSourceHealth() {} },
    { zylosDir: os.tmpdir(), runtime: 'test' },
    { cgroupCollector, readMemory: () => ({ totalBytes: 16_000_000_000, availableBytes: 8_000_000_000 }) });
  return { collector, metrics, tick() { usage += 300_000; now += 1000; } };
}

test('existing system sampler reports cgroup quota CPU and working-set memory in live and stored samples', async () => {
  const { collector, metrics, tick } = fixture();
  tick();
  await collector.collect();
  const data = collector.getLatestSystemData();
  assert.equal(data.resource_scope, 'container');
  assert.equal(data.cgroup_version, 'v2');
  assert.equal(data.cpu_pct, 20);
  assert.equal(data.cpu_count, 1.5);
  assert.equal(data.cpu_usage_cores, 0.3);
  assert.equal(data.mem_pct, 37.5);
  assert.equal(data.mem_used_bytes, 300_000_000);
  assert.equal(data.mem_total_bytes, 800_000_000);
  const dims = metrics[0].dimensions;
  for (const key of ['resource_scope', 'cgroup_version', 'cpu_pct', 'cpu_count', 'cpu_usage_cores', 'mem_used_bytes', 'mem_total_bytes']) {
    assert.equal(dims[key], data[key], key);
  }
  assert.equal(dims.mem_used_pct, data.mem_pct);
  assert.equal(collector._timer, null, 'collecting creates no extra timer');
});

test('unlimited v2 limits retain container scope, actual working set and unknown percentages', async () => {
  const { collector, metrics, tick } = fixture({ unlimited: true });
  tick();
  await collector.collect();
  const data = collector.getLatestSystemData();
  assert.equal(data.resource_scope, 'container');
  assert.equal(data.cgroup_version, 'v2');
  assert.equal(data.cpu_pct, null);
  assert.equal(data.cpu_count, null);
  assert.equal(data.cpu_usage_cores, 0.3);
  assert.equal(data.mem_pct, null);
  assert.equal(data.mem_total_bytes, null);
  assert.equal(data.mem_used_bytes, 300_000_000);
  assert.equal(metrics[0].dimensions.cpu_pct, null);
  assert.equal(metrics[0].dimensions.cpu_count, null);
  assert.equal(metrics[0].dimensions.mem_used_pct, null);
  assert.equal(metrics[0].metric_value, 0, 'summary row remains compatible with its non-null numeric schema');
});

test('absent cgroups use host CPU deltas and available-memory figures', async t => {
  let times = { user: 100, nice: 0, sys: 0, idle: 100, irq: 0 };
  t.mock.method(os, 'cpus', () => [{ times }, { times }]);
  const { collector, metrics } = fixture({ host: true });
  await collector.collect();
  times = { user: 125, nice: 0, sys: 0, idle: 175, irq: 0 };
  await collector.collect();
  const data = collector.getLatestSystemData();
  assert.equal(data.resource_scope, 'host');
  assert.equal(data.cgroup_version, 'none');
  assert.equal(data.cpu_pct, 25);
  assert.equal(data.cpu_count, 2);
  assert.equal(data.mem_total_bytes, 16_000_000_000);
  assert.equal(data.mem_used_bytes, 8_000_000_000);
  assert.equal(data.mem_pct, 50);
  assert.equal(metrics[1].dimensions.mem_used_pct, 50);
});
