import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import { parseMeminfo, readMemory, SystemCollector } from '../src/lib/collectors/system-collector.js';
import { systemSample } from '../src/lib/workbench/group-snapshot.js';

// A host with most of its memory in page cache: MemFree alone says 70.3% used, MemAvailable says 12.6%.
const MEMINFO = `MemTotal:       16384000 kB
MemFree:         4866048 kB
MemAvailable:   14319616 kB
Buffers:          204800 kB
Cached:          9216000 kB
SwapTotal:       2097148 kB
SwapFree:        2097148 kB
`;

function stubStore() {
  const metrics = [];
  return { metrics, insertMetric: row => metrics.push(row), upsertSourceHealth() {} };
}

test('meminfo gives total and available bytes; used counts only what is not available', () => {
  assert.deepEqual(parseMeminfo(MEMINFO), { totalBytes: 16384000 * 1024, availableBytes: 14319616 * 1024 });
  assert.equal(parseMeminfo(MEMINFO.replace(/^MemAvailable:.*\n/m, '')), null, 'no MemAvailable: unknown, not MemFree');
  assert.equal(parseMeminfo('MemTotal: 0 kB\nMemAvailable: 0 kB\n'), null);
  assert.equal(parseMeminfo('MemTotal: 100 kB\nMemAvailable: 150 kB\n').availableBytes, 100 * 1024, 'available never exceeds total');
});

test('the collector writes memory used percent from MemAvailable on Linux', async () => {
  const store = stubStore();
  const readFile = file => { assert.equal(file, '/proc/meminfo'); return MEMINFO; };
  const collector = new SystemCollector(store, { zylosDir: os.tmpdir(), runtime: 'claude' },
    { readMemory: () => readMemory({ platform: 'linux', readFile }) });
  await collector.collect();
  const dims = store.metrics[0].dimensions;
  assert.equal(dims.mem_used_pct, 12.6);
  assert.equal(dims.mem_used_bytes, (16384000 - 14319616) * 1024);
  assert.equal(dims.mem_total_bytes, 16384000 * 1024);
  const latest = collector.getLatestSystemData();
  assert.equal(latest.mem_used_bytes, dims.mem_used_bytes, 'the live sample uses the same measure as the stored row');
});

test('an unreadable meminfo leaves memory unknown rather than falling back to free memory', async () => {
  const store = stubStore();
  const collector = new SystemCollector(store, { zylosDir: os.tmpdir(), runtime: 'claude' },
    { readMemory: () => readMemory({ platform: 'linux', readFile: () => { throw new Error('EACCES'); } }) });
  await collector.collect();
  const dims = store.metrics[0].dimensions;
  assert.deepEqual([dims.mem_used_pct, dims.mem_used_bytes, dims.mem_total_bytes], [null, null, null]);
});

test('other platforms keep the host total; non-macOS, non-Linux hosts use free memory as available', () => {
  const memory = readMemory({ platform: 'win32' });
  assert.equal(memory.totalBytes, os.totalmem());
  assert.ok(memory.availableBytes >= 0 && memory.availableBytes <= memory.totalBytes);
});

test('the overview snapshot carries the latest sample with its collection time', () => {
  assert.deepEqual(systemSample({ collectedAt: 5000, cpu_pct: 12.5, cpu_count: 4, mem_used_bytes: 10, mem_total_bytes: 40,
    disk_used_pct: 55, disk_free_bytes: 7 }), { sampledAt: 5000, cpuPct: 12.5, cpuCount: 4, memUsedBytes: 10, memTotalBytes: 40,
    diskUsedPct: 55, diskFreeBytes: 7 });
  // The first sample has no CPU delta yet; a missing field stays null instead of reading as zero.
  assert.deepEqual(systemSample({ collectedAt: 5000 }), { sampledAt: 5000, cpuPct: null, cpuCount: null, memUsedBytes: null,
    memTotalBytes: null, diskUsedPct: null, diskFreeBytes: null });
  assert.equal(systemSample(null), null);
  assert.equal(systemSample({ cpu_pct: 3 }), null, 'without a collection time the sample cannot be judged fresh');
});
