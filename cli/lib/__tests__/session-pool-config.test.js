import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readMemoryInputs, readMemoryLimit, resolveSessionPoolBaseline, readPoolCapacity } from '../session-pool-config.js';

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
