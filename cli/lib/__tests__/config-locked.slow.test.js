// covers: cli/lib/config-store.js cli/lib/config-lock.js cli/lib/config.js cli/lib/__tests__/fixtures/f1-worker.js cli/lib/__tests__/fixtures/f1-loop-worker.js
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateConfigStore } from '../config-store.js';

const helper = fileURLToPath(new URL('./fixtures/f1-worker.js', import.meta.url));
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



describe('atomic config store', () => {

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

});

describe('nested config merge intents', () => {

  it('preserves model siblings when independent writers update under the same lock', async t => {
    write({ model_rotation_thresholds: { claude: { opus: 65 }, codex: { small: 72 } }, keep: true });
    const writers = [
      startWorker({ configFile, lockFile, update: { merge: { model_rotation_thresholds: { claude: { sonnet: 62 } } } } }),
      startWorker({ configFile, lockFile, update: { merge: { model_rotation_thresholds: { claude: { haiku: 64 } } } } }),
    ];
    t.after(async () => {
      for (const { child } of writers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.allSettled(writers.map(writer => writer.completion));
    });
    for (const writer of writers) {
      const result = await writer.completion;
      assert.equal(result.status, 0, result.stderr);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), {
      model_rotation_thresholds: { claude: { opus: 65, sonnet: 62, haiku: 64 }, codex: { small: 72 } }, keep: true,
    });
  });

});
