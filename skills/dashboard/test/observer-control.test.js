import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ObserverControlServer, runObserverPreUninstall } from '../src/lib/observer-control.js';

function fixture(t, observer = { enabled: true, generation: 4 }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-control-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({ observer }, null, 2)}\n`, { mode: 0o600 });
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
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, dataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  server.socketPath = path.join(dataDir, 'missing-parent', 'control.sock');
  const started = assert.rejects(server.start(), /listen/);
  await server.close();
  await started;
  assert.equal(server.lock, null);
  const next = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  await next.acquire(); await next.close();
});
