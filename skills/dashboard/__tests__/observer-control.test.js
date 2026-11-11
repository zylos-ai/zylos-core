import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { ObserverControlServer, runObserverPreUninstall } from '../src/lib/observer-control.js';

function fixture(t, observer = { enabled: true, generation: 4 }) {
  const runnerTemporary = fs.realpathSync(os.tmpdir());
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME']) {
    assert.ok(process.env[key]?.startsWith(`${path.dirname(runnerTemporary)}${path.sep}`), `${key} must use the runner sandbox`);
  }
  const shortBase = fs.realpathSync(process.platform === 'linux' ? '/dev/shm' : '/tmp');
  const root = fs.mkdtempSync(path.join(shortBase, 'oc-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({ observer }, null, 2)}\n`, { mode: 0o600 });
  assert.ok(Buffer.byteLength(path.join(dataDir, 'observer/runtime/control/control.sock')) < 104);
  return { root, dataDir, configPath };
}

test('component pre-uninstall joins the running producer coordinator', async (t) => {
  const { dataDir, configPath } = fixture(t);
  let calls = 0;
  const server = new ObserverControlServer({
    dataDir,
    onPreUninstall: async () => { calls += 1; },
  });
  t.after(() => server.close());
  await server.start();
  const result = await runObserverPreUninstall({ dataDir, configPath });
  assert.deepEqual(result, { mode: 'online' });
  assert.equal(calls, 1);
  assert.equal(fs.statSync(server.socketPath).mode & 0o777, 0o600);
  assert.equal(server.socketPath, path.join(dataDir, 'observer/runtime/control/control.sock'));
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
test('data control sockets do not depend on the temporary directory', async (t) => {
  const { dataDir, configPath } = fixture(t);
  const temporary = path.join(dataDir, 'long-'.repeat(25));
  fs.mkdirSync(temporary, { mode: 0o700 });
  useTemporaryDirectory(t, temporary);
  const server = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  t.after(() => server.close());
  assert.equal(server.socketPath, null, 'construction does not select a path');
  await server.start();
  assert.equal(server.socketPath, path.join(dataDir, 'observer/runtime/control/control.sock'));
  assert.ok(Buffer.byteLength(server.socketPath) < 104);
  assert.equal(fs.statSync(path.dirname(server.socketPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(server.socketPath).mode & 0o777, 0o600);
  process.env.TMPDIR = path.join(dataDir, 'missing');
  assert.equal(fs.existsSync(process.env.TMPDIR), false, 'client uses a different, unavailable temporary directory');
  assert.deepEqual(await runObserverPreUninstall({ dataDir, configPath }), { mode: 'online' });
  await server.close();
  assert.equal(fs.existsSync(server.socketPath), false);
  assert.equal(fs.readdirSync(temporary).length, 0);
});

// Covers the final path-length rejection without side effects. Run for endpoint
// path changes; unrelated coordinator operations may skip this case.
test('overlong temporary and data paths reject start without throwing during construction', async (t) => {
  const { dataDir } = fixture(t);
  const long = path.join(dataDir, 'long-'.repeat(25));
  fs.mkdirSync(long, { mode: 0o700 });
  useTemporaryDirectory(t, long);
  assert.ok(Buffer.byteLength(path.join(long, 'observer/runtime/control/control.sock')) >= 104);
  assert.ok(Buffer.byteLength(path.join(long, `zobs-${process.getuid()}`, `zobs-ctl-${'a'.repeat(20)}.sock`)) >= 104);
  const server = new ObserverControlServer({ dataDir: long, onPreUninstall: async () => {} });
  t.after(() => server.close());
  assert.equal(server.socketPath, null);
  await assert.rejects(server.start(), { code: 'control_socket_path_too_long' });
  assert.equal(server.server, null);
  await server.close();
  assert.equal(fs.existsSync(path.join(long, 'observer/runtime/control/control.sock')), false);
});

for (const temporaryKind of ['directory', 'symlink']) {
  test(`long data paths use a canonical private temporary ${temporaryKind}`, async t => {
    const { root, dataDir } = fixture(t);
    const longData = path.join(dataDir, 'long-'.repeat(25));
    fs.mkdirSync(longData, { mode: 0o700 });
    const temporary = path.join(root, 'tmp');
    fs.mkdirSync(temporary, { mode: 0o700 });
    const alias = path.join(root, 'alias');
    if (temporaryKind === 'symlink') fs.symlinkSync(temporary, alias);
    useTemporaryDirectory(t, temporaryKind === 'symlink' ? alias : temporary);
    const expectedDirectory = path.join(temporary, `zobs-${process.getuid()}`);
    assert.ok(Buffer.byteLength(path.join(longData, 'observer/runtime/control/control.sock')) >= 104);
    assert.ok(Buffer.byteLength(path.join(expectedDirectory, `zobs-ctl-${'a'.repeat(20)}.sock`)) < 104);
    const server = new ObserverControlServer({ dataDir: longData, onPreUninstall: async () => {} });
    t.after(() => server.close());
    await server.start();
    assert.equal(path.dirname(server.socketPath), expectedDirectory);
    assert.equal(fs.statSync(expectedDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(server.socketPath).mode & 0o777, 0o600);
    assert.deepEqual(await runObserverPreUninstall({ dataDir: longData, configPath: path.join(longData, 'config.json') }), { mode: 'online' });
    await server.close();
    assert.equal(fs.existsSync(server.socketPath), false);
  });
}

for (const bytes of [103, 104]) {
  test(`a ${bytes}-byte data socket selects the portable length boundary`, async t => {
    const { root } = fixture(t);
    useTemporaryDirectory(t, root);
    const suffix = '/observer/runtime/control/control.sock';
    const dataDir = path.join(root, 'a'.repeat(bytes - Buffer.byteLength(root) - 1 - Buffer.byteLength(suffix)));
    fs.mkdirSync(dataDir, { mode: 0o700 });
    const local = dataDir + suffix;
    assert.equal(Buffer.byteLength(local), bytes);
    const server = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
    t.after(() => server.close());
    await server.start();
    if (bytes === 103) assert.equal(server.socketPath, local);
    else assert.equal(path.dirname(server.socketPath), path.join(root, `zobs-${process.getuid()}`));
  });
}

// Covers the temporary fallback's portable limit. Run for socket path changes;
// unrelated coordinator or rendering changes may skip these cases.
for (const bytes of [103, 104]) {
  test(`a ${bytes}-byte temporary socket enforces the portable length boundary`, async t => {
    const { root, dataDir } = fixture(t);
    const longData = path.join(dataDir, 'long-'.repeat(25));
    fs.mkdirSync(longData, { mode: 0o700 });
    const key = crypto.createHash('sha256').update(longData).digest('hex').slice(0, 20);
    const suffix = `/zobs-${process.getuid()}/zobs-ctl-${key}.sock`;
    const temporary = path.join(root, 'a'.repeat(bytes - Buffer.byteLength(root) - 1 - Buffer.byteLength(suffix)));
    fs.mkdirSync(temporary, { mode: 0o700 });
    useTemporaryDirectory(t, temporary);
    const expected = temporary + suffix;
    assert.equal(Buffer.byteLength(expected), bytes);
    assert.ok(Buffer.byteLength(path.join(longData, 'observer/runtime/control/control.sock')) >= 104);
    const server = new ObserverControlServer({ dataDir: longData, onPreUninstall: async () => {} });
    t.after(() => server.close());
    if (bytes === 103) {
      await server.start();
      assert.equal(server.socketPath, expected);
      assert.ok(fs.lstatSync(expected).isSocket());
    } else {
      await assert.rejects(server.start(), { code: 'control_socket_path_too_long' });
      assert.equal(server.server, null);
      assert.equal(fs.existsSync(expected), false);
    }
  });
}

test('multibyte data paths use bytes rather than character count for fallback', async t => {
  const { root } = fixture(t);
  useTemporaryDirectory(t, root);
  const dataDir = path.join(root, '\u754c'.repeat(20));
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const local = path.join(dataDir, 'observer/runtime/control/control.sock');
  assert.ok(local.length < 104);
  assert.ok(Buffer.byteLength(local) >= 104);
  const server = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  t.after(() => server.close());
  await server.start();
  assert.equal(path.dirname(server.socketPath), path.join(root, `zobs-${process.getuid()}`));
});

test('an unavailable temporary fallback rejects start while construction remains safe', async t => {
  const { root, dataDir } = fixture(t);
  const longData = path.join(dataDir, 'long-'.repeat(25));
  fs.mkdirSync(longData, { mode: 0o700 });
  useTemporaryDirectory(t, path.join(root, 'missing'));
  const server = new ObserverControlServer({ dataDir: longData, onPreUninstall: async () => {} });
  t.after(() => server.close());
  assert.equal(server.socketPath, null);
  await assert.rejects(server.start(), { code: 'ENOENT' });
  await server.close();
  assert.equal(server.lock, null);
});

// Covers unsafe existing parents and close after failed publication. Run for
// socket permission/cleanup changes; unrelated protocol changes may skip it.
test('shared and symlink socket directories are rejected without following or changing them', async (t) => {
  for (const location of ['data', 'temporary']) for (const kind of ['shared', 'symlink']) {
    await t.test(`${location} ${kind}`, async (t) => {
      const f = fixture(t);
      const dataDir = location === 'data' ? f.dataDir : path.join(f.dataDir, 'long-'.repeat(25));
      if (location === 'temporary') fs.mkdirSync(dataDir, { mode: 0o700 });
      useTemporaryDirectory(t, f.root);
      const server = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
      t.after(() => server.close());
      const local = path.join(dataDir, 'observer/runtime/control/control.sock');
      assert.equal(Buffer.byteLength(local) < 104, location === 'data', 'fixture selects the intended candidate');
      const directory = location === 'data' ? path.dirname(local) : path.join(f.root, `zobs-${process.getuid()}`);
      fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
      const outside = path.join(dataDir, 'outside');
      fs.mkdirSync(outside, { mode: 0o700 });
      const key = crypto.createHash('sha256').update(dataDir).digest('hex').slice(0, 20);
      const socketName = location === 'data' ? 'control.sock' : `zobs-ctl-${key}.sock`;
      const sentinel = path.join(outside, socketName);
      fs.writeFileSync(sentinel, 'preserve', { mode: 0o600 });
      if (kind === 'shared') {
        fs.mkdirSync(directory, { mode: 0o755 });
        fs.chmodSync(directory, 0o755);
      } else fs.symlinkSync(outside, directory);
      assert.ok(Buffer.byteLength(path.join(directory, `zobs-ctl-${'a'.repeat(20)}.sock`)) < 104);
      await assert.rejects(server.start(), kind === 'shared' && location === 'data'
        ? /Unsafe Observer control directory/ : { code: 'unsafe_runtime_state' });
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
  // An absent endpoint is not evidence that coordinator ownership is available.
  await assert.rejects(runObserverPreUninstall({ dataDir, configPath }), { code: 'coordinator_active' });
  const contender = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  t.after(() => contender.close());
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
  t.after(() => producer.close());
  await producer.start();
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

// Covers persistent socket recovery after an actual process crash, with real
// SQLite ownership and online control. Run for socket cleanup/ownership changes;
// unrelated UI changes may skip it. The runner isolates HOME/ZYLOS_DIR/PM2_HOME
// and TMPDIR; this case uses a private database/socket and never starts tmux.
test('a producer recovers the data socket left by a killed process', { timeout: 20000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { dataDir, configPath } = fixture(t);
  const socketPath = path.join(dataDir, 'observer/runtime/control/control.sock');
  const lockPath = path.join(dataDir, 'observer/runtime/control/coordinator-lock.sqlite');
  const environment = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]));
  assert.equal(fs.existsSync(socketPath), false);
  assert.equal(fs.existsSync(lockPath), false);
  console.log(JSON.stringify({ environment, dataDir, socketPath, lockPath, tmuxStarted: false }));
  const moduleUrl = new URL('../src/lib/observer-control.js', import.meta.url).href;
  const script = `import { ObserverControlServer } from ${JSON.stringify(moduleUrl)};
    const owner = new ObserverControlServer({ dataDir: process.argv[1], onPreUninstall: async () => {} });
    await owner.start();
    process.send({ socketPath: owner.socketPath, environment: Object.fromEntries(
      ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]])) });
    process.on('message', () => { if (!owner.lock) throw Error('owner lost lock'); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, dataDir], {
    env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    timeout: 10000, killSignal: 'SIGKILL',
  });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  let outputBytes = 0;
  const ready = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Producer exited before readiness')));
    const capture = chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 16384) {
        child.kill('SIGKILL');
        reject(new Error('Producer exceeded output limit'));
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
  });
  const actual = await ready;
  assert.equal(actual.socketPath, socketPath);
  for (const [key, value] of Object.entries(environment)) assert.equal(actual.environment[key], value);
  assert.ok(fs.lstatSync(socketPath).isSocket());
  const lockInode = fs.statSync(lockPath).ino;
  assert.equal(child.kill('SIGKILL'), true);
  const exit = await closed;
  assert.equal(exit.code, null);
  assert.equal(exit.signal, 'SIGKILL');
  assert.ok(outputBytes <= 16384);
  assert.ok(fs.lstatSync(socketPath).isSocket(), 'SIGKILL leaves the data socket behind');
  let calls = 0;
  const replacement = new ObserverControlServer({ dataDir, onPreUninstall: async () => { calls++; } });
  t.after(() => replacement.close());
  await replacement.start();
  assert.equal(replacement.socketPath, socketPath);
  assert.equal(fs.statSync(lockPath).ino, lockInode, 'recovery retains the same SQLite lock inode');
  assert.deepEqual(await runObserverPreUninstall({ dataDir, configPath }), { mode: 'online' });
  assert.equal(calls, 1);
  await replacement.close();
  assert.equal(fs.existsSync(socketPath), false);
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
  // An admin key with remote access on: this case is about the sleeping Origin.
  const service = new ObserverService({ coordinator, containment, manager, authGate, config: { chat: { allowRemote: true } } });
  let status, body;
  const res = { writeHead: value => { status = value; }, end: value => { body = JSON.parse(value); } };
  const handled = await service.handle({ method: 'POST', headers: {}, _authContext: context }, res, new URL('http://isolated.test/api/observer/leases'));
  assert.equal(handled, true); assert.equal(status, 409); assert.equal(body.error, 'agent_session_unavailable');
  assert.equal(starts, 0); assert.equal(manager.leases.size, 0); assert.equal(containment.active, null);
});
