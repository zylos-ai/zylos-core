import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCgroupCollector } from '../cgroup-resources.js';

// Build a fake cgroup fs. `files` maps absolute path -> string (or a function
// returning a string, for values that change between samples). Missing paths
// throw ENOENT, exactly like fs.readFileSync.
function fakeReadFile(files) {
  return (absPath) => {
    const v = files[absPath];
    if (v === undefined) {
      const e = new Error(`ENOENT: ${absPath}`);
      e.code = 'ENOENT';
      throw e;
    }
    return typeof v === 'function' ? v() : v;
  };
}

test('cgroup v2: CPU differential + memory working set', () => {
  const usage = { usec: 1_000_000 };
  const time = { t: 1_000 };
  const files = {
    '/cg/cpu.max': '150000 100000', // 1.5 cores
    '/cg/cpu.stat': () => `usage_usec ${usage.usec}\nuser_usec 0\nsystem_usec 0`,
    '/cg/memory.max': '800000000',
    '/cg/memory.current': '400000000',
    '/cg/memory.stat': 'anon 200000000\ninactive_file 100000000\nslab 0',
  };
  const c = createCgroupCollector({
    cgroupRoot: '/cg',
    readFile: fakeReadFile(files),
    now: () => time.t,
  });
  // constructor seeded a sample at usage=1_000_000, t=1000.
  usage.usec = 1_300_000; // +300000 µs consumed ...
  time.t = 2_000;         // ... over 1_000 ms → 0.3 cores
  c.sample();
  const r = c.read();

  assert.equal(r.cgroup_version, 'v2');
  assert.equal(r.cpu_limit_cores, 1.5);
  assert.equal(r.cpu_usage_cores, 0.3);
  assert.equal(r.cpu_pct, 20);            // 0.3 / 1.5 * 100
  assert.equal(r.mem_total_bytes, 800000000);
  assert.equal(r.mem_used_bytes, 300000000); // 400M current − 100M inactive_file
  assert.equal(r.mem_pct, 37.5);          // 300M / 800M * 100
  assert.deepEqual(r.errors, []);
});

test('cgroup v2: only one sample → cpu_pct null, memory still reported', () => {
  const files = {
    '/cg/cpu.max': '100000 100000',
    '/cg/cpu.stat': 'usage_usec 5000000',
    '/cg/memory.max': '500000000',
    '/cg/memory.current': '250000000',
    '/cg/memory.stat': 'inactive_file 50000000',
  };
  const c = createCgroupCollector({ cgroupRoot: '/cg', readFile: fakeReadFile(files), now: () => 0 });
  const r = c.read(); // constructor seeded exactly one sample
  assert.equal(r.cpu_pct, null);
  assert.equal(r.cpu_usage_cores, null);
  assert.equal(r.cpu_limit_cores, 1);
  assert.equal(r.mem_used_bytes, 200000000);
  assert.equal(r.mem_pct, 40);
});

test('cgroup v2: unlimited (cpu.max "max", memory.max "max")', () => {
  const files = {
    '/cg/cpu.max': 'max 100000',
    '/cg/cpu.stat': 'usage_usec 1000',
    '/cg/memory.max': 'max',
    '/cg/memory.current': '123456789',
    '/cg/memory.stat': 'inactive_file 456',
  };
  const c = createCgroupCollector({ cgroupRoot: '/cg', readFile: fakeReadFile(files), now: () => 0 });
  const r = c.read();
  assert.equal(r.cgroup_version, 'v2');
  assert.equal(r.cpu_limit_cores, null);
  assert.equal(r.cpu_pct, null);          // no limit → no percentage
  assert.equal(r.mem_total_bytes, null);
  assert.equal(r.mem_pct, null);
  assert.equal(r.mem_used_bytes, 123456333); // working set still computed
  assert.deepEqual(r.errors, []);         // "unlimited" is found, not an error
});

test('cgroup v1 fallback: CPU (cpuacct ns) + memory working set', () => {
  const usageNs = { v: 1_000_000_000 }; // 1e9 ns = 1e6 µs
  const time = { t: 0 };
  const files = {
    '/cg1/cpu/cpu.cfs_quota_us': '200000',
    '/cg1/cpu/cpu.cfs_period_us': '100000', // 2 cores
    '/cg1/cpu/cpuacct.usage': () => String(usageNs.v),
    '/cg1/memory/memory.limit_in_bytes': '1000000000',
    '/cg1/memory/memory.usage_in_bytes': '600000000',
    '/cg1/memory/memory.stat': 'cache 0\ntotal_inactive_file 100000000',
  };
  const c = createCgroupCollector({ cgroupRoot: '/cg1', readFile: fakeReadFile(files), now: () => time.t });
  usageNs.v = 1_200_000_000; // +2e8 ns = 2e5 µs consumed ...
  time.t = 1_000;            // ... over 1_000 ms → 0.2 cores
  c.sample();
  const r = c.read();
  assert.equal(r.cgroup_version, 'v1');
  assert.equal(r.cpu_limit_cores, 2);
  assert.equal(r.cpu_usage_cores, 0.2);
  assert.equal(r.cpu_pct, 10);            // 0.2 / 2 * 100
  assert.equal(r.mem_total_bytes, 1000000000);
  assert.equal(r.mem_used_bytes, 500000000); // 600M − 100M
  assert.equal(r.mem_pct, 50);
  assert.deepEqual(r.errors, []);
});

test('cgroup v1 host root: unlimited sentinels do not establish container scope', () => {
  const files = {
    '/cg1/cpu/cpu.cfs_quota_us': '-1',
    '/cg1/cpu/cpuacct.usage': '5000000000',
    '/cg1/memory/memory.limit_in_bytes': '9223372036854771712', // PAGE_COUNTER_MAX
    '/cg1/memory/memory.usage_in_bytes': '300000000',
    '/cg1/memory/memory.stat': 'total_inactive_file 0',
  };
  const c = createCgroupCollector({ cgroupRoot: '/cg1', readFile: fakeReadFile(files), now: () => 0 });
  const r = c.read();
  assert.equal(r.cgroup_version, 'none');
  assert.equal(r.cpu_limit_cores, null);
  assert.equal(r.cpu_pct, null);
  assert.equal(r.mem_total_bytes, null);  // sentinel → unlimited
  assert.equal(r.mem_pct, null);
  assert.equal(r.mem_used_bytes, 300000000);
  assert.deepEqual(r.errors, []);
});

for (const limited of ['cpu', 'memory']) {
  test(`cgroup v1: finite ${limited} limit retains container scope with the other unlimited`, () => {
    const files = {
      '/cg1/cpu/cpu.cfs_quota_us': limited === 'cpu' ? '150000' : '-1',
      '/cg1/cpu/cpu.cfs_period_us': '100000',
      '/cg1/cpu/cpuacct.usage': '5000000000',
      '/cg1/memory/memory.limit_in_bytes': limited === 'memory' ? '800000000' : '9223372036854771712',
      '/cg1/memory/memory.usage_in_bytes': '300000000',
      '/cg1/memory/memory.stat': 'total_inactive_file 0',
    };
    const c = createCgroupCollector({ cgroupRoot: '/cg1', readFile: fakeReadFile(files), now: () => 0 });
    const r = c.read();
    assert.equal(r.cgroup_version, 'v1');
    assert.equal(r.cpu_limit_cores, limited === 'cpu' ? 1.5 : null);
    assert.equal(r.mem_total_bytes, limited === 'memory' ? 800000000 : null);
    assert.equal(r.mem_pct, limited === 'memory' ? 37.5 : null);
    assert.deepEqual(r.errors, []);
  });
}

test('no cgroup at all: version "none", nulls, collection errors', () => {
  const c = createCgroupCollector({ cgroupRoot: '/empty', readFile: fakeReadFile({}), now: () => 0 });
  const r = c.read();
  assert.equal(r.cgroup_version, 'none');
  assert.equal(r.cpu_pct, null);
  assert.equal(r.mem_pct, null);
  assert.equal(r.mem_total_bytes, null);
  assert.equal(r.mem_used_bytes, null);
  assert.deepEqual(
    r.errors.sort(),
    ['cpu_limit_unreadable', 'memory_limit_unreadable', 'memory_usage_unreadable'],
  );
});

test('counter reset (usage went backwards): cpu_pct null, no crash', () => {
  const usage = { usec: 5_000_000 };
  const time = { t: 0 };
  const files = {
    '/cg/cpu.max': '100000 100000',
    '/cg/cpu.stat': () => `usage_usec ${usage.usec}`,
    '/cg/memory.max': '100',
    '/cg/memory.current': '50',
    '/cg/memory.stat': 'inactive_file 0',
  };
  const c = createCgroupCollector({ cgroupRoot: '/cg', readFile: fakeReadFile(files), now: () => time.t });
  usage.usec = 1_000_000; // went backwards (container restart / cgroup recreated)
  time.t = 1_000;
  c.sample();
  const r = c.read();
  assert.equal(r.cpu_pct, null);
  assert.equal(r.mem_pct, 50);
});
