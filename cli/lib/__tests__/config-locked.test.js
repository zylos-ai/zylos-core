import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateConfigStore } from '../config-store.js';
import { CONFIG_LOCK_FALLBACK_WARNING, updateConfigWithLock } from '../config-lock.js';

const helper = fileURLToPath(new URL('./fixtures/f1-worker.js', import.meta.url));
const loopHelper = fileURLToPath(new URL('./fixtures/f1-loop-worker.js', import.meta.url));
let root;
let configFile;
let lockFile;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-config-locked-'));
  configFile = path.join(root, '.zylos', 'config.json');
  lockFile = `${configFile}.lock`;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(config) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config) + '\n');
}

function runWorker(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, JSON.stringify(payload)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr, child }));
  });
}

function runLoopWorker(payload, onResult) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [loopHelper, JSON.stringify(payload)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (line) onResult(JSON.parse(line));
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stderr, pending }));
  });
}

function commitOrder(results, initial) {
  const byPrevious = new Map();
  for (const result of results) {
    const key = result.previous ?? initial;
    assert.equal(byPrevious.has(key), false, `duplicate successor for ${key}`);
    byPrevious.set(key, result.value);
  }
  const order = [];
  let cursor = initial;
  while (byPrevious.has(cursor)) {
    cursor = byPrevious.get(cursor);
    order.push(cursor);
  }
  assert.equal(order.length, results.length, 'results must form one complete commit chain');
  return order;
}

function assertReportedInCommitOrder(reported, committed) {
  assert.deepEqual(reported.map(result => result.value), committed);
}

describe('atomic config store', () => {
  it('does not create a temporary file for a no-op', () => {
    write({ value: 1 });
    const result = updateConfigStore(configFile, { set: { value: 1 } }, {
      openSync: () => { throw new Error('must not open'); },
    });
    assert.equal(result.changed, false);
  });

  it('classifies failures before and after rename', () => {
    write({ old: true });
    assert.throws(() => updateConfigStore(configFile, { set: { next: true } }, {
      renameSync: () => { throw new Error('rename failed'); },
    }), error => {
      assert.equal(error.code, 'CONFIG_WRITE_FAILED');
      assert.equal(error.phase, 'before_rename');
      assert.deepEqual(error.persisted, []);
      return true;
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { old: true });

    let opens = 0;
    assert.throws(() => updateConfigStore(configFile, { set: { next: true } }, {
      fsyncSync: (fd) => {
        opens += 1;
        if (opens === 2) throw new Error('directory fsync failed');
        fs.fsyncSync(fd);
      },
    }), error => error.code === 'CONFIG_WRITE_FAILED' && error.phase === 'after_rename'
      && error.persisted === null);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { old: true, next: true });
  });

  it('persists __proto__ as an own key and returns its previous value', () => {
    write(JSON.parse('{"__proto__":{"old":true}}'));
    const result = updateConfigStore(configFile, JSON.parse('{"set":{"__proto__":{"next":true}}}'));
    assert.equal(Object.hasOwn(result.previous, '__proto__'), true);
    assert.deepEqual(result.previous.__proto__, { old: true });
    const persisted = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(Object.hasOwn(persisted, '__proto__'), true);
    assert.deepEqual(persisted.__proto__, { next: true });

    const absentFile = path.join(root, '.zylos', 'absent.json');
    const absent = updateConfigStore(absentFile, JSON.parse('{"setIfAbsent":{"__proto__":{"created":true}}}'));
    assert.equal(Object.hasOwn(absent.config, '__proto__'), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(absentFile, 'utf8')).__proto__, { created: true });
  });
});
describe('config locking', () => {
  it('serializes real processes and preserves both writers', async () => {
    write({ untouched: true });
    const a = runWorker({ configFile, lockFile, update: { set: { a: 1 } }, holdMs: 250 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const b = runWorker({ configFile, lockFile, update: { set: { b: 2 } } });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 0, ra.stderr);
    assert.equal(rb.status, 0, rb.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { untouched: true, a: 1, b: 2 });
  });

  it('times out without falling back when a real lock is busy', async () => {
    write({ untouched: true });
    const holder = runWorker({ configFile, lockFile, update: { set: { a: 1 } }, holdMs: 350 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const result = await runWorker({ configFile, lockFile, update: { set: { b: 2 } }, waitMs: 50 });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /CONFIG_LOCK_TIMEOUT/);
    await holder;
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { untouched: true, a: 1 });
  });

  it('enforces the default 2000ms wait budget with monotonic elapsed time', async () => {
    write({ untouched: true });
    const holder = runWorker({ configFile, lockFile, update: { set: { a: 1 } }, holdMs: 2300 });
    await new Promise(resolve => setTimeout(resolve, 75));
    const started = process.hrtime.bigint();
    const result = await runWorker({ configFile, lockFile, update: { set: { b: 2 } } });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(result.status, 2);
    assert.match(result.stderr, /CONFIG_LOCK_TIMEOUT/);
    assert.ok(elapsedMs >= 1850, `elapsed ${elapsedMs}ms`);
    assert.ok(elapsedMs < 2600, `elapsed ${elapsedMs}ms`);
    await holder;
  });

  it('honors a shorter absolute deadline than waitMs', async () => {
    write({ untouched: true });
    const holder = runWorker({ configFile, lockFile, update: { set: { a: 1 } }, holdMs: 500 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const started = process.hrtime.bigint();
    const result = await runWorker({
      configFile,
      lockFile,
      update: { set: { b: 2 } },
      waitMs: 2_000,
      deadlineAt: Date.now() + 100,
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(result.status, 2);
    assert.match(result.stderr, /CONFIG_LOCK_TIMEOUT/);
    assert.ok(elapsedMs >= 50, `elapsed ${elapsedMs}ms`);
    assert.ok(elapsedMs < 500, `elapsed ${elapsedMs}ms`);
    await holder;
  });

  it('linearizes two real processes doing 100 same-key writes each', { timeout: 30_000 }, async () => {
    write({ shared: 'initial', untouched: true });
    const results = [];
    const observed = new Set();
    const observerErrors = [];
    let observing = true;
    const observe = async () => {
      while (observing) {
        try {
          const snapshot = JSON.parse(fs.readFileSync(configFile, 'utf8'));
          assert.equal(snapshot.untouched, true);
          observed.add(snapshot.shared);
        } catch (error) {
          observerErrors.push(error);
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    };
    const observer = observe();
    const payload = { configFile, lockFile, iterations: 100 };
    const [a, b] = await Promise.all([
      runLoopWorker({ ...payload, writer: 'a' }, result => results.push(result)),
      runLoopWorker({ ...payload, writer: 'b' }, result => results.push(result)),
    ]);
    observing = false;
    await observer;

    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.equal(a.pending, '');
    assert.equal(b.pending, '');
    assert.equal(results.length, 200);
    assert.deepEqual(observerErrors, []);
    assert.ok([...observed].some(value => value?.startsWith('a:')), 'observer missed writer a');
    assert.ok([...observed].some(value => value?.startsWith('b:')), 'observer missed writer b');

    const committed = commitOrder(results, 'initial');
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).shared, committed.at(-1));
    assert.deepEqual(new Set(committed), new Set(results.map(result => result.value)));

    const byCommit = new Map(results.map(result => [result.value, result]));
    const committedResults = committed.map(value => byCommit.get(value));
    assertReportedInCommitOrder(committedResults, committed);
    assert.throws(
      () => assertReportedInCommitOrder([...committedResults].reverse(), committed),
      /Expected values to be strictly deep-equal/,
    );
  });

  it('evaluates setIfAbsent after waiting for the lock', async () => {
    write({ untouched: true });
    const first = runWorker({
      configFile,
      lockFile,
      update: { set: { new_session_threshold: 30 } },
      holdMs: 200,
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const conditional = runWorker({
      configFile,
      lockFile,
      update: { setIfAbsent: { new_session_threshold: 70 } },
    });
    const [, second] = await Promise.all([first, conditional]);
    assert.equal(second.status, 0, second.stderr);
    const result = JSON.parse(second.stdout);
    assert.equal(result.changed, false);
    assert.deepEqual(result.skipped, ['new_session_threshold']);
    assert.equal(JSON.parse(fs.readFileSync(configFile)).new_session_threshold, 30);
  });

  it('keeps the fixed lock inode and old F1 when the writer dies before rename', async () => {
    write({ old: true });
    fs.closeSync(fs.openSync(lockFile, 'a', 0o600));
    const inode = fs.statSync(lockFile).ino;
    const crashed = await runWorker({
      configFile,
      lockFile,
      update: { set: { lost: true } },
      crashAt: 'before_rename',
    });
    assert.notEqual(crashed.status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { old: true });
    const recovered = await runWorker({ configFile, lockFile, update: { set: { recovered: true } } });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(fs.statSync(lockFile).ino, inode);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { old: true, recovered: true });
  });

  it('uses atomic fallback with exactly one warning only when capability is absent', () => {
    write({ untouched: true });
    let warning = '';
    const result = updateConfigWithLock({ configFile, lockFile, update: { set: { a: 1 } } }, {
      capability: null,
      writeStderr: text => { warning += text; },
    });
    assert.equal(result.changed, true);
    assert.equal(warning, CONFIG_LOCK_FALLBACK_WARNING);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { untouched: true, a: 1 });
  });

  it('classifies a lost helper result as unknown and never as pre-rename', () => {
    write({ untouched: true });
    assert.throws(() => updateConfigWithLock({ configFile, lockFile, update: { set: { a: 1 } } }, {
      capability: { backend: 'linux-flock', executable: '/usr/bin/flock' },
      spawn: () => ({ status: 0, signal: null, stdout: '', stderr: '' }),
    }), error => error.code === 'CONFIG_WRITE_UNKNOWN' && error.phase === 'unknown' && error.persisted === null);
  });

  it('classifies a real committed write with truncated helper output as unknown', () => {
    write({ untouched: true });
    const storeUrl = new URL('../config-store.js', import.meta.url).href;
    const script = `
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      const { configFile, update } = JSON.parse(input);
      const { updateConfigStore } = await import(${JSON.stringify(storeUrl)});
      updateConfigStore(configFile, update);
      process.stdout.write('{"ok":true,"result":');
    `;
    assert.throws(() => updateConfigWithLock({ configFile, lockFile, update: { set: { committed: true } } }, {
      capability: { backend: 'linux-flock', executable: '/usr/bin/flock' },
      spawn: (_executable, _args, options) => spawnSync(
        process.execPath,
        ['--input-type=module', '-e', script],
        options,
      ),
    }), error => error.code === 'CONFIG_WRITE_UNKNOWN'
      && error.phase === 'unknown'
      && error.persisted === null);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { untouched: true, committed: true });
  });

  it('classifies an invalid helper envelope as an unknown commit result', () => {
    assert.throws(() => updateConfigWithLock({ configFile, lockFile, update: { set: { a: 1 } } }, {
      capability: { backend: 'linux-flock', executable: '/usr/bin/flock' },
      spawn: () => ({ status: 0, signal: null, stdout: '{}', stderr: '' }),
    }), error => error.code === 'CONFIG_WRITE_UNKNOWN'
      && error.phase === 'unknown'
      && error.persisted === null);
  });

  it('keeps unknown commit semantics at the public API when the real helper exceeds spawnSync output limits', async () => {
    write({ oversized: 'x'.repeat(1_200_000) });
    const originalZylosDir = process.env.ZYLOS_DIR;
    process.env.ZYLOS_DIR = root;
    const { updateZylosConfigLocked } = await import(`../config.js?overflow=${Date.now()}`);
    try {
      assert.throws(() => updateZylosConfigLocked({ set: { committed: true } }), error => error.code === 'CONFIG_WRITE_UNKNOWN'
        && error.phase === 'unknown'
        && error.persisted === null
        && error.cause?.code === 'ENOBUFS');
    } finally {
      if (originalZylosDir === undefined) delete process.env.ZYLOS_DIR;
      else process.env.ZYLOS_DIR = originalZylosDir;
    }
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).committed, true);
  });

  it('does not classify non-contention flock failures as timeouts', () => {
    assert.throws(() => updateConfigWithLock({ configFile, lockFile, update: { set: { a: 1 } } }, {
      capability: { backend: 'linux-flock', executable: '/usr/bin/flock' },
      spawn: () => ({ status: 1, signal: null, stdout: '', stderr: 'injected helper failure' }),
    }), error => error.code === 'CONFIG_LOCK_FAILED' && /injected helper failure/.test(error.message));
  });
});
