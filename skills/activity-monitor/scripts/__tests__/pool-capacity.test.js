import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PoolCapacity, fitMemoryModel, calculateMemoryCapacity, writeCapacityAtomic } from '../pool-capacity.js';
import { readPoolCapacity } from '../../../../cli/lib/session-pool-config.js';

const MiB = 1024 ** 2, GiB = 1024 ** 3, HOUR = 3600000, DAY = 86400000;
function sample(n, w, ts = 1000000000, src = 'cgroup2') {
  return { v: 2, ts, n, pool: n, origin: false, w, limit: 4 * GiB, src };
}
function bucket(n, w, count = 60, ts = 1000000000, src = 'cgroup2', hours = 5) {
  return Array.from({ length: count }, (_, i) => sample(n, w, ts - (i % hours) * HOUR, src));
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
  const rows = [...Array.from({ length: 300 }, (_, i) => sample(1, i % 60 + 1, 1000000000 - Math.floor(i / 60) * HOUR)), ...bucket(2, 100, 59)];
  let model = fitMemoryModel(rows, { now: 1000000000, source: 'cgroup2' });
  assert.equal(model.state, 'default');
  assert.deepEqual(model.buckets, [{ n: 1, highBytes: 57, samples: 300, hours: 5 }]);
  rows.push(sample(2, 100));
  model = fitMemoryModel(rows, { now: 1000000000, source: 'cgroup2' });
  assert.equal(model.state, 'fitted');
  assert.equal(model.slopeBytes, 256 * MiB);
});

test('fits adjacent buckets and uses median residual intercept', () => {
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
  assert.ok(Math.abs(model.interceptBytes / GiB - 0.875) < 1e-12);
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
  assert.ok(Math.abs(model.interceptBytes / GiB - 0.85) < 1e-12);
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
  result = calculateMemoryCapacity({ limitBytes: 4 * GiB, usedBytes: 3000 * MiB }, 0, model);
  assert.equal(result.kMemory, 0); assert.equal(result.kRaw, 1); assert.equal(result.reason, 'floor');
});

test('formula takes lower model or current bound and floors negative headroom', () => {
  const model = { state: 'fitted', slopeBytes: 500 * MiB, interceptBytes: 1300 * MiB };
  assert.equal(calculateMemoryCapacity({ limitBytes: 4 * GiB, usedBytes: 2250 * MiB }, 2, model).kRaw, 3);
  assert.equal(calculateMemoryCapacity({ limitBytes: 4 * GiB, usedBytes: 3800 * MiB }, 4, model).kRaw, 2);
  assert.equal(calculateMemoryCapacity({ limitBytes: 4 * GiB, usedBytes: 1000 * MiB }, 4, model).kRaw, 3);
});

test('hourly medians count singleton hours, use even averages and reject four-hour buckets', () => {
  const now = 10 * DAY;
  const hourly = (n, highs, counts) => highs.flatMap((w, i) =>
    Array.from({ length: counts[i] }, () => sample(n, w, now - i * HOUR)));
  const rows = [
    ...hourly(1, [1, 2, 3, 9, 10].map(w => w * GiB), [56, 1, 1, 1, 1]),
    ...hourly(2, [1, 2, 3, 10, 11, 12].map(w => w * GiB), [10, 10, 10, 10, 10, 10]),
    ...bucket(3, GiB, 600, now, 'cgroup2', 4),
  ];
  const model = fitMemoryModel(rows, { now, source: 'cgroup2' });
  assert.deepEqual(model.buckets, [
    { n: 1, highBytes: 3 * GiB, samples: 60, hours: 5 },
    { n: 2, highBytes: 6.5 * GiB, samples: 60, hours: 6 },
  ]);
  const boundary = [...bucket(1, GiB, 60, 4 * HOUR, 'cgroup2', 4),
    sample(1, GiB, 3599999), sample(1, GiB, 3600000)];
  assert.equal(fitMemoryModel(boundary, { now: 4 * HOUR, source: 'cgroup2' }).buckets[0].hours, 5);
  assert.equal(fitMemoryModel(boundary.slice(0, -2), { now: 4 * HOUR, source: 'cgroup2' }).buckets.length, 0);
});

test('window is strict at seven days and ignores future, old-version and other-source samples', () => {
  const now = 10 * DAY;
  const rows = [...bucket(1, GiB, 59, now), ...bucket(2, 2 * GiB, 60, now),
    sample(1, GiB, now - 7 * DAY), sample(1, GiB, now + 1),
    { ...sample(1, GiB, now), v: 1 }, sample(1, GiB, now, 'host')];
  assert.equal(fitMemoryModel(rows, { now, source: 'cgroup2' }).state, 'default');
  rows.push(sample(1, GiB, now - 7 * DAY + 1));
  const model = fitMemoryModel(rows, { now, source: 'cgroup2' });
  assert.equal(model.state, 'fitted');
  assert.equal(model.buckets[0].samples, 60);
  assert.equal(model.buckets[0].hours, 6);
});

test('Stephanie summary rejects a brief busy bucket until three ordinary hours accumulate', () => {
  const now = 10 * DAY;
  const rows = [6488509312, 7312927616, 7588768640].flatMap((w, n) =>
    bucket(n, w, [570, 629, 323][n], now, 'host', 6));
  rows.push(...bucket(3, 12482521984, 116, now, 'host', 2));
  const fit = () => fitMemoryModel(rows, { now, source: 'host' });
  const calculate = model => calculateMemoryCapacity({ limitBytes: 16764178432, usedBytes: 6820690816 }, 1, model);
  let model = fit();
  assert.deepEqual(model.buckets.map(row => [row.n, row.hours]), [[0, 6], [1, 6], [2, 6]]);
  assert.equal(model.slopeBytes, 550129664);
  assert.equal(model.interceptBytes, 6488509312);
  assert.equal(calculate(model).kMemory, 14);
  assert.equal(calculate(model).limitedBy, 'model');
  rows.push(...bucket(3, 7900000000, 13, now - 2 * HOUR, 'host', 1));
  assert.deepEqual(fit(), model);
  for (const hour of [3, 4]) rows.push(...bucket(3, 7900000000, 13, now - hour * HOUR, 'host', 1));
  model = fit();
  assert.equal(model.buckets[3].highBytes, 7900000000);
  assert.equal(model.buckets[3].hours, 5);
  assert.equal(model.slopeBytes, 470496896);
  assert.equal(model.interceptBytes, 6568142080);
  assert.equal(calculate(model).kMemory, 17);
});

test('yanjun synthetic seven-bucket fixture uses median overhead and rises after twelve calculations', async t => {
  const now = 10 * DAY;
  const values = [8011563008, 8007245824, 6684057600, 7211917312, 7517503488, 7675977728, 6677467136];
  const rows = values.flatMap((w, i) => bucket(i + 1, w, [2511, 2424, 322, 152, 97, 65, 81][i], now, 'cgroup2', 7));
  const f = fixture(t);
  fs.writeFileSync(f.capacity.sampleFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  f.memory({ source: 'cgroup2', limitBytes: 8 * GiB, usedBytes: 3617128448 });
  f.baseline({ k: 1, fixed: false });
  let record = await f.capacity.tick({ mode: 'multi', now, scenes: [scene('origin'), scene()] });
  assert.equal(record.model.slopeBytes, 268435456);
  assert.equal(record.model.interceptBytes, 6138175488);
  assert.equal(record.kMemory, 4);
  assert.equal(record.kRaw, 4);
  assert.equal(record.limitedBy, 'model');
  assert.equal(record.k, 1);
  for (let i = 1; i <= 12; i++) record = await f.capacity.tick({ mode: 'multi', now: now + i * 10000, scenes: [scene('origin'), scene()] });
  assert.equal(record.k, 4);
});

test('yanjun real sample replay qualifies only four buckets and yields seven ordinary-group slots', () => {
  const now = 1794569462245;
  const rows = fs.readFileSync(new URL('./fixtures/yanjun-memory-samples.jsonl', import.meta.url), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 5652);
  const model = fitMemoryModel(rows, { now, source: 'cgroup2' });
  assert.equal(model.state, 'fitted');
  assert.deepEqual(model.buckets.map(row => [row.n, row.hours, row.highBytes]), [
    [1, 38, 5913960448], [2, 35, 6149046272], [3, 9, 5953380352], [4, 6, 5890351104],
  ]);
  assert.equal(model.slopeBytes, 268435456);
  assert.equal(model.interceptBytes, 5380124672);
  const result = calculateMemoryCapacity({ limitBytes: 8589934592, usedBytes: 3617128448 }, 2, model);
  assert.equal(result.kMemory, 7);
  assert.equal(result.limitedBy, 'model');
});

test('even residuals average while even slopes use upper middle; growth and widespread pressure still constrain K', () => {
  const now = 10 * DAY;
  const fit = values => fitMemoryModel(values.flatMap((w, i) => bucket(i + 1, w, 60, now)), { now, source: 'cgroup2' });
  const memory = { limitBytes: 8 * GiB, usedBytes: 2.5 * GiB };
  let model = fit([6, 3, 3.5, 4.25].map(w => w * GiB));
  assert.equal(model.slopeBytes, 512 * MiB);
  assert.equal(model.interceptBytes, 2281701376);
  assert.equal(calculateMemoryCapacity(memory, 2, model).kMemory, 9);
  for (const [values, intercept, kMemory, reason] of [
    [[7.5, 3], 4.875, 8, 'memory'], [[7.5, 7.5], 7.125, -1, 'floor'],
  ]) {
    model = fit(values.map(w => w * GiB));
    assert.equal(model.interceptBytes, intercept * GiB);
    const result = calculateMemoryCapacity({ ...memory, usedBytes: 3 * GiB }, 2, model);
    assert.equal(result.kMemory, kMemory);
    assert.equal(result.reason, reason);
    assert.equal(result.limitedBy, 'model');
  }
  for (const [slope, kMemory] of [[0.5, 9], [1, 4]]) {
    model = fit([1, 2, 3, 4].map(n => (2 + slope * n) * GiB));
    const result = calculateMemoryCapacity({ ...memory, usedBytes: (2 + slope) * GiB }, 1, model);
    assert.equal(result.kMemory, kMemory);
    assert.equal(result.limitedBy, 'live');
  }
  model = fit([8e9, 8e9, 8e9, 8e9, 6.7e9, 6.7e9, 6.7e9]);
  assert.equal(model.interceptBytes, 6926258176);
  assert.equal(calculateMemoryCapacity({ ...memory, usedBytes: 3617128448 }, 2, model).kMemory, 1);
});

test('fractional hourly highs and slope affect K before integer-only F16 display rounding', async t => {
  const now = 10 * DAY, base = GiB, slope = 256 * MiB;
  const rows = [0, 3].flatMap(n => Array.from({ length: 60 }, (_, i) =>
    sample(n, base + n * slope + (n === 3 ? 1 : 0) + Number(i % 6 >= 3), now - (i % 6) * HOUR)));
  const model = fitMemoryModel(rows, { now, source: 'cgroup2' });
  assert.equal(model.buckets[0].highBytes, base + 0.5);
  assert.equal(model.slopeBytes, slope + 1 / 3);
  assert.equal(model.interceptBytes, base + 0.5);
  const f = fixture(t);
  fs.writeFileSync(f.capacity.sampleFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 0 });
  const record = await f.capacity.tick({ mode: 'multi', now });
  assert.equal(record.kMemory, 8);
  assert.equal(record.model.slopeBytes, slope);
  assert.equal(record.model.interceptBytes, base);
  assert.equal(record.model.buckets[0].highBytes, base);
  assert.equal(calculateMemoryCapacity(record.memory, 0, record.model).kMemory, 9);
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

test('capacity rises after twelve calculations at a slower than ten-second cadence', async t => {
  const f = fixture(t);
  assert.equal((await f.capacity.tick({ mode: 'multi', now: 0 })).k, 2);
  for (let calculation = 1; calculation <= 12; calculation++) {
    const record = await f.capacity.tick({ mode: 'multi', now: calculation * 10950 });
    assert.equal(record.kRaw, 3);
    assert.equal(record.k, calculation < 12 ? 2 : 3);
  }
});

test('one-second loops plus work time still permit capacity to rise', async t => {
  const f = fixture(t);
  let calculations = 0;
  for (let round = 0; round <= 120; round++) {
    const record = await f.capacity.tick({ mode: 'multi', now: round * (1000 + 95) });
    if (!record) continue;
    calculations++;
    assert.equal(record.k, calculations < 13 ? 2 : 3);
  }
  assert.equal(calculations, 13);
  assert.equal(f.capacity.lastPublished.k, 3);
  assert.equal(f.capacity.lastPublished.computedAt, 131400);
});

test('capacity rises to the smallest recent calculation rather than the latest', async t => {
  const f = fixture(t);
  await f.capacity.tick({ mode: 'multi', now: 0 });
  for (let now = 10000; now < 120000; now += 10000) {
    assert.equal((await f.capacity.tick({ mode: 'multi', now })).kRaw, 3);
  }
  f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 800 * MiB });
  const record = await f.capacity.tick({ mode: 'multi', now: 120000 });
  assert.equal(record.kRaw, 4);
  assert.equal(record.k, 3);
});

test('samples require stable counts, no starting sessions, no transition and readable inputs', async t => {
  const f = fixture(t);
  for (const now of [0, 110000, 119000]) await f.capacity.tick({ mode: 'multi', now, scenes: [scene('origin')] });
  assert.equal(fs.existsSync(f.capacity.sampleFile), false);
  await f.capacity.tick({ mode: 'multi', now: 120000, scenes: [scene('origin')] });
  assert.equal(f.capacity.samples.length, 1);
  assert.equal(f.capacity.samples[0].v, 2);
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
  assert.equal(Object.hasOwn(fallback, 'memory'), false);
  assert.equal(Object.hasOwn(fallback, 'limitedBy'), false);
  assert.equal(f.logs.filter(row => row.event === 'capacity_inputs_unreadable').length, 1);
  await f.capacity.tick({ mode: 'multi', now: 140000 });
  assert.equal(f.logs.filter(row => row.event === 'capacity_inputs_unreadable').length, 1);
  f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1300 * MiB });
  for (let now = 150000; now < 270000; now += 10000) assert.equal((await f.capacity.tick({ mode: 'multi', now })).k, 1);
  assert.equal((await f.capacity.tick({ mode: 'multi', now: 270000 })).k, 3);
  assert.equal(f.capacity.wasFallback, false);
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

test('in-flight reads do not overlap and cannot publish after switching to single', { timeout: 2000 }, async t => {
  let finish, reads = 0;
  const held = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { readMemory: () => { reads++; return held; } });
  const pending = f.capacity.tick({ mode: 'multi', now: 0 });
  await Promise.resolve();
  let secondSettled = false;
  const second = f.capacity.tick({ mode: 'multi', now: 10000 }).then(result => {
    secondSettled = true; assert.equal(result, null);
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1);
    assert.equal(secondSettled, true);
    await f.capacity.tick({ mode: 'single', now: 11000 });
  } finally {
    finish({ source: 'host', limitBytes: 4 * GiB, usedBytes: 1300 * MiB });
    await Promise.allSettled([pending, second]);
  }
  assert.equal(await pending, null);
  assert.equal(fs.existsSync(f.capacity.file), false);
});

test('sample replay skips malformed and newer records and rebuilds the same model', async t => {
  const f = fixture(t), now = 1000000000;
  const rows = [...bucket(1, 1.35 * GiB, 60, now), ...bucket(2, 1.85 * GiB, 60, now)];
  fs.writeFileSync(f.capacity.sampleFile, rows.map(row => JSON.stringify(row)).join('\n') + '\nno-json\n' + JSON.stringify({ ...rows[0], v: 3 }) + '\n');
  await f.capacity.tick({ mode: 'multi', now });
  assert.equal(f.capacity.samples.length, 120);
  assert.deepEqual(f.capacity.lastPublished.model, {
    state: 'fitted', slopeBytes: 512 * MiB, interceptBytes: Math.floor(0.85 * GiB), windowDays: 7,
    buckets: [1.35, 1.85].map((w, i) => ({ n: i + 1, highBytes: Math.floor(w * GiB), samples: 60, hours: 5 })),
  });
  assert.deepEqual(f.logs.find(row => row.event === 'capacity_samples_skipped'), { event: 'capacity_samples_skipped', count: 2 });
  const restarted = new PoolCapacity({ directory: f.directory, readMemory: async () => ({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1300 * MiB }), resolveBaseline: () => ({ k: 2, fixed: false }) });
  await restarted.tick({ mode: 'multi', now });
  assert.deepEqual(restarted.lastPublished.model, f.capacity.lastPublished.model);
});

test('upgrade ignores v1 from every source without rewriting files and accumulates v2 after restart', async t => {
  const now = 10 * DAY, f = fixture(t);
  const legacy = ['cgroup2', 'cgroup1', 'host', 'darwin'].flatMap(src =>
    [2, 3].flatMap(n => bucket(n, 7.5 * GiB, 2000, now, src)).map(row => ({ ...row, v: 1 })));
  const files = [f.capacity.sampleFile, ...[1, 2, 3].map(i => path.join(f.directory, `pool-memory-samples.${now - i * DAY}.jsonl`))];
  const originals = files.map((file, i) => {
    const content = legacy.filter((_, index) => index % files.length === i).map(row => JSON.stringify(row)).join('\n') + '\n';
    fs.writeFileSync(file, content);
    return content;
  });
  f.memory({ source: 'cgroup2', limitBytes: 8 * GiB, usedBytes: 2623737856 });
  f.baseline({ k: 6, fixed: false });
  const scenes = [scene('origin'), scene()];
  let record = await f.capacity.tick({ mode: 'multi', now, scenes });
  assert.equal(record.model.state, 'default');
  assert.deepEqual(record.model.buckets, []);
  assert.equal(record.model.slopeBytes, 512 * MiB);
  assert.equal(record.limitedBy, 'live');
  assert.equal(record.kRaw, 10);
  assert.equal(record.k, 6);
  assert.equal(f.logs.some(row => row.event === 'capacity_samples_skipped'), false);
  files.forEach((file, i) => assert.equal(fs.readFileSync(file, 'utf8'), originals[i]));
  for (let i = 1; i <= 12; i++) record = await f.capacity.tick({ mode: 'multi', now: now + i * 10000, scenes });
  assert.equal(record.k, 10);
  assert.equal(fs.readFileSync(files[0], 'utf8').startsWith(originals[0]), true);
  assert.equal(JSON.parse(fs.readFileSync(files[0], 'utf8').trim().split('\n').at(-1)).v, 2);
  files.slice(1).forEach((file, i) => assert.equal(fs.readFileSync(file, 'utf8'), originals[i + 1]));

  const fresh = [2, 3].flatMap(n => bucket(n, (1 + n / 2) * GiB, 60, now, 'cgroup2', 4));
  fs.appendFileSync(files[0], fresh.map(row => JSON.stringify(row)).join('\n') + '\n');
  const restart = () => new PoolCapacity({ directory: f.directory,
    readMemory: () => ({ source: 'cgroup2', limitBytes: 8 * GiB, usedBytes: 2623737856 }),
    resolveBaseline: () => ({ k: 6, fixed: false }) });
  let restarted = restart();
  record = await restarted.tick({ mode: 'multi', now: now + 130000, scenes });
  assert.equal(record.model.state, 'default');
  fs.appendFileSync(files[0], [2, 3].map(n => JSON.stringify(sample(n, (1 + n / 2) * GiB, now - 4 * HOUR))).join('\n') + '\n');
  restarted = restart();
  record = await restarted.tick({ mode: 'multi', now: now + 140000, scenes });
  assert.equal(record.model.state, 'fitted');
  assert.equal(record.model.buckets.every(row => row.hours === 5 && row.samples <= 62), true);
  assert.equal(restarted.samples.every(row => row.v === 2), true);
  const fixed = new PoolCapacity({ directory: f.directory, readMemory: () => ({ source: 'cgroup2', limitBytes: 8 * GiB, usedBytes: 2623737856 }),
    resolveBaseline: () => ({ k: 3, fixed: true }) });
  assert.equal((await fixed.tick({ mode: 'multi', now: now + 150000, scenes })).k, 3);
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

test('publication failure retains only last successful record', async t => {
  let fail = false;
  const f = fixture(t, { publish(file, record) { if (fail) throw Object.assign(new Error('blocked'), { code: 'EACCES' }); writeCapacityAtomic(file, record); } });
  await f.capacity.tick({ mode: 'multi', now: 0 });
  const successful = f.capacity.lastPublished;
  fail = true;
  await f.capacity.tick({ mode: 'multi', now: 10000 });
  await f.capacity.tick({ mode: 'multi', now: 70000 });
  assert.equal(f.capacity.lastPublished, successful);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.capacity.file)), successful);
  fail = false;
  await f.capacity.tick({ mode: 'multi', now: 80000 });
  assert.equal(f.capacity.lastPublished.computedAt, 80000);
});

test('a failed decrease does not lower published capacity when raw capacity recovers', async t => {
  let fail = false;
  const f = fixture(t, { publish(file, record) {
    if (fail) throw Object.assign(new Error('blocked'), { code: 'EACCES' });
    writeCapacityAtomic(file, record);
  } });
  f.baseline({ k: 3, fixed: false });
  const initial = await f.capacity.tick({ mode: 'multi', now: 0 });
  assert.equal(initial.kRaw, 3);
  assert.equal(initial.k, 3);

  fail = true;
  f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1800 * MiB });
  const failed = await f.capacity.tick({ mode: 'multi', now: 10000 });
  assert.equal(failed.kRaw, 2);
  assert.equal(failed.k, 2);
  assert.equal(f.capacity.lastPublished, initial);
  assert.equal(JSON.parse(fs.readFileSync(f.capacity.file, 'utf8')).k, 3);
  assert.ok(f.logs.some(row => row.event === 'capacity_publish_failed'));

  fail = false;
  f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1300 * MiB });
  // At 120 seconds the twelve calculations include the failed raw=2 decrease.
  // Recovery to the still-published K is not a rise and must not publish that 2.
  for (let now = 20000; now <= 120000; now += 10000) {
    const recovered = await f.capacity.tick({ mode: 'multi', now });
    assert.equal(recovered.kRaw, 3);
    assert.equal(recovered.k, 3);
    assert.equal(f.capacity.lastPublished.k, 3);
    assert.equal(JSON.parse(fs.readFileSync(f.capacity.file, 'utf8')).k, 3);
  }
  assert.equal(f.capacity.lastPublished.computedAt, 120000);
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

test('adjacent counts require five UTC hours as well as enough stable samples', async t => {
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
  assert.equal(f.capacity.lastPublished.model.state, 'default');
  for (let hour = 1; hour <= 4; hour++) {
    for (const scenes of [[scene('origin')], [scene('origin'), scene('a')]]) {
      now = (hour + 1) * HOUR + scenes.length * 180000;
      f.memory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: (scenes.length === 1 ? 1300 : 1800) * MiB });
      await f.capacity.tick({ mode: 'multi', now, scenes });
      await f.capacity.tick({ mode: 'multi', now: now + 120000, scenes });
    }
  }
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
