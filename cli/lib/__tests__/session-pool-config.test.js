import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMemoryInputs, readMemoryLimit, resolveSessionPoolBaseline, readPoolCapacity } from '../session-pool-config.js';
import { calculateMemoryCapacity } from '../../../skills/activity-monitor/scripts/pool-capacity.js';

const MiB = 1024 ** 2, GiB = 1024 ** 3;
const error = code => Object.assign(new Error(code), { code });
function filesystem(entries = {}, directories = []) {
  const files = new Map(Object.entries(entries)), dirs = new Set(directories), reads = [];
  for (const file of files.keys()) {
    for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
      dirs.add(dir); if (dir === '/') break;
    }
  }
  return { files, dirs, reads,
    existsSync(file) { return files.has(file) || dirs.has(file); },
    statSync(file) { if (!files.has(file) && !dirs.has(file)) throw error('ENOENT'); return { isDirectory: () => dirs.has(file), mtimeMs: 1 }; },
    readFileSync(file) { reads.push(file); if (!files.has(file)) throw error('ENOENT'); const value = files.get(file); if (value instanceof Error) throw value; return value; },
  };
}
function info(total = 122 * GiB, available = 100 * GiB, swapTotal = 0, swapFree = 0) {
  return `MemTotal: ${total / 1024} kB\nMemAvailable: ${available / 1024} kB\nSwapTotal: ${swapTotal / 1024} kB\nSwapFree: ${swapFree / 1024} kB\n`;
}
function v2({ self = '/user.slice/work', limit = 4 * GiB, usage = 2047 * MiB, active = 0, inactive = 1989 * MiB, swap, meminfo = info() } = {}) {
  const directory = path.posix.join('/sys/fs/cgroup', self).replace(/\/$/, ''), entries = {
    '/proc/self/cgroup': `0::${self}\n`, '/proc/meminfo': meminfo,
    '/sys/fs/cgroup/cgroup.controllers': 'memory cpu',
    [directory + '/memory.max']: String(limit), [directory + '/memory.current']: String(usage),
    [directory + '/memory.stat']: `inactive_file ${inactive}\nactive_file ${active}\n`, [directory + '/memory.events']: 'oom_kill 4\n',
  };
  for (let dir = path.posix.dirname(directory); dir !== '/sys/fs' && dir !== '/'; dir = path.posix.dirname(dir)) {
    entries[dir + '/memory.max'] ??= 'max';
  }
  if (swap !== undefined) entries[directory + '/memory.swap.current'] = String(swap);
  return { fs: filesystem(entries), env: {}, platform: 'linux', directory };
}
function v1() {
  return { fs: filesystem({
    '/proc/self/cgroup': '4:cpu,memory:/docker/x\n', '/proc/meminfo': info(),
    '/sys/fs/cgroup/memory/docker/x/memory.limit_in_bytes': String(2 * GiB),
    '/sys/fs/cgroup/memory/docker/memory.limit_in_bytes': '9223372036854771712',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
    '/sys/fs/cgroup/memory/docker/x/memory.usage_in_bytes': String(1500 * MiB),
    '/sys/fs/cgroup/memory/docker/x/memory.stat': `total_inactive_file ${500 * MiB}\ntotal_active_file 0\n`,
  }), env: {}, platform: 'linux' };
}
function mac({ page = 16384, vm, sysctl, failure } = {}) {
  const calls = [];
  const text = vm ?? `Mach Virtual Memory Statistics: (page size of ${page} bytes)\nAnonymous pages: 400000.\nPages purgeable: 20000.\nPages wired down: 150000.\nPages occupied by compressor: 50000.\n`;
  return { platform: 'darwin', env: {}, totalMemoryBytes: 16 * GiB, calls,
    fs: filesystem(), execFile(name, args, options, done) {
      calls.push({ name, args, options });
      queueMicrotask(() => done(failure, name === 'vm_stat' ? text : (sysctl ?? '17179869184\n')));
      return { kill() {} };
    },
  };
}

test('cgroup limits follow namespace paths and the smallest ancestor', async t => {
  for (const self of ['/', '/system.slice/docker-x.scope']) await t.test(self, async () => {
    const fixture = v2({ self });
    if (self !== '/') fixture.fs.files.delete('/sys/fs/cgroup/memory.max');
    assert.deepEqual(await readMemoryInputs(fixture), { source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 58 * MiB, oomKills: 4 });
    assert.deepEqual(readMemoryLimit(fixture), { source: 'cgroup2', limitBytes: 4 * GiB });
  });
  const fixture = v2({ limit: 'max' });
  fixture.fs.files.set('/sys/fs/cgroup/user.slice/memory.max', String(2 * GiB));
  fixture.fs.files.set('/sys/fs/cgroup/user.slice/memory.current', String(GiB));
  fixture.fs.files.set('/sys/fs/cgroup/user.slice/memory.stat', 'inactive_file 0\nactive_file 0\n');
  assert.equal((await readMemoryInputs(fixture)).limitBytes, 2 * GiB);
  assert.equal((await readMemoryInputs(fixture)).usedBytes, GiB);
  fixture.fs.reads.length = 0;
  assert.equal(readMemoryLimit(fixture).limitBytes, 2 * GiB);
  assert.ok(fixture.fs.reads.every(file => !/memory\.(current|stat|swap|events)/.test(file)));
});

test('unlimited cgroups use whole-machine available memory regardless of swap', async () => {
  for (const self of ['/', '/user.slice/work']) {
    const fixture = v2({ self, limit: 'max', meminfo: info(122 * GiB, 100 * GiB, 2 * GiB, GiB) });
    assert.deepEqual(await readMemoryInputs(fixture), { source: 'host', limitBytes: 122 * GiB, usedBytes: 22 * GiB });
    assert.deepEqual(resolveSessionPoolBaseline(fixture), { k: 120, fixed: false });
  }
});

test('working memory excludes file cache and swap and respects host pressure', async () => {
  const fixture = v2({ usage: 4095 * MiB, inactive: 3900 * MiB });
  assert.equal((await readMemoryInputs(fixture)).usedBytes, 195 * MiB);
  fixture.fs.files.set(fixture.directory + '/memory.swap.current', String(512 * MiB));
  assert.equal((await readMemoryInputs(fixture)).usedBytes, 195 * MiB);
  fixture.fs.files.set('/proc/meminfo', info(122 * GiB, 512 * MiB));
  assert.equal((await readMemoryInputs(fixture)).usedBytes, 4 * GiB - 512 * MiB);
  fixture.fs.files.set(fixture.directory + '/memory.max', String(130 * GiB));
  assert.equal(readMemoryLimit(fixture).limitBytes, 122 * GiB);
});

test('active file cache is excluded using the exact 8 GiB container reading', async () => {
  const fixture = v2({ limit: 8 * GiB, usage: 3766181888, active: 922324992, inactive: 220119040 });
  fixture.fs.files.set(fixture.directory + '/memory.stat', 'active_file 922324992\ninactive_file 220119040\nshmem 0\n');
  const memory = await readMemoryInputs(fixture);
  assert.equal(memory.usedBytes, 2623737856);
  assert.notEqual(memory.usedBytes, 3546062848, 'Subtracting only inactive cache retains active cache');
});

test('both cgroup versions retain shared memory instead of subtracting all file memory', async () => {
  for (const legacy of [false, true]) {
    const fixture = legacy ? v1() : v2({ limit: 4 * GiB, usage: 3 * GiB });
    const directory = legacy ? '/sys/fs/cgroup/memory/docker/x' : fixture.directory;
    const prefix = legacy ? 'total_' : '';
    fixture.fs.files.set(directory + (legacy ? '/memory.limit_in_bytes' : '/memory.max'), String(4 * GiB));
    fixture.fs.files.set(directory + (legacy ? '/memory.usage_in_bytes' : '/memory.current'), String(3 * GiB));
    // Counters are integer bytes; keep the exact 1 GiB cache sum for this fixture.
    fixture.fs.files.set(directory + '/memory.stat', `${prefix}active_file ${Math.floor(0.6 * GiB)}\n${prefix}inactive_file ${GiB - Math.floor(0.6 * GiB)}\n${prefix}shmem ${0.5 * GiB}\n${legacy ? 'total_cache' : 'file'} ${1.5 * GiB}\n`);
    assert.equal((await readMemoryInputs(fixture)).usedBytes, 2 * GiB);
  }
});

test('cache-only pressure changes the real capacity calculation from the floor to five', async () => {
  const fixture = v2({ usage: 4095 * MiB, inactive: 3900 * MiB });
  const memory = await readMemoryInputs(fixture);
  const model = { state: 'default', slopeBytes: 512 * MiB };
  assert.equal(memory.usedBytes, 195 * MiB);
  assert.equal(calculateMemoryCapacity(memory, 0, model).kRaw, 5);
  assert.equal(calculateMemoryCapacity({ ...memory, usedBytes: 4095 * MiB }, 0, model).kRaw, 1);
});

test('swap inputs are never read even when missing, malformed or denied', async () => {
  for (const legacy of [false, true]) for (const value of [undefined, 'present', 'invalid', error('EACCES')]) {
    const fixture = legacy ? v1() : v2();
    const file = legacy ? '/sys/fs/cgroup/memory/docker/x/memory.memsw.usage_in_bytes'
      : fixture.directory + '/memory.swap.current';
    if (value !== undefined) fixture.fs.files.set(file, value === 'present' ? String((legacy ? 1500 + 512 : 512) * MiB) : value);
    assert.equal((await readMemoryInputs(fixture)).usedBytes, (legacy ? 1000 : 58) * MiB);
    assert.ok(!fixture.fs.reads.includes(file));
  }
});

test('16 GB host reading uses physical available memory without requiring swap fields', async () => {
  // The summary's used bytes are 128 bytes off the integer-kB meminfo granularity.
  const total = 16764178432, used = Math.round(6820690816 / 1024) * 1024;
  for (const swap of ['', `SwapTotal: ${4290000000 / 1024} kB\nSwapFree: 0 kB\n`, 'SwapTotal: invalid\nSwapFree: invalid\n']) {
    const fixture = v2({ limit: 'max', meminfo: `MemTotal: ${total / 1024} kB\nMemAvailable: ${(total - used) / 1024} kB\n${swap}` });
    assert.deepEqual(await readMemoryInputs(fixture), { source: 'host', limitBytes: total, usedBytes: used });
    assert.equal(used - 6820690816, 128);
  }
});

test('missing or malformed required cache counters follow the existing container fallback rules', async () => {
  for (const legacy of [false, true]) for (const name of ['active_file', 'inactive_file']) {
    for (const marker of [false, true]) for (const value of ['', 'invalid']) {
      const fixture = legacy ? v1() : v2();
      const directory = legacy ? '/sys/fs/cgroup/memory/docker/x' : fixture.directory;
      const prefix = legacy ? 'total_' : '';
      const other = name === 'active_file' ? 'inactive_file' : 'active_file';
      fixture.fs.files.set(directory + '/memory.stat', `${prefix}${other} 0\n${value ? `${prefix}${name} ${value}\n` : ''}`);
      if (marker) fixture.fs.files.set('/.dockerenv', '');
      const memory = await readMemoryInputs(fixture);
      if (marker) assert.equal(memory, null);
      else assert.equal(memory.source, 'host');
    }
  }
});

test('legacy cgroups prefer the full path, select ancestors and read namespace root only for missing directories', async () => {
  const fixture = v1();
  assert.deepEqual(await readMemoryInputs(fixture), { source: 'cgroup1', limitBytes: 2 * GiB, usedBytes: 1000 * MiB });
  fixture.fs.files.set('/sys/fs/cgroup/memory/docker/x/memory.memsw.usage_in_bytes', String(1800 * MiB));
  assert.equal((await readMemoryInputs(fixture)).usedBytes, 1000 * MiB);
  fixture.fs.files.set('/sys/fs/cgroup/memory/docker/memory.limit_in_bytes', String(GiB));
  fixture.fs.files.set('/sys/fs/cgroup/memory/docker/memory.usage_in_bytes', String(500 * MiB));
  fixture.fs.files.set('/sys/fs/cgroup/memory/docker/memory.stat', 'total_inactive_file 0\ntotal_active_file 0\n');
  assert.equal((await readMemoryInputs(fixture)).limitBytes, GiB);
  assert.equal((await readMemoryInputs(fixture)).usedBytes, 500 * MiB);
  fixture.fs.dirs.delete('/sys/fs/cgroup/memory/docker/x');
  fixture.fs.files.set('/sys/fs/cgroup/memory/memory.limit_in_bytes', String(3 * GiB));
  fixture.fs.files.set('/sys/fs/cgroup/memory/memory.usage_in_bytes', String(800 * MiB));
  fixture.fs.files.set('/sys/fs/cgroup/memory/memory.stat', 'total_inactive_file 0\ntotal_active_file 0\n');
  assert.equal((await readMemoryInputs(fixture)).limitBytes, 3 * GiB);
  const broken = v1();
  broken.fs.files.delete('/sys/fs/cgroup/memory/docker/x/memory.limit_in_bytes');
  broken.fs.files.set('/.dockerenv', '');
  assert.equal(await readMemoryInputs(broken), null);
});

test('unreadable cgroup inputs use only the four specified container markers', async t => {
  for (const file of ['memory.max', 'memory.current', 'memory.stat']) {
    for (const value of ['', 'not a number', error('EACCES')]) {
      for (const marker of ['docker', 'podman', 'kubernetes', 'root', 'none']) {
        await t.test(`${file} ${String(value)} ${marker}`, async () => {
          const fixture = v2({ self: marker === 'root' ? '/' : '/user.slice/work' });
          fixture.fs.files.set(fixture.directory + '/' + file, value);
          if (marker === 'docker') fixture.fs.files.set('/.dockerenv', '');
          if (marker === 'podman') fixture.fs.files.set('/run/.containerenv', '');
          if (marker === 'kubernetes') fixture.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
          const result = await readMemoryInputs(fixture);
          if (marker === 'none') assert.equal(result.source, 'host');
          else assert.equal(result, null);
        });
      }
    }
  }
  const fixture = v2();
  fixture.fs.files.delete('/proc/self/cgroup');
  assert.equal((await readMemoryInputs(fixture)).source, 'host');
  for (const self of ['/../outside', '/missing']) {
    const fixture = v2();
    fixture.fs.files.set('/proc/self/cgroup', `0::${self}\n`);
    fixture.fs.files.set('/.dockerenv', '');
    assert.equal(await readMemoryInputs(fixture), null);
    assert.equal(resolveSessionPoolBaseline(fixture).k, 1);
    fixture.fs.files.delete('/.dockerenv');
    assert.equal((await readMemoryInputs(fixture)).source, 'host');
  }
});

test('unreasonable readings fail directly rather than selecting a different source', async t => {
  for (const kind of ['cgroup', 'host']) for (const bad of ['zero limit', 'negative usage', 'oversized usage']) {
    await t.test(`${kind} ${bad}`, async () => {
      const fixture = v2({ self: '/user.slice/work', limit: kind === 'host' ? 'max' : 4 * GiB });
      if (kind === 'host') fixture.fs.files.set('/proc/meminfo', bad === 'zero limit' ? info(0, 0)
        : bad === 'negative usage' ? info(4 * GiB, 5 * GiB) : info(4 * GiB, -9 * GiB));
      else {
        if (bad === 'zero limit') fixture.fs.files.set(fixture.directory + '/memory.max', '0');
        if (bad === 'negative usage') fixture.fs.files.set(fixture.directory + '/memory.current', '0');
        if (bad === 'oversized usage') fixture.fs.files.set(fixture.directory + '/memory.current', String(20 * GiB));
      }
      assert.equal(await readMemoryInputs(fixture), null);
    });
  }
  const fixture = v2(); fixture.fs.files.delete('/proc/meminfo');
  assert.equal(await readMemoryInputs(fixture), null);
  assert.equal(readMemoryLimit(fixture), null);
});

test('baseline capacity honors fixed values and otherwise only the memory limit', () => {
  const fixture = v2();
  assert.deepEqual(resolveSessionPoolBaseline(fixture), { k: 2, fixed: false });
  fixture.fs.files.set('/.dockerenv', ''); fixture.fs.files.delete(fixture.directory + '/memory.max');
  assert.deepEqual(resolveSessionPoolBaseline(fixture), { k: 1, fixed: false });
  assert.deepEqual(resolveSessionPoolBaseline({ ...fixture, env: { ZYLOS_SESSION_POOL_SIZE: '5' }, config: { session_pool_size: 2 } }), { k: 5, fixed: true });
  for (const bad of [0, -1, 1.2, '5x', true, null]) assert.deepEqual(resolveSessionPoolBaseline({ ...fixture,
    env: { ZYLOS_SESSION_POOL_SIZE: bad }, config: { session_pool_size: 2 } }), { k: 2, fixed: true });
  const large = v2({ limit: 'max' });
  large.fs.files.set('/sys/fs/cgroup/cpu.max', '200000 100000');
  assert.equal(resolveSessionPoolBaseline({ ...large, availableParallelism: 2, cpuCount: 2, config: { session_pool_max: 3 } }).k, 120);
  assert.ok(large.fs.reads.every(file => !file.includes('cpu')));
  const darwin = mac();
  assert.deepEqual(resolveSessionPoolBaseline(darwin), { k: 14, fixed: false });
  assert.equal(darwin.calls.length, 0);
  assert.deepEqual(resolveSessionPoolBaseline({ platform: 'freebsd', env: {} }), { k: 1, fixed: false });
  assert.equal(readMemoryLimit({ platform: 'darwin', totalMemoryBytes: 0 }), null);
});

test('macOS usage parses both page sizes without requesting swap or Linux inputs', async () => {
  const fixture = mac();
  assert.deepEqual(await readMemoryInputs(fixture), { source: 'darwin', limitBytes: 16 * GiB, usedBytes: 580000 * 16384 });
  assert.deepEqual(fixture.calls.map(call => [call.name, call.args, call.options.timeout]), [
    ['vm_stat', [], 2000], ['sysctl', ['-n', 'hw.memsize'], 2000],
  ]);
  assert.deepEqual(fixture.fs.reads, []);
  for (const page of [4096, 16384]) {
    assert.equal((await readMemoryInputs(mac({ page }))).usedBytes, 580000 * page);
  }
});

test('macOS missing fields, bad values and command failures make the reading unavailable', async () => {
  for (const options of [
    // All page counters remain valid; only the header's page size is missing.
    { vm: 'Mach Virtual Memory Statistics:\nAnonymous pages: 400000.\nPages purgeable: 20000.\nPages wired down: 150000.\nPages occupied by compressor: 50000.\n' },
    { vm: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nAnonymous pages: 1.\nPages purgeable: 0.\nPages occupied by compressor: 1.\n' },
    { sysctl: '' }, { sysctl: '0\n' }, { sysctl: 'not a number\n' }, { failure: error('EXIT_1') },
    { vm: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nAnonymous pages: 0.\nPages purgeable: 1.\nPages wired down: 0.\nPages occupied by compressor: 0.\n' },
  ]) assert.equal(await readMemoryInputs(mac(options)), null);
  assert.equal(await readMemoryInputs({ platform: 'freebsd' }), null);
});

test('macOS command deadline bounds a never-returning command without blocking other work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let killed = 0, progressed = false, settled = false;
  const reading = readMemoryInputs({ platform: 'darwin', execFile() { return { kill() { killed++; } }; } })
    .then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(() => { progressed = true; resolve(); }));
  assert.equal(progressed, true);
  t.mock.timers.tick(1999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(killed, 0);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true, 'The memory read must settle at the two-second command deadline');
  assert.equal(await reading, null);
  assert.ok(killed >= 1);
});

test('published capacity validates record types and freshness and resolves all fallback paths', () => {
  const now = 100000, baseline = { k: 2, fixed: false };
  const fresh = { v: 1, k: 3, computedAt: now, source: 'auto', reason: 'floor' };
  for (const age of [-5000, 0, 60000]) {
    const result = readPoolCapacity({ record: { ...fresh, computedAt: now - age }, now,
      baseline: () => { throw new Error('Fresh records must not read baseline inputs'); } });
    assert.equal(result.k, 3); assert.equal(result.valid, true); assert.equal(result.fresh, true);
    assert.equal(result.record.reason, 'floor');
  }
  for (const age of [-6000, 61000]) {
    const result = readPoolCapacity({ record: { ...fresh, computedAt: now - age }, now, baseline });
    assert.equal(result.k, 2); assert.equal(result.valid, true); assert.equal(result.fresh, false);
    assert.equal(readPoolCapacity({ record: { ...fresh, k: 1, computedAt: now - age }, now, baseline }).k, 1);
    assert.equal(readPoolCapacity({ record: { ...fresh, computedAt: now - age }, now, baseline: { k: 6, fixed: true } }).k, 6);
  }
  for (const record of [null, [], { ...fresh, v: 2 }, { ...fresh, k: 0 }, { ...fresh, k: '3' }, { ...fresh, computedAt: 1.5 }]) {
    const result = readPoolCapacity({ record, now, baseline });
    assert.equal(result.valid, false); assert.equal(result.fresh, false); assert.equal(result.k, 2);
    assert.equal(readPoolCapacity({ record, now, baseline: { k: 6, fixed: true } }).k, 6);
  }
});

test('file records and fixed configuration are cached by mtime and refreshed after changes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'config.json'), file = path.join(directory, 'pool-capacity.json');
  fs.writeFileSync(configFile, JSON.stringify({ session_pool_size: 2 }));
  let reads = 0;
  const io = { ...fs, readFileSync(...args) { reads++; return fs.readFileSync(...args); } };
  const options = { configFile, file, fs: io, env: {}, platform: 'freebsd', now: 100000 };
  assert.equal(readPoolCapacity(options).k, 2);
  assert.equal(readPoolCapacity(options).k, 2);
  assert.equal(reads, 1);
  fs.writeFileSync(configFile, JSON.stringify({ session_pool_size: 5 }));
  fs.utimesSync(configFile, new Date(200000), new Date(200000));
  assert.equal(readPoolCapacity(options).k, 5);
  fs.writeFileSync(file, JSON.stringify({ v: 1, k: 9, computedAt: 100000 }));
  assert.equal(readPoolCapacity(options).k, 9);
  assert.equal(readPoolCapacity(options).k, 9);
  assert.equal(reads, 3);
  fs.writeFileSync(file, '{broken'); fs.utimesSync(file, new Date(300000), new Date(300000));
  assert.equal(readPoolCapacity(options).k, 5);
  fs.writeFileSync(file, JSON.stringify({ v: 1, k: '9', computedAt: 100000 })); fs.utimesSync(file, new Date(400000), new Date(400000));
  assert.equal(readPoolCapacity(options).k, 5);
  fs.writeFileSync(file, JSON.stringify({ v: 1, k: 9, computedAt: 1 })); fs.utimesSync(file, new Date(500000), new Date(500000));
  assert.equal(readPoolCapacity(options).k, 5);
});

test('unlimited legacy cgroups use the host without reading usage', async () => {
  const fixture = v1();
  fixture.fs.files.set('/sys/fs/cgroup/memory/docker/x/memory.limit_in_bytes', '9223372036854771712');
  // Keep valid usage/stat files: a wrong unlimited threshold must select cgroup
  // usage instead of coincidentally reaching the host through a missing file.
  assert.equal(fixture.fs.files.get('/sys/fs/cgroup/memory/docker/x/memory.usage_in_bytes'),String(1500 * MiB));
  assert.deepEqual(await readMemoryInputs(fixture), { source: 'host', limitBytes: 122 * GiB, usedBytes: 22 * GiB });
  assert.ok(fixture.fs.reads.every(file => !file.endsWith('/memory.usage_in_bytes') && !file.endsWith('/memory.stat')));
  assert.equal(resolveSessionPoolBaseline(fixture).k, 120);
});

test('capacity file permission failures use the current baseline and never a stale cached record', () => {
  const file = '/fixture/pool-capacity.json';
  const io = filesystem({ [file]: JSON.stringify({ v: 1, k: 9, computedAt: 100000 }) });
  let mtime = 1;
  io.statSync = () => ({ mtimeMs: mtime });
  const options = { fs: io, file, now: 100000, baseline: { k: 2, fixed: false } };
  assert.equal(readPoolCapacity(options).k, 9);
  mtime = 2; io.files.set(file, error('EACCES'));
  assert.equal(readPoolCapacity(options).k, 2);
  assert.equal(readPoolCapacity({ ...options, baseline: { k: 5, fixed: true } }).k, 5);
});

test('startup baseline and supervisor fallback agree on the same memory and configuration inputs', () => {
  const restricted = v2();
  const unreadable = v2();
  unreadable.fs.files.set('/.dockerenv', '');
  unreadable.fs.files.delete(unreadable.directory + '/memory.max');
  const host = v2({ limit: 'max' });
  const fixed = { ...restricted, env: { ZYLOS_SESSION_POOL_SIZE: '5' }, config: { session_pool_size: 2 } };
  for (const options of [restricted, unreadable, host, mac(), fixed]) {
    const startupK = resolveSessionPoolBaseline(options).k;
    const supervisorK = readPoolCapacity({ ...options, record: null,
      baseline: () => resolveSessionPoolBaseline(options) }).k;
    assert.equal(supervisorK, startupK);
  }
});
