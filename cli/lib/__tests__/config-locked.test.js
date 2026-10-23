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
const LOCK_READY = 'F1_LOCK_READY\n';
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

function startWorker(payload, { waitForLock = false } = {}) {
  const child = spawn(process.execPath, [helper, JSON.stringify(payload)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let sawReady = false;
  let resolveReady;
  const readySignal = waitForLock
    ? new Promise(resolve => { resolveReady = resolve; })
    : Promise.resolve();
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (waitForLock && !sawReady && stdout.includes(LOCK_READY)) {
      sawReady = true;
      resolveReady();
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => {
      resolve({ status, signal, stdout: stdout.replace(LOCK_READY, ''), stderr, child });
    });
  });
  const ready = waitForLock
    ? Promise.race([
      readySignal,
      completion.then(({ status, signal }) => {
        if (!sawReady) {
          throw new Error(`lock holder exited before ready: status=${status} signal=${signal || 'none'} stderr=${stderr}`);
        }
      }),
    ])
    : readySignal;
  return { child, ready, completion };
}

function runWorker(payload) {
  return startWorker(payload).completion;
}

function startLockHolder(payload) {
  return startWorker(payload, { waitForLock: true });
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

function readCommitLedger(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
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
    const holder = startLockHolder({ configFile, lockFile, update: { set: { a: 1 } }, holdMs: 250 });
    await holder.ready;
    const b = runWorker({ configFile, lockFile, update: { set: { b: 2 } } });
    const [ra, rb] = await Promise.all([holder.completion, b]);
    assert.equal(ra.status, 0, ra.stderr);
    assert.equal(rb.status, 0, rb.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { untouched: true, a: 1, b: 2 });
  });

  it('times out without falling back when a real lock is busy', async () => {
    write({ untouched: true });
    const holder = startLockHolder({ configFile, lockFile, update: { set: { a: 1 } }, holdMs: 350 });
    await holder.ready;
    const result = await runWorker({ configFile, lockFile, update: { set: { b: 2 } }, waitMs: 50 });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /CONFIG_LOCK_TIMEOUT/);
    await holder.completion;
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { untouched: true, a: 1 });
  });

  it('enforces the default 2000ms wait budget with monotonic elapsed time', async () => {
    write({ untouched: true });
    const holder = startLockHolder({ configFile, lockFile, update: { set: { a: 1 } }, holdMs: 2300 });
    await holder.ready;
    const started = process.hrtime.bigint();
    const result = await runWorker({ configFile, lockFile, update: { set: { b: 2 } } });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(result.status, 2);
    assert.match(result.stderr, /CONFIG_LOCK_TIMEOUT/);
    assert.ok(elapsedMs >= 1850, `elapsed ${elapsedMs}ms`);
    assert.ok(elapsedMs < 2600, `elapsed ${elapsedMs}ms`);
    await holder.completion;
  });

  it('honors a shorter absolute deadline than waitMs', async () => {
    write({ untouched: true });
    const holder = startLockHolder({ configFile, lockFile, update: { set: { a: 1 } }, holdMs: 500 });
    await holder.ready;
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
    await holder.completion;
  });

  it('linearizes two real processes doing 100 same-key writes each', { timeout: 30_000 }, async () => {
    write({ shared: 'initial', untouched: true });
    const ledgerFile = path.join(root, 'commit-ledger.jsonl');
    const arrivalBarrier = path.join(root, 'second-result-reported');
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
    const payload = { configFile, lockFile, ledgerFile, arrivalBarrier, iterations: 100 };
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

    const committed = readCommitLedger(ledgerFile);
    assert.deepEqual(committed.map(entry => entry.sequence), Array.from({ length: 200 }, (_, index) => index + 1));
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).shared, committed.at(-1).value);
    assert.deepEqual(new Set(committed.map(entry => entry.value)), new Set(results.map(result => result.value)));

    const byValue = new Map(results.map(result => [result.value, result]));
    for (const [index, entry] of committed.entries()) {
      const expectedPrevious = index === 0 ? 'initial' : committed[index - 1].value;
      const reported = byValue.get(entry.value);
      assert.equal(reported.commitSequence, entry.sequence);
      assert.equal(entry.previous ?? 'initial', expectedPrevious);
      assert.equal(reported.previous ?? 'initial', expectedPrevious);
    }
    assert.ok(
      results.findIndex(result => result.commitSequence === 2)
        < results.findIndex(result => result.commitSequence === 1),
      'barrier must report commit 2 before commit 1',
    );
    assert.throws(
      () => assert.deepEqual(
        results.map(result => result.value),
        committed.map(entry => entry.value),
      ),
      /Expected values to be strictly deep-equal/,
    );
  });

  it('evaluates setIfAbsent after waiting for the lock', async () => {
    write({ untouched: true });
    const first = startLockHolder({
      configFile,
      lockFile,
      update: { set: { new_session_threshold: 30 } },
      holdMs: 200,
    });
    await first.ready;
    const conditional = runWorker({
      configFile,
      lockFile,
      update: { setIfAbsent: { new_session_threshold: 70 } },
    });
    const [, second] = await Promise.all([first.completion, conditional]);
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
    const crashing = startLockHolder({
      configFile,
      lockFile,
      update: { set: { lost: true } },
      crashAt: 'before_rename',
    });
    await crashing.ready;
    const crashed = await crashing.completion;
    assert.notEqual(crashed.status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { old: true });
    const recovered = await runWorker({ configFile, lockFile, update: { set: { recovered: true } } });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(fs.statSync(lockFile).ino, inode);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { old: true, recovered: true });
  });

  it('fails explicitly without running the writer when the holder cannot acquire a lock', async () => {
    write({ untouched: true });
    const holder = startLockHolder({
      configFile,
      lockFile,
      update: { set: { must_not_write: true } },
      holdMs: 1,
      fixtureLockFailure: true,
    });
    await assert.rejects(holder.ready, /lock holder exited before ready/);
    const result = await holder.completion;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CONFIG_TEST_LOCK_FAILED/);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { untouched: true });
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
