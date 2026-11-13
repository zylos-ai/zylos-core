import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Run for the private process record/main-startup boundary. Default discovery
// skips this real-process integration. Use the official isolated Node runner
// with ZYLOS_HEALTH_STARTUP_INTEGRATION=1; no installed/live service is used.
test('real Dashboard startup binds its private process record to public health', {
  skip: process.env.ZYLOS_HEALTH_STARTUP_INTEGRATION !== '1', timeout: 25_000,
}, async t => {
  const runnerHome = fs.realpathSync(process.env.HOME);
  assert.notEqual(runnerHome, fs.realpathSync(os.userInfo().homedir));
  for (const key of ['ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key]?.startsWith(path.dirname(runnerHome) + path.sep), `${key} uses runner isolation`);
  }
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/zdh-'));
  fs.chmodSync(root, 0o700);
  let child;
  let logs = '', overflow = false;
  t.after(async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
        try { await exited; } finally { clearTimeout(killTimer); }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false, 'child and private files cleaned');
    }
  });
  const home = path.join(root, 'home'), zylos = path.join(home, 'zylos');
  const dataDir = path.join(zylos, 'components/dashboard');
  const pm2 = path.join(root, 'pm2'), tmp = path.join(root, 'tmp'), bin = path.join(root, 'bin');
  for (const directory of [dataDir, pm2, tmp, bin]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const command of ['pm2', 'tmux', 'zellij', 'zylos', 'claude', 'codex']) {
    fs.writeFileSync(path.join(bin, command), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  }
  const reservation = net.createServer();
  t.after(() => { if (reservation.listening) reservation.close(); });
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port, host: '127.0.0.1', auth: { enabled: false }, observer: { enabled: false },
  }), { mode: 0o600 });
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: pm2,
    TMPDIR: tmp, TMUX_TMPDIR: tmp, TMUX: `${tmp}/private.sock,0,0`, ZELLIJ: '',
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` };
  for (const key of ['ZYLOS_SESSION_GROUP', 'ZYLOS_RUN_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID', 'pm_exec_path']) delete env[key];
  const recordPath = path.join(dataDir, 'health-process.json');
  const database = path.join(dataDir, 'dashboard.db');
  const socketPath = path.join(dataDir, 'observer/runtime/control/control.sock');
  assert.ok(Buffer.byteLength(socketPath) < 104);
  assert.ok(tmp.length < 60);
  const origin = `http://127.0.0.1:${port}`;
  console.log('Health startup isolation:', JSON.stringify({ HOME: home, ZYLOS_DIR: zylos,
    PM2_HOME: pm2, TMPDIR: tmp, TMUX: env.TMUX, database, recordPath, socketPath,
    listener: origin, commands: bin, externalNetwork: 'HTTPS transport fails offline' }));
  assert.equal(fs.existsSync(recordPath), false, 'no preseeded process record');
  child = spawn(process.execPath, [
    '--import', fileURLToPath(new URL('./helpers/health-startup-offline.js', import.meta.url)),
    fileURLToPath(new URL('../src/index.js', import.meta.url)),
  ], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, killSignal: 'SIGKILL' });
  const capture = chunk => {
    if (Buffer.byteLength(logs) + chunk.length > 64 * 1024) {
      overflow = true; child.kill('SIGKILL'); return;
    }
    logs += chunk;
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  let health;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null && !overflow) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { health = await response.json(); break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(overflow, false, 'child logs bounded');
  assert.ok(health?.ok, logs);
  assert.deepEqual(Object.keys(health).sort(), ['bootId', 'ok', 'service']);
  assert.equal(health.service, 'zylos-dashboard');
  assert.match(health.bootId, /^[a-f0-9-]{36}$/);
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  assert.deepEqual(record, { pid: child.pid, bootId: health.bootId });
  assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600);
  assert.ok(fs.statSync(database).isFile(), 'real child opens its private SQLite database');
});
