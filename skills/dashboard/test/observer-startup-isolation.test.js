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

// Cross-process startup/control boundary. Run for socket discovery, ownership or
// Dashboard startup changes; unrelated rendering changes may skip these cases.
// Private paths and SQLite, stub PM2/tmux, owned loopback only; child cleanup is
// registered before startup and request/output/child lifetimes are bounded.
// Invalid persisted socket metadata exercises the containment startup failure
// boundary; run for containment path/validation changes, skip for unrelated UI.
for (const failure of [null, 'missing', 'long', 'state']) test(failure === 'state' ? 'Dashboard listens when persisted Observer socket metadata is invalid' : failure ? `Dashboard listens when Observer socket path selection fails with ${failure} temporary storage`
  : 'Dashboard listens while unavailable Observer ownership blocks admission', { timeout: 35_000 }, async (t) => {
  const runnerHome = fs.realpathSync(process.env.HOME);
  assert.notEqual(runnerHome, fs.realpathSync(os.userInfo().homedir));
  for (const key of ['ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key]?.startsWith(path.dirname(runnerHome) + path.sep), `${key} uses runner isolation`);
  }
  // Choose fixture paths independently of the caller's TMPDIR length.
  const temporaryRoot = fs.realpathSync(fs.existsSync('/dev/shm') ? '/dev/shm' : '/tmp');
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'zds-'));
  fs.chmodSync(root, 0o700);
  const controlFailure = failure === 'missing' || failure === 'long';
  const zylosDir = path.join(root, controlFailure ? 'data-'.repeat(25) : 'z');
  const dataDir = path.join(zylosDir, 'components', 'dashboard');
  const controlRoot = path.join(dataDir, 'observer', 'runtime', 'control');
  const candidate = path.join(controlRoot, 'control.sock');
  let child, owner;
  t.after(async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
        try { await exited; } finally { clearTimeout(timer); }
      }
    } finally {
      try { await owner?.close(); }
      finally {
        fs.rmSync(root, { recursive: true, force: true });
        assert.equal(fs.existsSync(root), false, 'fixture process and private state were cleaned');
      }
    }
  });
  assert.equal(Buffer.byteLength(candidate) >= 104, controlFailure, 'data candidate takes the intended branch');
  fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
  let lockPath, lockInode;
  if (failure === null) {
    owner = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
    await owner.acquire();
    lockPath = owner.lock.lockPath;
    lockInode = fs.statSync(lockPath).ino;
  }
  const reservation = net.createServer();
  t.after(() => { if (reservation.listening) reservation.close(); });
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port, host: '127.0.0.1', auth: { enabled: true, password: hashPassword('startup-test') },
    observer: { enabled: true, generation: 1 },
  }), { mode: 0o600 });
  if (failure === 'state') {
    const nonce = '0123456789abcdef0123456789abcdef';
    const generationRoot = path.join(dataDir, 'observer', 'runtime', 'generations', `g-1-${nonce}`);
    fs.mkdirSync(generationRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(generationRoot, 'state.json'), JSON.stringify({
      schema: 2, startupRecovery: 1, generation: 1, nonce, root: generationRoot,
      socketRoot: path.join(root, 'unapproved-socket'),
    }), { mode: 0o600 });
  }
  const bin = path.join(root, 'test-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pm2'), "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const home = path.join(root, 'home'), pm2Home = path.join(root, 'pm2'), tmuxRoot = path.join(root, 'tmux');
  const temporary = path.join(root, failure === 'missing' ? 'missing/tmp' : failure === 'long' ? 'temporary-'.repeat(20) : 'temporary');
  for (const directory of [home, pm2Home, tmuxRoot]) fs.mkdirSync(directory, { mode: 0o700 });
  if (failure !== 'missing') fs.mkdirSync(temporary, { mode: 0o700 });
  assert.ok(Buffer.byteLength(temporary) >= 20);
  if (failure === 'long') assert.ok(Buffer.byteLength(temporary) >= 104);
  if (failure === 'missing') assert.equal(fs.existsSync(temporary), false);
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylosDir, PM2_HOME: pm2Home,
    TMPDIR: temporary, TMUX_TMPDIR: tmuxRoot, PATH: `${bin}:${process.env.PATH}`, TMUX: '', ZELLIJ: '' };
  const keys = ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR'];
  for (const key of keys.filter(key => key !== 'TMPDIR')) {
    assert.equal(fs.realpathSync(env[key]), env[key]);
    assert.ok(env[key].startsWith(root + path.sep));
  }
  const database = path.join(dataDir, 'dashboard.db');
  console.log('Dashboard startup preflight:', JSON.stringify({ ...Object.fromEntries(keys.map(key => [key, env[key]])),
    database, coordinatorDatabase: path.join(controlRoot, 'coordinator-lock.sqlite'),
    controlCandidate: candidate, listener: `http://127.0.0.1:${port}`,
    pm2Command: path.join(bin, 'pm2'), tmuxCommand: path.join(bin, 'tmux'), tmux: 'stubbed; no server' }));
  const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const script = `console.log(JSON.stringify({testEnvironment:Object.fromEntries(${JSON.stringify(keys)}.map(key=>[key,process.env[key]]))}));process.argv=[process.execPath,${JSON.stringify(entry)}];await import(${JSON.stringify(new URL('../src/index.js', import.meta.url).href)});`;
  child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL',
  });
  let logs = '', overflow = false;
  const capture = chunk => {
    if (Buffer.byteLength(logs) + chunk.length > 64 * 1024) {
      overflow = true; child.kill('SIGKILL'); return;
    }
    logs += chunk;
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const base = `http://127.0.0.1:${port}`;
  const request = (url, options = {}) => fetch(base + url, { ...options, signal: AbortSignal.timeout(3_000) });
  let healthy = false;
  const deadline = Date.now() + 18_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null && !overflow) {
    try {
      const response = await request('/api/health');
      healthy = response.ok && (await response.json()).ok;
      if (healthy) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(overflow, false, 'Dashboard output remains bounded');
  assert.ok(healthy, logs);
  const readback = JSON.parse(logs.split('\n').find(line => line.startsWith('{"testEnvironment":'))).testEnvironment;
  for (const key of keys) assert.equal(readback[key], env[key], key);
  assert.ok(fs.statSync(database).isFile(), 'the child opened the fixture Dashboard database');
  console.log('Dashboard startup isolation:', JSON.stringify({ ...readback, listener: base,
    database, tmux: 'stubbed; no server' }));
  const errorCode = failure === 'missing' ? 'ENOENT' : failure === 'long' ? 'control_socket_path_too_long'
    : failure === 'state' ? 'unsafe_runtime_state' : 'coordinator_active';
  assert.match(logs, new RegExp(`${controlFailure ? 'control startup' : 'startup'} failed: ${errorCode}`));
  const login = await request('/login', {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=startup-test',
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'authenticated dashboard session');
  const headers = { Cookie: cookie, Origin: base };
  const status = await request('/api/observer/status', { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).startupError, errorCode);
  for (const endpoint of ['enable', 'leases', 'disable']) {
    const response = await request(`/api/observer/${endpoint}`, { method: 'POST', headers });
    assert.equal(response.status, 503, endpoint);
    const expectedError = failure === 'state' && endpoint === 'disable' ? 'teardown_failed' : errorCode;
    assert.equal((await response.json()).error, expectedError, endpoint);
  }
  if (failure) {
    assert.equal(fs.existsSync(candidate), failure === 'state');
    if (failure === 'missing') assert.equal(fs.existsSync(temporary), false);
    else assert.equal(fs.readdirSync(temporary).length, 0);
    return;
  }
  assert.equal(fs.statSync(lockPath).ino, lockInode);
  await owner.close();
  const recovered = await request('/api/observer/disable', { method: 'POST', headers });
  assert.equal(recovered.status, 200, await recovered.text());
  assert.ok(fs.existsSync(candidate), 'recovered producer selects the data-directory candidate');
  assert.deepEqual(await runObserverPreUninstall({ dataDir, configPath: path.join(dataDir, 'config.json') }), { mode: 'online' });
});
