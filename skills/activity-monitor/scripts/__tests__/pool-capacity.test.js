import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PoolCapacity, calculateMemoryCapacity, writeCapacityAtomic } from '../pool-capacity.js';

const MiB = 1024 ** 2, GiB = 1024 ** 3;
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-capacity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let memory = { source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1300 * MiB, oomKills: 0 };
  let baseline = { k: 2, fixed: false };
  const logs = [];
  const capacity = new PoolCapacity({ directory, readMemory: async () => memory,
    resolveBaseline: () => baseline, log: row => logs.push(row), ...options });
  return { directory, capacity, logs, memory: value => memory = value, baseline: value => baseline = value };
}
const scene = (group = 'a', ready = true) => ({ sessionGroup: group, present: true, ready });

test('formula keeps Origin reservation even when absent and has no CPU ceiling', () => {
  const model = { state: 'default', slopeBytes: 512 * MiB };
  let result = calculateMemoryCapacity({ limitBytes: 4 * GiB, usedBytes: 1300 * MiB }, 0, model);
  assert.equal(result.kRaw, 3); assert.equal(result.kMemory, 3); assert.equal(result.reserveBytes, 512 * MiB);
  result = calculateMemoryCapacity({ limitBytes: 122 * GiB, usedBytes: 22 * GiB }, 0, model);
  assert.equal(result.kRaw, 174);
  result = calculateMemoryCapacity({ limitBytes: 4 * GiB, usedBytes: 3900 * MiB }, 0, model);
  assert.equal(result.kMemory, -2); assert.equal(result.kRaw, 1); assert.equal(result.reason, 'floor');
  result = calculateMemoryCapacity({ limitBytes: 4 * GiB, usedBytes: 3000 * MiB }, 0, model);
  assert.equal(result.kMemory, 0); assert.equal(result.kRaw, 1); assert.equal(result.reason, 'floor');
});

test('startup is conservative, rises only after full window, and drops immediately', async t => {
  const f = fixture(t);
  assert.equal((await f.capacity.tick({ mode: 'multi', now: 0 })).k, 2);
  f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1350 * MiB });
  for (let now = 10000; now < 120000; now += 10000) {
    const record = await f.capacity.tick({ mode: 'multi', now, scenes: [scene('origin')] });
    assert.equal(record.k, 2);
  }
  f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1800 * MiB });
  assert.equal((await f.capacity.tick({ mode: 'multi', now: 120000, scenes: [scene('origin')] })).k, 3);
  f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 3900 * MiB });
  const dropped = await f.capacity.tick({ mode: 'multi', now: 130000, scenes: [scene('origin'), scene('a'), scene('b'), scene('c')] });
  assert.equal(dropped.k, 2);
  for (let now = 140000; now <= 250000; now += 10000) {
    f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: now % 20000 ? 3900 * MiB : 2800 * MiB });
    assert.equal((await f.capacity.tick({ mode: 'multi', now, scenes: [scene('origin'), scene('a'), scene('b'), scene('c')] })).k, 2);
  }
});

test('fixed values override bad memory and cancellation resets startup smoothing', async t => {
  const f = fixture(t);
  f.baseline({ k: 6, fixed: true });
  const fixed = await f.capacity.tick({ mode: 'multi', now: 0 });
  assert.equal(fixed.k, 6); assert.equal(fixed.source, 'fixed'); assert.equal(fixed.kMemory, 3); assert.equal(fixed.kRaw, 3);
  assert.equal(fixed.limitedBy, 'live');
  f.memory(null);
  const unreadable = await f.capacity.tick({ mode: 'multi', now: 10000 });
  assert.equal(unreadable.k, 6); assert.equal(unreadable.kRaw, 6); assert.equal(unreadable.source, 'fixed');
  assert.equal(Object.hasOwn(unreadable, 'kMemory'), false);
  assert.equal(Object.hasOwn(unreadable, 'limitedBy'), false);
  f.baseline({ k: 2, fixed: false });
  f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1300 * MiB });
  assert.equal((await f.capacity.tick({ mode: 'multi', now: 20000 })).k, 2);
});

test('atomic publication fsyncs before rename and interruption preserves old complete record', t => {
  const f = fixture(t), file = f.capacity.file, old = { v: 1, k: 2, computedAt: 0 };
  writeCapacityAtomic(file, old);
  const calls = [];
  const io = { ...fs, fsyncSync(fd) { calls.push('sync'); return fs.fsyncSync(fd); }, renameSync(from, to) {
    calls.push('rename'); assert.deepEqual(JSON.parse(fs.readFileSync(to)), old);
    assert.equal(JSON.parse(fs.readFileSync(from)).k, 3);
    throw Object.assign(new Error('interrupted'), { code: 'EIO' });
  } };
  assert.throws(() => writeCapacityAtomic(file, { v: 1, k: 3, computedAt: 10000 }, { fs: io }), /interrupted/);
  assert.deepEqual(calls, ['sync', 'rename']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), old);
  assert.deepEqual(fs.readdirSync(f.directory), ['pool-capacity.json']);
});

