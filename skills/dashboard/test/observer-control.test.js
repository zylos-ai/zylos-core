import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ObserverControlServer, runObserverPreUninstall } from '../src/lib/observer-control.js';

function fixture(t, observer = { enabled: true, generation: 4 }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-control-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({ observer }, null, 2)}\n`, { mode: 0o600 });
  const temporary = fs.realpathSync(os.tmpdir());
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME']) {
    assert.ok(process.env[key]?.startsWith(`${path.dirname(temporary)}${path.sep}`), `${key} must use the runner sandbox`);
  }
  assert.ok(dataDir.startsWith(`${temporary}${path.sep}`));
  console.log('Observer control isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: temporary, dataDir,
    tmuxSocket: path.join(dataDir, 'tmux.sock'), tmuxStarted: false,
    database: path.join(dataDir, 'observer/runtime/control/coordinator-lock.sqlite') }));
  return { dataDir, configPath };
}

test('component pre-uninstall joins the running producer coordinator', async (t) => {
  const { dataDir, configPath } = fixture(t);
  let calls = 0;
  const server = new ObserverControlServer({
    dataDir,
    onPreUninstall: async () => { calls += 1; },
  });
  await server.start();
  t.after(() => server.close());
  const result = await runObserverPreUninstall({ dataDir, configPath });
  assert.deepEqual(result, { mode: 'online' });
  assert.equal(calls, 1);
  assert.equal(fs.statSync(server.socketPath).mode & 0o777, 0o600);
  assert.equal(path.dirname(server.socketPath), path.join(fs.realpathSync(os.tmpdir()), `zobs-${process.getuid()}`));
  assert.equal(fs.statSync(path.dirname(server.socketPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(server.socketPath)).uid, process.getuid());
  await server.close();
  assert.equal(fs.existsSync(server.socketPath), false);
});

function useTemporaryDirectory(t, directory) {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
}

// Covers path selection, permissions and client/server agreement. Run for socket
// location changes; unrelated rendering changes may skip this case.
test('long temporary paths fall back to a private data control socket', async (t) => {
  const { dataDir, configPath } = fixture(t);
  const temporary = path.join(dataDir, 'long-'.repeat(25));
  fs.mkdirSync(temporary, { mode: 0o700 });
  useTemporaryDirectory(t, temporary);
  const server = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  t.after(() => server.close());
  assert.equal(server.socketPath, path.join(dataDir, 'observer/runtime/control/control.sock'));
  assert.ok(Buffer.byteLength(server.socketPath) < 104);
  await server.start();
  assert.equal(fs.statSync(path.dirname(server.socketPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(server.socketPath).mode & 0o777, 0o600);
  assert.deepEqual(await runObserverPreUninstall({ dataDir, configPath }), { mode: 'online' });
  await server.close();
  assert.equal(fs.existsSync(server.socketPath), false);
  assert.equal(fs.readdirSync(temporary).length, 0);
});

// Covers the final path-length rejection without side effects. Run for endpoint
// path changes; unrelated coordinator operations may skip this case.
test('overlong temporary and data paths require a shorter TMPDIR without creating sockets', (t) => {
  const { dataDir } = fixture(t);
  // Multibyte paths must be measured in bytes, not JavaScript characters.
  const long = path.join(dataDir, '\u754c'.repeat(40));
  fs.mkdirSync(long, { mode: 0o700 });
  useTemporaryDirectory(t, long);
  assert.throws(() => new ObserverControlServer({ dataDir: long, onPreUninstall: async () => {} }), {
    code: 'control_socket_path_too_long',
  });
  assert.equal(fs.readdirSync(long).length, 0);
});

// Covers unsafe existing parents and close after failed publication. Run for
// socket permission/cleanup changes; unrelated protocol changes may skip it.
test('shared and symlink socket directories are rejected without following or changing them', async (t) => {
  for (const kind of ['shared', 'symlink']) {
    await t.test(kind, async (t) => {
      const { dataDir } = fixture(t);
      useTemporaryDirectory(t, dataDir);
      const server = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
      const directory = path.dirname(server.socketPath);
      const outside = path.join(dataDir, 'outside');
      fs.mkdirSync(outside, { mode: 0o700 });
      const sentinel = path.join(outside, path.basename(server.socketPath));
      fs.writeFileSync(sentinel, 'preserve', { mode: 0o600 });
      if (kind === 'shared') {
        fs.mkdirSync(directory, { mode: 0o755 });
        fs.chmodSync(directory, 0o755);
      } else fs.symlinkSync(outside, directory);
      await assert.rejects(server.start(), { code: 'unsafe_runtime_state' });
      await server.close();
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
      if (kind === 'shared') assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
      else assert.equal(fs.lstatSync(directory).isSymbolicLink(), true);
    });
  }
});

// Covers endpoint relocation/upgrade and environment mismatch. Run when control
// discovery or coordinator ownership changes; unrelated UI changes may skip it.
test('an undiscovered producer mutex refuses offline teardown and a second coordinator', { timeout: 25000 }, async (t) => {
  const { dataDir, configPath } = fixture(t);
  const producer = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  await producer.acquire();
  t.after(() => producer.close());
  const before = fs.readFileSync(configPath, 'utf8');
  // The previous endpoint and a different TMPDIR are both absent at the new
  // address. Keep the unchanged SQLite protocol held, exactly as either does.
  await assert.rejects(runObserverPreUninstall({ dataDir, configPath }), { code: 'coordinator_active' });
  const contender = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  await assert.rejects(contender.start(), { code: 'coordinator_active' });
  await contender.close();
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  await producer.close();
  assert.deepEqual(await runObserverPreUninstall({ dataDir, configPath }), { mode: 'offline' });
});

// Covers the unchanged lock contract used by an older client/coordinator. Run
// with endpoint or mutex changes; skip for unrelated rendering changes.
test('a relocated producer excludes clients using the previous SQLite ownership protocol', async (t) => {
  const { dataDir } = fixture(t);
  const producer = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  await producer.start();
  t.after(() => producer.close());
  const database = new Database(path.join(dataDir, 'observer/runtime/control/coordinator-lock.sqlite'), { timeout: 0 });
  t.after(() => database.close());
  assert.throws(() => database.exec('BEGIN EXCLUSIVE'), { code: 'SQLITE_BUSY' });
  await producer.close();
  database.exec('BEGIN EXCLUSIVE');
  database.exec('ROLLBACK');
});

test('component pre-uninstall takes offline ownership only with no live producer', async (t) => {
  const { dataDir, configPath } = fixture(t);
  const result = await runObserverPreUninstall({ dataDir, configPath });
  assert.deepEqual(result, { mode: 'offline' });
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.observer.enabled, false);
  assert.equal(saved.observer.teardownFence, true);
  assert.equal(saved.observer.removalState, null);
  assert.equal(saved.observer.lastError, null);
});

test('legacy ownerless and corrupt locks are retained for explicit migration', async (t) => {
  for (const content of [null, '{broken']) {
    const { dataDir } = fixture(t);
    const lockPath = path.join(dataDir, 'observer', 'runtime', 'control', 'coordinator.lock');
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    if (content) fs.writeFileSync(path.join(lockPath, 'owner.json'), content);
    const server = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
    await assert.rejects(server.start(), { code: 'legacy_coordinator_lock' });
    assert.ok(fs.existsSync(lockPath));
  }
});

test('closing a failed contender preserves the owning producer control socket', async (t) => {
  const { dataDir, configPath } = fixture(t);
  let calls = 0;
  const owner = new ObserverControlServer({ dataDir, onPreUninstall: async () => { calls += 1; } });
  await owner.start();
  t.after(() => owner.close());
  const contender = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  await assert.rejects(contender.start(), { code: 'coordinator_active' });
  await contender.close();
  assert.equal(fs.existsSync(owner.socketPath), true);
  assert.deepEqual(await runObserverPreUninstall({ dataDir, configPath }), { mode: 'online' });
  assert.equal(calls, 1);
});

test('managed ancestor symlink is rejected before creating mutex outside data directory', async (t) => {
  const { dataDir } = fixture(t); const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(dataDir, 'observer'));
  const server = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  await assert.rejects(server.acquire(), { code: 'unsafe_runtime_state' });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('losing Dashboard shutdown and pre-uninstall cannot clean winner staging', async (t) => {
  const { ObserverService } = await import('../src/lib/observer-service.js');
  const { dataDir } = fixture(t);
  const owner = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  await owner.acquire(); t.after(() => owner.close());
  const staging = path.join(dataDir, 'observer', 'runtime', 'generations', `.staging-g-1-${'a'.repeat(32)}`);
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  const loser = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  t.after(() => loser.close());
  let mutations = 0;
  const service = new ObserverService({ ensureCoordinatorOwnership: () => loser.acquire(),
    containment: { reconcilePersisted: async () => { mutations++; } },
    coordinator: { reconcileStartup: async () => {}, uninstall: async () => { mutations++; } },
    manager: { shutdown: async () => { mutations++; } } });
  await service.startup();
  assert.equal(service.startupError.code, 'coordinator_active');
  await assert.rejects(service.shutdown(), { code: 'coordinator_active' });
  await assert.rejects(service.preUninstall(), { code: 'coordinator_active' });
  assert.equal(mutations, 0); assert.ok(fs.existsSync(staging));
});

test('SQLite ownership excludes another process and releases on its normal OS exit', async (t) => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { dataDir } = fixture(t);
  const moduleUrl = new URL('../src/lib/observer-control.js', import.meta.url).href;
  // Keep the owner reachable until shutdown; a completed eval module can be GC'd,
  // closing its native SQLite handle even while stdin keeps the child alive.
  const script = `import { ObserverControlServer } from ${JSON.stringify(moduleUrl)};\nconst owner = new ObserverControlServer({dataDir:process.argv[1],onPreUninstall:async()=>{}});\nawait owner.acquire();\nprocess.stdout.write('owned\\n');\nprocess.stdin.once('data',()=>{ if (!owner.lock) throw Error('owner lost lock'); process.exit(0); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, dataDir], {
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, killSignal: 'SIGKILL',
  });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) { child.stdin.end('exit'); await exited; } });
  const [ready] = await once(child.stdout, 'data');
  assert.equal(ready.toString(), 'owned\n');
  assert.equal(child.exitCode, null);
  const contender = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  await assert.rejects(contender.acquire(), { code: 'coordinator_active' });
  const lockPath = path.join(dataDir, 'observer/runtime/control/coordinator-lock.sqlite');
  const inode = fs.statSync(lockPath).ino;
  child.stdin.end('exit'); assert.deepEqual(await exited, [0, null]);
  await contender.acquire();
  assert.equal(fs.statSync(lockPath).ino, inode);
  await contender.close();
});

test('concurrent close releases ownership retained after socket publication failure', async (t) => {
  const { dataDir } = fixture(t);
  const server = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  const parent = path.join(dataDir, 'not-a-directory');
  fs.writeFileSync(parent, '', { mode: 0o600 });
  server.socketPath = path.join(parent, 'control.sock');
  const started = assert.rejects(server.start(), { code: 'EEXIST' });
  await server.close();
  await started;
  assert.equal(server.lock, null);
  const next = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  await next.acquire(); await next.close();
});

// Covers refusal before any Observer generation or wake side effect. Run when
// Origin target admission changes; unrelated containment changes may skip it.
test('sleeping Origin refuses an Observer lease without starting or waking a session', async () => {
  const { ObserverManager } = await import('../src/lib/observer-manager.js');
  const { ObserverService } = await import('../src/lib/observer-service.js');
  let starts = 0;
  const coordinator = {
    reconcileStartup: async () => ({ state: 'installed', desired: { enabled: true } }),
    firstLease: async () => { starts++; assert.fail('sleeping Origin must not start Observer containment'); },
  };
  const containment = { reconcilePersisted: async () => [], active: null };
  const context = { kind: 'api', principalId: 'owner', scope: 'admin' };
  const authGate = { enabled: true, resolveAuthContext: () => context, revalidateAuthContext: value => value };
  const manager = new ObserverManager({ coordinator, containment, authGate, runtime: 'codex',
    resolveOrigin: async () => { throw Object.assign(new Error('Origin sleeps'), { code: 'target_unavailable' }); } });
  const service = new ObserverService({ coordinator, containment, manager, authGate });
  let status, body;
  const res = { writeHead: value => { status = value; }, end: value => { body = JSON.parse(value); } };
  const handled = await service.handle({ method: 'POST', headers: {}, _authContext: context }, res, new URL('http://isolated.test/api/observer/leases'));
  assert.equal(handled, true); assert.equal(status, 409); assert.equal(body.error, 'agent_session_unavailable');
  assert.equal(starts, 0); assert.equal(manager.leases.size, 0); assert.equal(containment.active, null);
});
