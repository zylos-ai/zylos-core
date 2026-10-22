import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateConfigStore } from '../config-store.js';
import { CONFIG_LOCK_FALLBACK_WARNING, updateConfigWithLock } from '../config-lock.js';

const helper = fileURLToPath(new URL('./fixtures/f1-worker.js', import.meta.url));
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

  it('does not classify non-contention flock failures as timeouts', () => {
    assert.throws(() => updateConfigWithLock({ configFile, lockFile, update: { set: { a: 1 } } }, {
      capability: { backend: 'linux-flock', executable: '/usr/bin/flock' },
      spawn: () => ({ status: 1, signal: null, stdout: '', stderr: 'injected helper failure' }),
    }), error => error.code === 'CONFIG_LOCK_FAILED' && /injected helper failure/.test(error.message));
  });
});
