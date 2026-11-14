import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DispatcherRestartConfirmation } from '../dispatcher-restart-confirmation.js';
const execute = promisify(execFile);
async function settled(checker) {
  const end = Date.now() + 10000;
  while (checker.attempt?.state === 'restarting') {
    assert.ok(Date.now() < end, 'isolated PM2 restart must settle');
    await delay(20);
  }
}
async function decided(checker, input) {
  const end = Date.now() + 10000;
  for (;;) {
    const result = await checker.advance(input);
    if (!result.pending) return result;
    assert.ok(Date.now() < end, 'isolated PM2 confirmation must finish');
    await delay(20);
  }
}
// Covers the production PM2 CLI transport and exact generation confirmation.
// Run for restart/confirmation changes; skip only when the declared PM2 dev
// dependency is absent. Never fall back to a host-global executable. Official
// runner isolates HOME/ZYLOS_DIR/TMPDIR; this case owns a private PM2 daemon,
// uses no tmux or database, and kills that daemon before removing its fixture.
test('real private PM2 confirms exact online generation, rejects false success and cleans its daemon', { timeout: 45000 }, async t => {
  let pm2Entry;
  try { pm2Entry = import.meta.resolve('pm2/bin/pm2'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('requires the declared pm2 development dependency; provision repository dev dependencies to run the private-daemon integration');
    return;
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-pm2-')));
  const home = path.join(root, 'pm2'); fs.mkdirSync(home);
  // Resolve the declared test dependency, never a host-global PM2 executable.
  // Both the production transport and fixture commands use this private entry.
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const entry = path.join(bin, 'pm2.mjs');
  fs.writeFileSync(entry, `#!${process.execPath}\nimport ${JSON.stringify(pm2Entry)};\n`, { mode: 0o700 });
  fs.symlinkSync(entry, path.join(bin, 'pm2'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const previousPath = process.env.PATH;
  const previousHome = process.env.PM2_HOME;
  process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`;
  process.env.PM2_HOME = home;
  const env = { ...process.env, PM2_HOME: home, PM2_SILENT: 'true' };
  const command = async args => (await execute('pm2', args, { env, timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  let daemonStarted = false;
  t.after(async () => {
    try {
      if (daemonStarted) {
        await command(['kill']);
        assert.equal(fs.existsSync(path.join(home, 'pm2.pid')), false, 'owned daemon pid file must be removed');
        assert.equal(fs.existsSync(path.join(home, 'rpc.sock')), false, 'owned daemon RPC socket must be removed');
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousHome === undefined) delete process.env.PM2_HOME;
      else process.env.PM2_HOME = previousHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const script = path.join(root, 'idle.mjs');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  assert.ok(home.startsWith(root + path.sep));
  assert.notEqual(env.HOME, os.userInfo().homedir);
  assert.ok(env.ZYLOS_DIR.startsWith(env.HOME + path.sep));
  assert.ok(Buffer.byteLength(path.join(home, 'rpc.sock')) < 100);
  t.diagnostic(JSON.stringify({ pm2Entry, script, HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR,
    PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, tmux: 'unused', database: 'unused' }));
  // Set before the first command so cleanup also handles partial PM2 startup.
  daemonStarted = true;
  await command(['start', script, '--name', 'c4-dispatcher', '--no-autorestart']);
  await command(['start', script, '--name', 'unrelated-fixture', '--no-autorestart']);
  const rows = async () => JSON.parse(await command(['jlist']));
  const before = await rows();
  const original = before.find(row => row.name === 'c4-dispatcher');
  const unrelatedPid = before.find(row => row.name === 'unrelated-fixture').pid;
  assert.equal(original.pm2_env.status, 'online');
  const input = { runId: 'transition-real', writtenAt: Date.now() };
  const checker = new DispatcherRestartConfirmation();
  assert.deepEqual(await decided(checker, input), { confirmed: true, pending: false });
  const after = await rows();
  const restarted = after.find(row => row.name === 'c4-dispatcher');
  assert.equal(restarted.pm2_env.status, 'online');
  assert.ok(restarted.pm2_env.pm_uptime > input.writtenAt);
  assert.notEqual(restarted.pid, original.pid);
  assert.equal(after.find(row => row.name === 'unrelated-fixture').pid, unrelatedPid);

  // Genuine successful PM2 commands deliberately do not establish the target
  // postcondition: unrelated restart, stopped dispatcher, or a mismatched process name.
  const events = [];
  for (const scenario of ['old-uptime', 'stopped', 'wrong-name']) {
    let clock = Date.now();
    const options = { now: () => clock, timeoutMs: 2000, diagnostic: event => events.push(event),
      processName: scenario === 'wrong-name' ? 'missing-fixture' : 'c4-dispatcher',
      restart: () => command(scenario === 'stopped' ? ['stop', 'c4-dispatcher'] : ['restart', 'unrelated-fixture']) };
    const candidate = new DispatcherRestartConfirmation(options);
    const pending = { runId: scenario, writtenAt: scenario === 'old-uptime' ? Date.now() : 0 };
    assert.equal((await candidate.advance(pending)).pending, true); await settled(candidate);
    assert.deepEqual(await candidate.advance(pending), { confirmed: false, pending: true }, scenario);
    clock += 2000;
    assert.deepEqual(await candidate.advance(pending), { confirmed: false, pending: false, reason: 'dispatcher_restart_unconfirmed' });
  }

  // Real PM2 error and a real child timeout remain unconfirmed, even if a
  // delayed restart request could have reached this private daemon.
  for (const options of [{ processName: 'missing-fixture' }, { timeoutMs: 1 }]) {
    const candidate = new DispatcherRestartConfirmation({ ...options, diagnostic: event => events.push(event) });
    const pending = { runId: options.timeoutMs ? 'timeout' : 'error', writtenAt: 0 };
    await candidate.advance(pending); await settled(candidate);
    assert.deepEqual(await candidate.advance(pending), { confirmed: false, pending: false, reason: 'dispatcher_restart_unconfirmed' });
  }
  assert.equal(events.length, 5);

});
