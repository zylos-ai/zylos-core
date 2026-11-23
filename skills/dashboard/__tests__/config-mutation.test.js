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
