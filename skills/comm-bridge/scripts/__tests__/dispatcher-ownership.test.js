import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Database from '../sqlite-driver.js';
import { acquireDispatcherOwnership } from '../dispatcher-ownership.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-owner-'));
  const resources = [];
  const controllers = [], pending = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(pending);
    for (const release of resources.reverse()) release();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, resources, acquire(options = {}) {
    const controller = new AbortController(); controllers.push(controller);
    const task = acquireDispatcherOwnership({ directory, env: {}, pollMs: 5, ...options,
      signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
    }).then(owner => {
      if (owner) resources.push(owner.release);
      return owner;
    });
    pending.push(task); return task;
  } };
}

test('one directory and its alias share ownership until the incumbent releases', { timeout: 5000 }, async t => {
  const f = fixture(t), owner = await f.acquire();
  const alias = path.join(f.directory, 'alias');
  fs.symlinkSync(f.directory, alias, 'dir');
  let admitted = false;
  const contender = f.acquire({ directory: alias }).then(value => { admitted = true; return value; });
  await delay(40);
  assert.equal(admitted, false);
  const probe = new Database(path.join(f.directory, 'dispatcher-lock.db'), { timeout: 0 });
  try { assert.throws(() => probe.exec('BEGIN EXCLUSIVE'), { code: 'SQLITE_BUSY' }); }
  finally { probe.close(); }
  owner.release();
  assert.ok(await contender);
  assert.equal(admitted, true);
});

test('an aborted contender releases its connection without displacing the owner', { timeout: 5000 }, async t => {
  const f = fixture(t), owner = await f.acquire(), controller = new AbortController();
  const contender = f.acquire({ signal: controller.signal });
  await delay(20); controller.abort();
  assert.equal(await contender, null);
  const probe = new Database(path.join(f.directory, 'dispatcher-lock.db'), { timeout: 0 });
  try { assert.throws(() => probe.exec('BEGIN EXCLUSIVE'), { code: 'SQLITE_BUSY' }); }
  finally { probe.close(); }
  owner.release(); assert.ok(await f.acquire());
});

test('PM2 selection excludes an untracked child before it acquires ownership', async t => {
  const f = fixture(t), pidFile = path.join(f.directory, 'pm2.pid');
  fs.writeFileSync(pidFile, String(process.pid + 1));
  assert.equal(await f.acquire({ env: { pm_id: '0', pm_pid_path: pidFile } }), null);
  assert.ok(await f.acquire());
});

test('an unreadable PM2 selection waits and can be cancelled without admission', { timeout: 5000 }, async t => {
  const f = fixture(t), controller = new AbortController();
  const pending = f.acquire({ env: { pm_id: '0', pm_pid_path: path.join(f.directory, 'missing') },
    readManagedPid: async () => undefined, signal: controller.signal });
  await delay(20); controller.abort();
  assert.equal(await pending, null);
});

test('a missing PM2 PID file admits only the daemon-selected process', async t => {
  const f = fixture(t), env = { pm_id: '0', pm_pid_path: path.join(f.directory, 'missing') };
  assert.equal(await f.acquire({ env, readManagedPid: async () => process.pid + 1 }), null);
  assert.ok(await f.acquire({ env, readManagedPid: async () => process.pid }));
});

test('PM2 replacement requests drain once and retains exclusivity until release', { timeout: 5000 }, async t => {
  const f = fixture(t), pidFile = path.join(f.directory, 'pm2.pid');
  fs.writeFileSync(pidFile, String(process.pid));
  let drains = 0;
  const owner = await f.acquire({ env: { pm_id: '0', pm_pid_path: pidFile }, onSuperseded: () => { drains++; } });
  fs.writeFileSync(pidFile, String(process.pid + 1));
  await delay(40);
  assert.equal(drains, 1);
  let admitted = false;
  const pending = f.acquire().then(value => { admitted = true; return value; });
  await delay(20); assert.equal(admitted, false);
  owner.release(); assert.ok(await pending);
  await delay(20); assert.equal(drains, 1);
});
