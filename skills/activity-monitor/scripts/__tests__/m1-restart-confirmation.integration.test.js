import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { M1RestartConfirmation } from '../m1-restart-confirmation.js';
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
// IF-41 / IB-47: exercise the production PM2 CLI transport against a private
// daemon. A successful CLI exit alone must not confirm M1's generation.
test('IF-41 real private PM2 confirms exact online generation, rejects false success and cleans its daemon', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p05-m1-pm2-'));
  const home = path.join(root, 'pm2'); fs.mkdirSync(home);
  const previousHome = process.env.PM2_HOME;
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
      if (previousHome === undefined) delete process.env.PM2_HOME;
      else process.env.PM2_HOME = previousHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const script = path.join(root, 'idle.mjs');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
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
  const checker = new M1RestartConfirmation();
  assert.deepEqual(await decided(checker, input), { confirmed: true, pending: false });
  const after = await rows();
  const restarted = after.find(row => row.name === 'c4-dispatcher');
  assert.equal(restarted.pm2_env.status, 'online');
  assert.ok(restarted.pm2_env.pm_uptime > input.writtenAt);
  assert.notEqual(restarted.pid, original.pid);
  assert.equal(after.find(row => row.name === 'unrelated-fixture').pid, unrelatedPid);

  // Genuine successful PM2 commands deliberately do not establish the target
  // postcondition: unrelated restart, stopped M1, or a mismatched process name.
  const events = [];
  for (const scenario of ['old-uptime', 'stopped', 'wrong-name']) {
    let clock = Date.now();
    const options = { now: () => clock, timeoutMs: 2000, diagnostic: event => events.push(event),
      processName: scenario === 'wrong-name' ? 'missing-fixture' : 'c4-dispatcher',
      restart: () => command(scenario === 'stopped' ? ['stop', 'c4-dispatcher'] : ['restart', 'unrelated-fixture']) };
    const candidate = new M1RestartConfirmation(options);
    const pending = { runId: scenario, writtenAt: scenario === 'old-uptime' ? Date.now() : 0 };
    assert.equal((await candidate.advance(pending)).pending, true); await settled(candidate);
    assert.deepEqual(await candidate.advance(pending), { confirmed: false, pending: true }, scenario);
    clock += 2000;
    assert.deepEqual(await candidate.advance(pending), { confirmed: false, pending: false, reason: 'm1_restart_unconfirmed' });
  }

  // Real PM2 error and a real child timeout remain unconfirmed, even if a
  // delayed restart request could have reached this private daemon.
  for (const options of [{ processName: 'missing-fixture' }, { timeoutMs: 1 }]) {
    const candidate = new M1RestartConfirmation({ ...options, diagnostic: event => events.push(event) });
    const pending = { runId: options.timeoutMs ? 'timeout' : 'error', writtenAt: 0 };
    await candidate.advance(pending); await settled(candidate);
    assert.deepEqual(await candidate.advance(pending), { confirmed: false, pending: false, reason: 'm1_restart_unconfirmed' });
  }
  assert.equal(events.length, 5);

  // Known-bad variant: treating successful `pm2 restart` exit as confirmation.
  // The exact stale-generation assertion above must reject this implementation.
  class ExitCodeOnly extends M1RestartConfirmation {
    async advance() { await this.restart({ name: this.processName, timeoutMs: this.timeoutMs }); return { confirmed: true, pending: false }; }
  }
  const bad = new ExitCodeOnly({ restart: () => command(['restart', 'unrelated-fixture']) });
  await assert.rejects(async () => {
    assert.equal((await bad.advance({ runId: 'bad', writtenAt: Date.now() })).confirmed, false);
  }, { code: 'ERR_ASSERTION' });
});
