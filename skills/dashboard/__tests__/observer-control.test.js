import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ObserverControlServer } from '../src/lib/observer-control.js';

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

// Runs an ownership attempt that must time out: the lock poll's real 25 ms sleeps
// continue while a mocked clock is stepped past its deadline.

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

// Covers the final path-length rejection without side effects. Run for endpoint
// path changes; unrelated coordinator operations may skip this case.

// Covers the temporary fallback's portable limit. Run for socket path changes;
// unrelated coordinator or rendering changes may skip these cases.

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

// Covers the unchanged lock contract used by an older client/coordinator. Run
// with endpoint or mutex changes; skip for unrelated rendering changes.

// Covers persistent socket recovery after an actual process crash, with real
// SQLite ownership and online control. Run for socket cleanup/ownership changes;
// unrelated UI changes may skip it. The runner isolates HOME/ZYLOS_DIR/PM2_HOME
// and TMPDIR; this case uses a private database/socket and never starts tmux.

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
  assert.equal(handled, true); assert.equal(status, 409); assert.equal(body.error.code, 'agent_session_unavailable');
  assert.equal(starts, 0); assert.equal(manager.leases.size, 0); assert.equal(containment.active, null);
});
