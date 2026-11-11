import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { mutateConfig } from '../src/lib/config-mutation.js';

const execFileAsync = promisify(execFile);

async function waitForPath(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function fixture(value = { untouched: { value: 1 } }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-config-mutation-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return { directory, configPath };
}

test('config mutations serialize overlapping producers without losing unrelated fields', async (t) => {
  const { directory, configPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let releaseFirst;
  const firstCanFinish = new Promise((resolve) => { releaseFirst = resolve; });
  let firstEntered;
  const firstDidEnter = new Promise((resolve) => { firstEntered = resolve; });

  const settings = mutateConfig(configPath, async (config) => {
    firstEntered();
    await firstCanFinish;
    config.settings = { saved: true };
  });
  await firstDidEnter;
  const observer = mutateConfig(configPath, (config) => {
    config.observer = { enabled: false };
  });
  releaseFirst();
  await Promise.all([settings, observer]);

  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(saved, {
    untouched: { value: 1 },
    settings: { saved: true },
    observer: { enabled: false },
  });
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('invalid existing JSON fails closed without replacement', async (t) => {
  const { directory, configPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(configPath, '{ invalid\n');
  await assert.rejects(
    mutateConfig(configPath, (config) => { config.observer = { enabled: true }; }),
    (error) => error?.code === 'invalid_config',
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{ invalid\n');
});

test('config lock serializes separate producer processes', async (t) => {
  const { directory, configPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/lib/config-mutation.js', import.meta.url).href;
  const script = `
    const [{ mutateConfig }, moduleUrl, configPath, field, wait] = [
      await import(process.argv[1]), process.argv[1], process.argv[2], process.argv[3], Number(process.argv[4])
    ];
    await mutateConfig(configPath, async (config) => {
      await new Promise((resolve) => setTimeout(resolve, wait));
      config[field] = { pid: process.pid };
    });
  `;
  await Promise.all([
    execFileAsync(process.execPath, ['--input-type=module', '--eval', script, moduleUrl, configPath, 'settings', '80']),
    execFileAsync(process.execPath, ['--input-type=module', '--eval', script, moduleUrl, configPath, 'configure', '0']),
  ]);
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(typeof saved.settings.pid, 'number');
  assert.equal(typeof saved.configure.pid, 'number');
  assert.deepEqual(saved.untouched, { value: 1 });
});

test('config lock is private and a killed holder releases it for the next writer', async (t) => {
  const { directory, configPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/lib/config-mutation.js', import.meta.url).href;
  const enteredPath = path.join(directory, 'entered');
  const script = `
    import fs from 'node:fs';
    const [moduleUrl, configPath, enteredPath] = process.argv.slice(1);
    const { mutateConfig } = await import(moduleUrl);
    await mutateConfig(configPath, async () => {
      fs.writeFileSync(enteredPath, 'entered');
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
    });
  `;
  const holder = spawn(process.execPath, [
    '--input-type=module', '--eval', script, moduleUrl, configPath, enteredPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL'); });
  await waitForPath(enteredPath);
  const lockPath = `${configPath}.lock.sqlite`;
  const lockStat = fs.lstatSync(lockPath);
  assert.equal(lockStat.isFile(), true);
  assert.equal(lockStat.isSymbolicLink(), false);
  assert.equal(lockStat.mode & 0o777, 0o600);

  if (holder.exitCode === null && holder.signalCode === null) {
    holder.kill('SIGKILL');
    await once(holder, 'exit');
  }
  await mutateConfig(configPath, (config) => { config.afterCrash = true; }, {
    lockTimeoutMs: 500, retryMs: 5,
  });
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).afterCrash, true);
});

test('config lock database rejects a symlink instead of changing its target', async (t) => {
  const { directory, configPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'outside');
  fs.writeFileSync(target, 'keep', { mode: 0o644 });
  fs.symlinkSync(target, `${configPath}.lock.sqlite`);
  await assert.rejects(
    mutateConfig(configPath, () => {}),
    (error) => error?.code === 'lock_failed',
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  assert.equal(fs.statSync(target).mode & 0o777, 0o644);
});

test('dead stale lock is recovered but a live lock times out', async (t) => {
  const { directory, configPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = `${configPath}.lock`;
  fs.mkdirSync(lockPath, { mode: 0o700 });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 999_999_999, nonce: 'dead' }));
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, stale, stale);
  await mutateConfig(configPath, (config) => { config.recovered = true; }, { staleLockMs: 5, lockTimeoutMs: 200 });
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).recovered, true);

  fs.mkdirSync(lockPath, { mode: 0o700 });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: 'live' }));
  fs.utimesSync(lockPath, stale, stale);
  await assert.rejects(
    mutateConfig(configPath, () => {}, { staleLockMs: 5, lockTimeoutMs: 30, retryMs: 5 }),
    (error) => error?.code === 'lock_timeout',
  );
});

test('stale ownerless config lock is recovered but a fresh initializer is preserved', async (t) => {
  const { directory, configPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = `${configPath}.lock`;
  fs.mkdirSync(lockPath, { mode: 0o700 });
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, stale, stale);
  await mutateConfig(configPath, (config) => { config.recoveredOwnerless = true; }, {
    staleLockMs: 5, lockTimeoutMs: 200,
  });
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).recoveredOwnerless, true);

  fs.mkdirSync(lockPath, { mode: 0o700 });
  await assert.rejects(
    mutateConfig(configPath, () => {}, { staleLockMs: 100, lockTimeoutMs: 30, retryMs: 5 }),
    (error) => error?.code === 'lock_timeout',
  );
  assert.equal(fs.existsSync(lockPath), true);
});

test('three stale-lock contenders cannot displace a live successor or lose a field', async (t) => {
  const { directory, configPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = `${configPath}.lock`;
  fs.mkdirSync(lockPath, { mode: 0o700 });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 999_999_999, nonce: 'dead' }));
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, stale, stale);
  const moduleUrl = new URL('../src/lib/config-mutation.js', import.meta.url).href;
  const pausedPath = path.join(directory, 'first-paused');
  const allowPath = path.join(directory, 'allow-first');
  const secondEnteredPath = path.join(directory, 'second-entered');
  const criticalPath = path.join(directory, 'critical');
  const overlapPath = path.join(directory, 'overlap');
  const script = `
    import fs from 'node:fs';
    const [moduleUrl, configPath, role, pausedPath, allowPath, secondEnteredPath, criticalPath, overlapPath] = process.argv.slice(1);
    const originalRename = fs.promises.rename.bind(fs.promises);
    let paused = false;
    if (role === 'first') fs.promises.rename = async (source, destination) => {
      if (!paused && source === configPath + '.lock' && destination.startsWith(source + '.stale-')) {
        paused = true;
        fs.writeFileSync(pausedPath, 'ready');
        while (!fs.existsSync(allowPath)) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return originalRename(source, destination);
    };
    const { mutateConfig } = await import(moduleUrl);
    await mutateConfig(configPath, async (config) => {
      if (role === 'second') fs.writeFileSync(secondEnteredPath, 'entered');
      try { fs.mkdirSync(criticalPath); } catch (error) {
        if (error.code === 'EEXIST') fs.writeFileSync(overlapPath, 'overlap');
        else throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      config[role] = true;
      try { fs.rmdirSync(criticalPath); } catch {}
    }, { staleLockMs: 5, lockTimeoutMs: 2_000, retryMs: 5 });
  `;
  const args = [moduleUrl, configPath, 'first', pausedPath, allowPath, secondEnteredPath, criticalPath, overlapPath];
  const first = execFileAsync(process.execPath, ['--input-type=module', '--eval', script, ...args]);
  await waitForPath(pausedPath);
  args[2] = 'second';
  const second = execFileAsync(process.execPath, ['--input-type=module', '--eval', script, ...args]);
  args[2] = 'third';
  const third = execFileAsync(process.execPath, ['--input-type=module', '--eval', script, ...args]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(secondEnteredPath), false, 'a successor entered while stale recovery was paused');
  fs.writeFileSync(allowPath, 'go');
  await Promise.all([first, second, third]);
  assert.equal(fs.existsSync(overlapPath), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    untouched: { value: 1 }, first: true, second: true, third: true,
  });
});
