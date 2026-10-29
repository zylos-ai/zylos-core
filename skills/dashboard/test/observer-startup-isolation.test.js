import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ObserverControlServer, runObserverPreUninstall } from '../src/lib/observer-control.js';
import { hashPassword } from '../src/lib/auth.js';

test('Dashboard listens while unavailable Observer ownership blocks admission', { timeout: 25_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-startup-'));
  const dataDir = path.join(root, 'components', 'dashboard');
  const controlRoot = path.join(dataDir, 'observer', 'runtime', 'control');
  fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
  const owner = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  await owner.acquire();
  const lockPath = owner.lock.lockPath;
  const lockInode = fs.statSync(lockPath).ino;
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port, host: '127.0.0.1', auth: { enabled: true, password: hashPassword('startup-test') },
    observer: { enabled: true, generation: 1 },
  }));
  const bin = path.join(root, 'test-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pm2'), "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o700 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url))], {
    env: { ...process.env, HOME: root, ZYLOS_DIR: root, PATH: `${bin}:${process.env.PATH}`, TMUX: '', ZELLIJ: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      await exited;
      clearTimeout(timer);
    }
    await owner.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  const deadline = Date.now() + 18_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`${base}/api/health`);
      healthy = response.ok && (await response.json()).ok;
      if (healthy) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(healthy, logs);
  assert.match(logs, /startup failed: coordinator_active/);
  const login = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=startup-test',
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'authenticated dashboard session');
  const headers = { Cookie: cookie, Origin: base };
  const status = await fetch(`${base}/api/observer/status`, { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).startupError, 'coordinator_active');
  for (const endpoint of ['enable', 'leases', 'disable']) {
    const response = await fetch(`${base}/api/observer/${endpoint}`, { method: 'POST', headers });
    assert.equal(response.status, 503, endpoint);
    assert.equal((await response.json()).error, 'coordinator_active', endpoint);
  }
  assert.equal(fs.statSync(lockPath).ino, lockInode);
  await owner.close();
  const recovered = await fetch(`${base}/api/observer/disable`, { method: 'POST', headers });
  assert.equal(recovered.status, 200, await recovered.text());
  assert.deepEqual(await runObserverPreUninstall({ dataDir, configPath: path.join(dataDir, 'config.json') }), { mode: 'online' });
});
