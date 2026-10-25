import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withMemoryLock } from '../sync-lock.js';
const moduleUrl = new URL('../sync-lock.js', import.meta.url).href;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lock-'));

// DM-40: callback process retains the lock after acquisition helper exits.
test('parent retains F8, cancellation cannot execute a late callback, inode stays fixed', async () => {
  const run = tmp();
  let checked;
  await withMemoryLock(run, async assertHeld => {
    checked = assertHeld; assertHeld();
    const inode = fs.statSync(path.join(run, 'memory.lock')).ino;
    let called = false;
    await assert.rejects(withMemoryLock(run, () => { called = true; }, { waitMs: 80 }), { code: 'LOCK_TIMEOUT' });
    assert.equal(called, false);
    assert.equal(fs.statSync(path.join(run, 'memory.lock')).ino, inode);
    const controller = new AbortController();
    const waiting = withMemoryLock(run, () => { called = true; }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(waiting, { code: 'LOCK_TIMEOUT' });
    assert.equal(called, false);
  });
  assert.throws(checked, { code: 'LOCK_LOST' });
  await withMemoryLock(run, assertHeld => assertHeld());
});

// DM-40: real stopped holder, full 10s wait, resume, and process death.
test('SIGSTOP retains F8 for 10 seconds; SIGCONT and kill release normally', { timeout: 16000 }, async () => {
  const run = tmp();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withMemoryLock } from ${JSON.stringify(moduleUrl)};
    await withMemoryLock(${JSON.stringify(run)}, async () => {
      console.log('held');
      await new Promise(resolve => process.on('SIGUSR1', resolve));
    });
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  try {
    await once(child.stdout, 'data');
    child.kill('SIGSTOP');
    const inode = fs.statSync(path.join(run, 'memory.lock')).ino;
    const start = performance.now();
    let called = false;
    await assert.rejects(withMemoryLock(run, () => { called = true; }), { code: 'LOCK_TIMEOUT', exitCode: 2 });
    assert.ok(performance.now() - start >= 9900);
    assert.equal(called, false);
    assert.equal(fs.statSync(path.join(run, 'memory.lock')).ino, inode);
    child.kill('SIGCONT'); child.kill('SIGUSR1');
    await closed;
    await withMemoryLock(run, () => {});
    assert.equal(fs.statSync(path.join(run, 'memory.lock')).ino, inode);
  } finally { child.kill('SIGKILL'); await closed; }
});

test('kernel releases parent-held lock on SIGKILL', async () => {
  const run = tmp();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withMemoryLock } from ${JSON.stringify(moduleUrl)};
    await withMemoryLock(${JSON.stringify(run)}, async () => {
      console.log('held'); await new Promise(() => { setInterval(() => {}, 1000); });
    });
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  try {
    await once(child.stdout, 'data');
    await assert.rejects(withMemoryLock(run, () => {}, { waitMs: 50 }), { code: 'LOCK_TIMEOUT' });
    child.kill('SIGKILL'); await closed;
    await withMemoryLock(run, () => {});
  } finally { child.kill('SIGKILL'); await closed; }
});

test('unrelated children do not retain the memory lock descriptor', async () => {
  const run = tmp(); let child, closed;
  try {
    await withMemoryLock(run, async () => {
      child = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
      closed = once(child, 'close'); await once(child.stdout, 'data');
    });
    await withMemoryLock(run, () => {}, { waitMs: 100 });
    assert.equal(child.exitCode, null);
  } finally { child?.kill('SIGKILL'); if (closed) await closed; }
});
