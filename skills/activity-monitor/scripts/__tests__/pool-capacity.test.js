import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PoolCapacity, fitMemoryModel, calculateMemoryCapacity, writeCapacityAtomic } from '../pool-capacity.js';
import { readPoolCapacity } from '../../../../cli/lib/session-pool-config.js';

const MiB = 1024 ** 2, GiB = 1024 ** 3, DAY = 86400000;
function sample(n, w, ts = 1000000000, src = 'cgroup2') {
  return { v: 1, ts, n, pool: n, origin: false, w, limit: 4 * GiB, src };
}
function bucket(n, w, count = 60, ts = 1000000000, src = 'cgroup2') {
  return Array.from({ length: count }, () => sample(n, w, ts, src));
}
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

test('nearest-rank percentile and minimum bucket count select high values', () => {
  const rows = [...Array.from({ length: 60 }, (_, i) => sample(1, i + 1)), ...bucket(2, 100, 59)];
  let model = fitMemoryModel(rows, { now: 1000000000, source: 'cgroup2' });
  assert.equal(model.state, 'default');
  assert.deepEqual(model.buckets, [{ n: 1, highBytes: 57, samples: 60 }]);
  rows.push(sample(2, 100));
  model = fitMemoryModel(rows, { now: 1000000000, source: 'cgroup2' });
  assert.equal(model.state, 'fitted');
  assert.equal(model.slopeBytes, 256 * MiB);
});

test('fits adjacent buckets and uses maximum residual intercept', () => {
  const rows = [1, 2, 3].flatMap(n => bucket(n, (0.85 + 0.5 * n) * GiB));
  const model = fitMemoryModel(rows, { now: 1000000000, source: 'cgroup2' });
  assert.equal(model.state, 'fitted');
  assert.ok(Math.abs(model.slopeBytes / GiB - 0.5) < 1e-12);
  assert.ok(Math.abs(model.interceptBytes / GiB - 0.85) < 1e-12);
  assert.equal(fitMemoryModel(rows.slice(0, 120), { now: 1000000000, source: 'cgroup2' }).state, 'fitted');
});

test('non-equally spaced values use median pairwise slope and upper median', () => {
  let rows = [1.35, 1.85, 2.30].flatMap((w, index) => bucket(index + 1, w * GiB));
  let model = fitMemoryModel(rows, { now: 1000000000, source: 'cgroup2' });
  assert.ok(Math.abs(model.slopeBytes / GiB - 0.475) < 1e-12);
  assert.ok(Math.abs(model.interceptBytes / GiB - 0.9) < 1e-12);
  rows = [1, 2, 4, 8].flatMap((w, index) => bucket(index, w * GiB));
  model = fitMemoryModel(rows, { now: 1000000000, source: 'cgroup2' });
  // Slopes: 1,1.5,2,7/3,3,4. The upper middle value is 7/3.
  assert.equal(model.slopeBytes, 7 * GiB / 3);
});

test('percentile rejects sparse peaks and pairwise median resists an outlying bucket', () => {
  let rows = [...bucket(1, 1.35 * GiB), ...bucket(2, 1.85 * GiB, 96), ...bucket(2, 3 * GiB, 4)];
  let model = fitMemoryModel(rows, { now: 1000000000, source: 'cgroup2' });
  assert.ok(Math.abs(model.slopeBytes / GiB - 0.5) < 1e-12);
  rows = [1.35, 1.85, 2.35, 2.85, 6].flatMap((w, index) => bucket(index + 1, w * GiB));
  model = fitMemoryModel(rows, { now: 1000000000, source: 'cgroup2' });
  assert.ok(Math.abs(model.slopeBytes / GiB - 0.5) < 1e-12);
  assert.equal(model.interceptBytes, 3.5 * GiB);
});

test('slope floor handles small and negative slopes and expires into default', () => {
  for (const second of [1100 * MiB, 900 * MiB]) {
    const rows = [...bucket(1, 1000 * MiB), ...bucket(2, second)];
    assert.equal(fitMemoryModel(rows, { now: 1000000000, source: 'cgroup2' }).slopeBytes, 256 * MiB);
    assert.equal(fitMemoryModel(rows, { now: 1000000000 + 7 * DAY + 1, source: 'cgroup2' }).state, 'default');
    assert.equal(fitMemoryModel(rows, { now: 1000000000, source: 'host' }).state, 'default');
  }
});

test('formula keeps Origin reservation even when absent and has no CPU ceiling', () => {
  const model = { state: 'default', slopeBytes: 512 * MiB };
  let result = calculateMemoryCapacity({ limitBytes: 4 * GiB, usedBytes: 1300 * MiB }, 0, model);
  assert.equal(result.kRaw, 3); assert.equal(result.kMemory, 3); assert.equal(result.reserveBytes, 512 * MiB);
  result = calculateMemoryCapacity({ limitBytes: 122 * GiB, usedBytes: 22 * GiB }, 0, model);
  assert.equal(result.kRaw, 174);
  result = calculateMemoryCapacity({ limitBytes: 4 * GiB, usedBytes: 3900 * MiB }, 0, model);
  assert.equal(result.kMemory, -2); assert.equal(result.kRaw, 1); assert.equal(result.reason, 'floor');
});

test('formula takes lower model or current bound and floors negative headroom', () => {
  const model = { state: 'fitted', slopeBytes: 500 * MiB, interceptBytes: 1300 * MiB };
  assert.equal(calculateMemoryCapacity({ limitBytes: 4 * GiB, usedBytes: 2250 * MiB }, 2, model).kRaw, 3);
  assert.equal(calculateMemoryCapacity({ limitBytes: 4 * GiB, usedBytes: 3800 * MiB }, 4, model).kRaw, 2);
  assert.equal(calculateMemoryCapacity({ limitBytes: 4 * GiB, usedBytes: 1000 * MiB }, 4, model).kRaw, 3);
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

test('repeated successful calculations publish fresh complete records every ten seconds', async t => {
  const f = fixture(t);
  const first = await f.capacity.tick({ mode: 'multi', now: 0 });
  assert.equal(await f.capacity.tick({ mode: 'multi', now: 9999 }), null);
  const next = await f.capacity.tick({ mode: 'multi', now: 10000 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.capacity.file)), next);
  assert.equal(next.computedAt - first.computedAt, 10000);
  assert.equal(next.memory.oomKills, 0);
  assert.equal(Object.hasOwn(next, 'cap'), false);
});

test('samples require stable counts, no starting sessions, no transition and readable inputs', async t => {
  const f = fixture(t);
  for (const now of [0, 110000, 119000]) await f.capacity.tick({ mode: 'multi', now, scenes: [scene('origin')] });
  assert.equal(fs.existsSync(f.capacity.sampleFile), false);
  await f.capacity.tick({ mode: 'multi', now: 120000, scenes: [scene('origin')] });
  assert.equal(f.capacity.samples.length, 1);
  assert.equal(f.capacity.samples[0].n, 1); assert.equal(f.capacity.samples[0].origin, true); assert.equal(f.capacity.samples[0].pool, 0);
  await f.capacity.tick({ mode: 'multi', now: 160000, scenes: [scene('origin', false)] });
  await f.capacity.tick({ mode: 'multi', now: 190000, scenes: [scene('origin')], transitioning: true });
  f.memory(null);
  await f.capacity.tick({ mode: 'multi', now: 220000, scenes: [scene('origin')] });
  assert.equal(f.capacity.samples.length, 1);
  f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1300 * MiB });
  await f.capacity.tick({ mode: 'multi', now: 250000, scenes: [scene('origin')] });
  await f.capacity.tick({ mode: 'multi', now: 260000, scenes: [scene('origin')] });
  await f.capacity.tick({ mode: 'multi', now: 280000, scenes: [scene('origin')] });
  assert.equal(f.capacity.samples.length, 3);
});

test('count changes between computation times reset the sample stability clock', async t => {
  const f = fixture(t);
  await f.capacity.tick({ mode: 'multi', now: 0, scenes: [scene()] });
  await f.capacity.tick({ mode: 'multi', now: 119000, scenes: [scene(), scene('b')] });
  await f.capacity.tick({ mode: 'multi', now: 120000, scenes: [scene()] });
  await f.capacity.tick({ mode: 'multi', now: 130000, scenes: [scene()] });
  assert.equal(f.capacity.samples.length, 0);
  await f.capacity.tick({ mode: 'multi', now: 240000, scenes: [scene()] });
  assert.equal(f.capacity.samples.length, 1);
});

test('fallback publishes one immediately and recovery waits a complete rise window', async t => {
  const f = fixture(t);
  await f.capacity.tick({ mode: 'multi', now: 0 });
  for (let now = 10000; now <= 120000; now += 10000) await f.capacity.tick({ mode: 'multi', now });
  assert.equal(f.capacity.lastPublished.k, 3);
  f.memory(null);
  const fallback = await f.capacity.tick({ mode: 'multi', now: 130000 });
  assert.equal(fallback.k, 1); assert.equal(fallback.source, 'fallback'); assert.equal(fallback.reason, 'inputs_unreadable');
  assert.equal(f.capacity.inputsUnreadableSince, 130000); assert.equal(Object.hasOwn(fallback, 'memory'), false);
  await f.capacity.tick({ mode: 'multi', now: 140000 });
  assert.equal(f.capacity.inputsUnreadableSince, 130000);
  f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1300 * MiB });
  for (let now = 150000; now < 270000; now += 10000) assert.equal((await f.capacity.tick({ mode: 'multi', now })).k, 1);
  assert.equal((await f.capacity.tick({ mode: 'multi', now: 270000 })).k, 3);
  assert.equal(f.capacity.inputsUnreadableSince, null);
});

test('fixed values override bad memory and cancellation resets startup smoothing', async t => {
  const f = fixture(t);
  f.baseline({ k: 6, fixed: true });
  const fixed = await f.capacity.tick({ mode: 'multi', now: 0 });
  assert.equal(fixed.k, 6); assert.equal(fixed.source, 'fixed'); assert.equal(fixed.kMemory, 3); assert.equal(fixed.kRaw, 3);
  f.memory(null);
  const unreadable = await f.capacity.tick({ mode: 'multi', now: 10000 });
  assert.equal(unreadable.k, 6); assert.equal(unreadable.kRaw, 6); assert.equal(unreadable.source, 'fixed');
  assert.equal(Object.hasOwn(unreadable, 'kMemory'), false);
  f.baseline({ k: 2, fixed: false });
  f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1300 * MiB });
  assert.equal((await f.capacity.tick({ mode: 'multi', now: 20000 })).k, 2);
});

test('single mode performs no reads or writes and reentry uses initial bound', async t => {
  let reads = 0;
  const f = fixture(t, { readMemory: async () => { reads++; return { source: 'host', limitBytes: 4 * GiB, usedBytes: 1300 * MiB }; } });
  const sentinel = 'existing-file'; fs.writeFileSync(f.capacity.file, sentinel);
  await f.capacity.tick({ mode: 'single', now: 0 });
  assert.equal(reads, 0); assert.equal(f.capacity.loaded, false);
  assert.equal(fs.readFileSync(f.capacity.file, 'utf8'), sentinel);
  assert.equal(fs.existsSync(f.capacity.sampleFile), false);
  await f.capacity.tick({ mode: 'multi', now: 10000 });
  for (let now = 20000; now <= 130000; now += 10000) await f.capacity.tick({ mode: 'multi', now });
  assert.equal(f.capacity.lastPublished.k, 3);
  await f.capacity.tick({ mode: 'single', now: 140000 });
  assert.equal((await f.capacity.tick({ mode: 'multi', now: 150000 })).k, 2);
});

test('in-flight reads do not overlap and cannot publish after switching to single', async t => {
  let finish, reads = 0;
  const f = fixture(t, { readMemory: () => { reads++; return new Promise(resolve => { finish = resolve; }); } });
  const pending = f.capacity.tick({ mode: 'multi', now: 0 });
  await Promise.resolve();
  assert.equal(await f.capacity.tick({ mode: 'multi', now: 10000 }), null);
  assert.equal(reads, 1);
  await f.capacity.tick({ mode: 'single', now: 11000 });
  finish({ source: 'host', limitBytes: 4 * GiB, usedBytes: 1300 * MiB });
  assert.equal(await pending, null);
  assert.equal(fs.existsSync(f.capacity.file), false);
});

test('sample replay skips malformed and newer records and rebuilds the same model', async t => {
  const f = fixture(t), now = 1000000000;
  const rows = [...bucket(1, 1.35 * GiB, 60, now), ...bucket(2, 1.85 * GiB, 60, now)];
  fs.writeFileSync(f.capacity.sampleFile, rows.map(row => JSON.stringify(row)).join('\n') + '\nno-json\n' + JSON.stringify({ ...rows[0], v: 2 }) + '\n');
  await f.capacity.tick({ mode: 'multi', now });
  assert.equal(f.capacity.samples.length, 120);
  assert.deepEqual(f.capacity.lastPublished.model, fitMemoryModel(rows, { now, source: 'cgroup2' }));
  assert.deepEqual(f.logs.find(row => row.event === 'capacity_samples_skipped'), { event: 'capacity_samples_skipped', count: 2 });
  const restarted = new PoolCapacity({ directory: f.directory, readMemory: async () => ({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1300 * MiB }), resolveBaseline: () => ({ k: 2, fixed: false }) });
  await restarted.tick({ mode: 'multi', now });
  assert.deepEqual(restarted.lastPublished.model, f.capacity.lastPublished.model);
});

test('rotation retains current source samples regardless of changed limits and drops old archives', async t => {
  const f = fixture(t), now = 10 * DAY;
  const recent = bucket(1, GiB, 60, now - DAY);
  fs.writeFileSync(path.join(f.directory, `pool-memory-samples.${now - DAY}.jsonl`), recent.map(row => JSON.stringify({ ...row, limit: 2 * GiB })).join('\n'));
  const old = path.join(f.directory, `pool-memory-samples.${now - 9 * DAY}.jsonl`);
  fs.writeFileSync(old, JSON.stringify(sample(2, 2 * GiB, now - 9 * DAY)));
  fs.writeFileSync(f.capacity.sampleFile, JSON.stringify(sample(2, 1.5 * GiB, now - 2 * DAY)) + '\n');
  await f.capacity.tick({ mode: 'multi', now });
  assert.equal(fs.existsSync(old), false);
  await f.capacity.tick({ mode: 'multi', now: now + 120000 });
  assert.equal(fs.existsSync(path.join(f.directory, `pool-memory-samples.${now + 120000}.jsonl`)), true);
  assert.equal(f.capacity.samples.filter(row => row.limit === 2 * GiB).length, 60);
  assert.equal(fs.readFileSync(f.capacity.sampleFile, 'utf8').trim().split('\n').length, 1);
});

test('size-based sample rotation and append failure preserve the prior in-memory model', async t => {
  const f = fixture(t), now = 1000000000;
  await f.capacity.tick({ mode: 'multi', now });
  fs.writeFileSync(f.capacity.sampleFile, ' '.repeat(10 * MiB + 1));
  await f.capacity.tick({ mode: 'multi', now: now + 120000 });
  assert.equal(fs.existsSync(path.join(f.directory, `pool-memory-samples.${now + 120000}.jsonl`)), true);
  const rows = [...bucket(1, GiB, 60, now), ...bucket(2, 1.5 * GiB, 60, now)];
  const logs = [], io = { ...fs, appendFileSync() { throw Object.assign(new Error('blocked'), { code: 'EACCES' }); } };
  const broken = new PoolCapacity({ directory: f.directory, fs: io, readMemory: async () => ({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1300 * MiB }), resolveBaseline: () => ({ k: 2, fixed: false }), log: row => logs.push(row) });
  broken.loaded = true; broken.samples = rows;
  await broken.tick({ mode: 'multi', now });
  await broken.tick({ mode: 'multi', now: now + 120000 });
  assert.equal(broken.samples.length, 120); assert.equal(broken.lastPublished.model.state, 'fitted');
  assert.equal(logs.some(row => row.event === 'capacity_samples_write_failed'), true);
});

test('publication failure retains only last successful record and tracks its start', async t => {
  let fail = false;
  const f = fixture(t, { publish(file, record) { if (fail) throw Object.assign(new Error('blocked'), { code: 'EACCES' }); writeCapacityAtomic(file, record); } });
  await f.capacity.tick({ mode: 'multi', now: 0 });
  const successful = f.capacity.lastPublished;
  fail = true;
  await f.capacity.tick({ mode: 'multi', now: 10000 });
  await f.capacity.tick({ mode: 'multi', now: 70000 });
  assert.equal(f.capacity.lastPublished, successful);
  assert.equal(f.capacity.publishFailedSince, 10000);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.capacity.file)), successful);
  fail = false;
  await f.capacity.tick({ mode: 'multi', now: 80000 });
  assert.equal(f.capacity.publishFailedSince, null); assert.equal(f.capacity.lastPublished.computedAt, 80000);
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

test('adjacent counts accumulate enough stable samples in a small pool', async t => {
  const f = fixture(t, { publish() {} });
  let now = 0;
  for (let i = 0; i < 64; i++, now += 30000) {
    await f.capacity.tick({ mode: 'multi', now, scenes: [scene('origin')] });
  }
  assert.equal(f.capacity.samples.filter(row => row.n === 1).length, 60);
  assert.equal(f.capacity.lastPublished.model.state, 'default');
  f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1800 * MiB });
  for (let i = 0; i < 64; i++, now += 30000) {
    await f.capacity.tick({ mode: 'multi', now, scenes: [scene('origin'), scene('a')] });
  }
  assert.equal(f.capacity.samples.filter(row => row.n === 2).length, 60);
  assert.equal(f.capacity.lastPublished.model.state, 'fitted');
  assert.equal(f.capacity.lastPublished.model.slopeBytes, 500 * MiB);
});

test('conservative startup, fitted pressure, recovery and restart follow one memory scenario', async t => {
  const f = fixture(t), epoch = 1000000000;
  const tick = (elapsed, scenes = []) => f.capacity.tick({ mode: 'multi', now: epoch + elapsed, scenes });
  assert.equal((await tick(0)).k, 2);
  f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1350 * MiB });
  assert.equal((await tick(10000, [scene('origin', false)])).kRaw, 4);
  f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1800 * MiB });
  for (let elapsed = 20000; elapsed <= 120000; elapsed += 10000) await tick(elapsed, [scene('origin')]);
  assert.equal(f.capacity.lastPublished.k, 3);
  for (const [elapsed, w, scenes] of [
    [130000, 2300, [scene('origin'), scene('a')]],
    [140000, 2800, [scene('origin'), scene('a'), scene('b')]],
  ]) {
    f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: w * MiB });
    assert.equal((await tick(elapsed, scenes)).k, 3);
  }
  // Replay a day of durable history to model the later steady workload.
  const rows = [0, 1, 2].flatMap(n => bucket(n, (1300 + 500 * n) * MiB, 60, epoch));
  fs.writeFileSync(f.capacity.sampleFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const fitted = new PoolCapacity({ directory: f.directory,
    readMemory: async () => f.currentMemory, resolveBaseline: () => ({ k: 2, fixed: false }) });
  f.currentMemory = { source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 2250 * MiB };
  let record = await fitted.tick({ mode: 'multi', now: epoch + DAY, scenes: [scene('origin'), scene('a')] });
  assert.equal(record.model.state, 'fitted'); assert.equal(record.kRaw, 3); assert.equal(record.k, 2);
  for (let elapsed = 10000; elapsed <= 120000; elapsed += 10000) await fitted.tick({ mode: 'multi', now: epoch + DAY + elapsed, scenes: [scene('origin'), scene('a')] });
  assert.equal(fitted.lastPublished.k, 3);
  f.currentMemory = { source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 3800 * MiB };
  record = await fitted.tick({ mode: 'multi', now: epoch + DAY + 130000, scenes: [scene('origin'), scene('a'), scene('b'), scene('c')] });
  assert.equal(record.k, 2);
  f.currentMemory = { source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 2800 * MiB };
  for (let elapsed = 140000; elapsed <= 250000; elapsed += 10000) record = await fitted.tick({ mode: 'multi', now: epoch + DAY + elapsed, scenes: [scene('origin'), scene('a'), scene('g')] });
  assert.equal(record.k, 3);
  const restarted = new PoolCapacity({ directory: f.directory, readMemory: async () => f.currentMemory,
    resolveBaseline: () => ({ k: 2, fixed: false }) });
  assert.equal((await restarted.tick({ mode: 'multi', now: epoch + DAY + 260000, scenes: [scene('origin'), scene('a'), scene('g')] })).k, 2);
});

test('initial unreadable inputs require a full recovery window before increasing', async t => {
  const f = fixture(t);
  f.memory(null);
  assert.equal((await f.capacity.tick({ mode: 'multi', now: 1000000000 })).k, 1);
  f.memory({ source: 'host', limitBytes: 4 * GiB, usedBytes: 1300 * MiB });
  for (let offset = 10000; offset < 130000; offset += 10000) {
    assert.equal((await f.capacity.tick({ mode: 'multi', now: 1000000000 + offset })).k, 1);
  }
  assert.equal((await f.capacity.tick({ mode: 'multi', now: 1000130000 })).k, 3);
});

test('a transition or startup observed during an asynchronous read blocks sample append', async t => {
  for (const blocking of [{ transitioning: true, scenes: [scene()] }, { scenes: [scene('a', false)] }]) {
    let finish, defer = false;
    const memory = { source: 'host', limitBytes: 4 * GiB, usedBytes: 1300 * MiB };
    const f = fixture(t, { readMemory: () => defer ? new Promise(resolve => { finish = resolve; }) : memory });
    await f.capacity.tick({ mode: 'multi', now: 0, scenes: [scene()] });
    defer = true;
    const pending = f.capacity.tick({ mode: 'multi', now: 120000, scenes: [scene()] });
    await Promise.resolve();
    assert.equal(await f.capacity.tick({ mode: 'multi', now: 121000, ...blocking }), null);
    finish(memory); await pending;
    assert.equal(f.capacity.samples.length, 0);
    assert.equal(fs.existsSync(f.capacity.sampleFile), false);
  }
});

test('cancelling fixed capacity retains the initial bound through a failed publication', async t => {
  let fail = false;
  const f = fixture(t, { publish(file, record) {
    if (fail) throw Object.assign(new Error('blocked'), { code: 'EACCES' });
    writeCapacityAtomic(file, record);
  } });
  f.baseline({ k: 6, fixed: true });
  assert.equal((await f.capacity.tick({ mode: 'multi', now: 0 })).k, 6);
  f.baseline({ k: 2, fixed: false });
  fail = true;
  assert.equal((await f.capacity.tick({ mode: 'multi', now: 10000 })).k, 2);
  assert.equal(f.capacity.lastPublished.k, 6);
  fail = false;
  assert.equal((await f.capacity.tick({ mode: 'multi', now: 20000 })).k, 2);
  for (let now = 30000; now < 140000; now += 10000) {
    assert.equal((await f.capacity.tick({ mode: 'multi', now })).k, 2);
  }
  assert.equal((await f.capacity.tick({ mode: 'multi', now: 140000 })).k, 3);
});

test('file and last-successful-publication readers agree before and after write failure expires', async t => {
  for (const fixed of [false, true]) {
    let fail = false;
    const baseline = { k: fixed ? 6 : 2, fixed };
    const f = fixture(t, { resolveBaseline: () => baseline, publish(file, record) {
      if (fail) throw Object.assign(new Error('blocked'), { code: 'EACCES' });
      writeCapacityAtomic(file, record);
    } });
    for (let now = 0; now <= 120000; now += 10000) await f.capacity.tick({ mode: 'multi', now });
    const compare = (now, expected) => {
      const fromFile = readPoolCapacity({ file: f.capacity.file, now, baseline });
      const fromMemory = readPoolCapacity({ record: f.capacity.lastPublished, now, baseline });
      assert.equal(fromFile.k, expected);
      assert.equal(fromMemory.k, expected);
      assert.equal(fromFile.source, fromMemory.source);
    };
    compare(120000, fixed ? 6 : 3);
    fail = true;
    await f.capacity.tick({ mode: 'multi', now: 130000 });
    compare(130000, fixed ? 6 : 3);
    await f.capacity.tick({ mode: 'multi', now: 191000 });
    compare(191000, fixed ? 6 : 2);
  }
});
