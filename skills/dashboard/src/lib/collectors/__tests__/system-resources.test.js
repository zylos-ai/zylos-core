import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import { createCgroupCollector } from '../../cgroup-resources.js';
import { SystemCollector } from '../system-collector.js';

function fixture({ unlimited = false, host = false, v1 = false } = {}) {
  let usage = 1_000_000;
  let now = 1000;
  const files = host ? {} : v1 ? {
    '/fixture/cpu/cpu.cfs_quota_us': unlimited ? '-1' : '150000',
    '/fixture/cpu/cpu.cfs_period_us': '100000',
    '/fixture/cpu/cpuacct.usage': () => String(usage * 1000),
    '/fixture/memory/memory.limit_in_bytes': unlimited ? '9223372036854771712' : '800000000',
    '/fixture/memory/memory.usage_in_bytes': '400000000',
    '/fixture/memory/memory.stat': 'total_inactive_file 100000000',
  } : {
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
  return { collector, metrics, files, tick() { usage += 300_000; now += 1000; } };
}

for (const v1 of [false, true]) {
  test(`${v1 ? 'v1' : 'v2'} CPU read failure clears the previous percentage and requires two recovery samples`, async () => {
    const { collector, metrics, files, tick } = fixture({ v1 });
    const usagePath = v1 ? '/fixture/cpu/cpuacct.usage' : '/fixture/cpu.stat';
    const readUsage = files[usagePath];
    tick();
    await collector.collect();
    assert.equal(collector.getLatestSystemData().cpu_pct, 20);

    files[usagePath] = undefined;
    tick();
    await collector.collect();
    assert.equal(collector.getLatestSystemData().cpu_pct, null);
    assert.equal(collector.getLatestSystemData().cpu_usage_cores, null);
    assert.equal(metrics[1].dimensions.cpu_pct, null);
    assert.equal(metrics[1].dimensions.cpu_usage_cores, null);

    files[usagePath] = readUsage;
    tick();
    await collector.collect();
    assert.equal(collector.getLatestSystemData().cpu_pct, null);
    assert.equal(metrics[2].dimensions.cpu_pct, null);
    tick();
    await collector.collect();
    assert.equal(collector.getLatestSystemData().cpu_pct, 20);
    assert.equal(metrics[3].dimensions.cpu_pct, 20);
  });

  test(`${v1 ? 'v1' : 'v2'} working set is zero when inactive file equals current usage`, async () => {
    const { collector, metrics, files } = fixture({ v1 });
    const statPath = v1 ? '/fixture/memory/memory.stat' : '/fixture/memory.stat';
    const key = v1 ? 'total_inactive_file' : 'inactive_file';
    files[statPath] = `${key} 400000000`;
    await collector.collect();
    assert.equal(collector.getLatestSystemData().mem_used_bytes, 0);
    assert.equal(collector.getLatestSystemData().mem_pct, 0);
    assert.equal(metrics[0].dimensions.mem_used_bytes, 0);
    assert.equal(metrics[0].dimensions.mem_used_pct, 0);

    files[statPath] = `${key} 400000001`;
    await collector.collect();
    assert.equal(collector.getLatestSystemData().mem_used_bytes, 400000000);
    assert.equal(collector.getLatestSystemData().mem_pct, 50);
  });

  test(`existing system sampler reports ${v1 ? 'v1' : 'v2'} quota CPU and working-set memory in live and stored samples`, async () => {
    const { collector, metrics, tick } = fixture({ v1 });
    tick();
    await collector.collect();
    const data = collector.getLatestSystemData();
    assert.equal(data.resource_scope, 'container');
    assert.equal(data.cgroup_version, v1 ? 'v1' : 'v2');
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
}

test('explicitly unlimited container limits preserve host capacity and usage gauges', async t => {
  let user = 100, idle = 100;
  t.mock.method(os, 'cpus', () => Array.from({ length: 8 }, () => ({ times: { user, idle, nice: 0, sys: 0, irq: 0 } })));
  const { collector, metrics, tick } = fixture({ unlimited: true });
  tick(); await collector.collect();
  user += 20; idle += 80; tick(); await collector.collect();
  const data = collector.getLatestSystemData();
  assert.equal(data.resource_scope, 'host'); assert.equal(data.cgroup_version, 'v2');
  assert.ok(Math.abs(data.cpu_pct - 20) < 1e-9); assert.equal(data.cpu_count, 8);
  assert.equal(data.mem_pct, 50); assert.equal(data.mem_total_bytes, 16_000_000_000); assert.equal(data.mem_used_bytes, 8_000_000_000);
  assert.ok(Math.abs(metrics.at(-1).dimensions.cpu_pct - 20) < 1e-9); assert.equal(metrics.at(-1).dimensions.mem_used_pct, 50);
});

test('unreadable container limits do not masquerade as an unlimited host fallback', async () => {
  const { collector, files, tick } = fixture({ unlimited: true });
  files['/fixture/cpu.max'] = 'invalid'; files['/fixture/memory.max'] = 'invalid';
  tick(); await collector.collect();
  const data = collector.getLatestSystemData();
  assert.equal(data.resource_scope, 'container'); assert.equal(data.cpu_pct, null); assert.equal(data.mem_total_bytes, null);
});

for (const v1 of [false, true]) {
  test(`${v1 ? 'unlimited v1 host hierarchy' : 'absent cgroups'} use host CPU deltas and available-memory figures`, async t => {
    let times = { user: 100, nice: 0, sys: 0, idle: 100, irq: 0 };
    t.mock.method(os, 'cpus', () => [{ times }, { times }]);
    const { collector, metrics } = fixture(v1 ? { v1: true, unlimited: true } : { host: true });
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
    assert.equal(metrics[1].dimensions.resource_scope, 'host');
    assert.equal(metrics[1].dimensions.cgroup_version, 'none');
  });
}

for (const limited of ['cpu', 'memory']) test(`independent ${limited} quota uses container while the other controller uses host`, async t => {
  let user = 100, idle = 100;
  t.mock.method(os, 'cpus', () => Array.from({ length: 8 }, () => ({ times: { user, idle, nice: 0, sys: 0, irq: 0 } })));
  const { collector, metrics, files, tick } = fixture();
  files[limited === 'cpu' ? '/fixture/memory.max' : '/fixture/cpu.max'] = limited === 'cpu' ? 'max' : 'max 100000';
  tick(); await collector.collect();
  user += 20; idle += 80; tick(); await collector.collect();
  const data = collector.getLatestSystemData(), dims = metrics.at(-1).dimensions;
  assert.equal(data.resource_scope, 'mixed');
  assert.equal(data.cpu_source, limited === 'cpu' ? 'container' : 'host');
  assert.equal(data.mem_source, limited === 'memory' ? 'container' : 'host');
  assert.equal(data.cpu_count, limited === 'cpu' ? 1.5 : 8);
  assert.ok(Math.abs(data.cpu_pct - 20) < 1e-9);
  assert.equal(data.mem_total_bytes, limited === 'memory' ? 800000000 : 16000000000);
  assert.equal(data.mem_pct, limited === 'memory' ? 37.5 : 50);
  assert.equal(dims.cpu_source, data.cpu_source); assert.equal(dims.mem_source, data.mem_source);
});
