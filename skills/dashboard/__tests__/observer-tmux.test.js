import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { TmuxObserverContainment } from '../src/lib/observer-containment-tmux.js';

import { writeAtomic, exists, privateEnvironment } from '../src/lib/observer-tmux-state.js';
import { assertObserverTestIsolation } from './helpers/observer-isolation.js';

assertObserverTestIsolation();

test('private observer environment removes inherited identity and preserves unrelated values', t => {
  const inherited = {
    ZYLOS_RUN_ID: 'parent-run',
    ZYLOS_MODEL_CONFIG: '{"runtime":"claude"}',
    ZYLOS_SESSION_GROUP: 'parent-group',
    ZYLOS_OBSERVER_ENV_FIXTURE: 'spaces $ and \\ remain literal',
    ZYLOS_OBSERVER_EMPTY_FIXTURE: '',
  };
  const previous = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, inherited);
  const before = { ...process.env };
  const root = path.join(process.env.ZYLOS_DIR, 'observer-fixture');
  const state = { root, socketRoot: path.join(root, 'sockets') };
  const env = privateEnvironment(state);
  const identityKeys = new Set(['ZYLOS_RUN_ID', 'ZYLOS_MODEL_CONFIG', 'ZYLOS_SESSION_GROUP']);
  for (const key of identityKeys) {
    assert.equal(Object.hasOwn(env, key), false, `${key} must not reach the private tmux server`);
  }
  const relocated = new Set(['HOME', 'TMPDIR', 'TMP', 'TEMP', 'TERM']);
  for (const [key, value] of Object.entries(before)) {
    if (identityKeys.has(key)) continue;
    if (relocated.has(key) || key === 'TMUX' || key.startsWith('ZELLIJ') || key.startsWith('XDG_')) continue;
    assert.equal(env[key], value, `${key} must be preserved`);
  }
  assert.equal(env.HOME, path.join(root, 'home'));
  assert.equal(env.XDG_RUNTIME_DIR, state.socketRoot);
  assert.deepEqual({ ...process.env }, before);
});

const role = (pid, command = 'fixture-process', ppid = 1) => ({ pid, ppid, start: `start-${pid}`, status: 'S', command });
const fixtureScopes = new WeakMap();
async function fixture(t, extra = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(fsSync.existsSync('/dev/shm') ? '/dev/shm' : '/tmp', 't')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const sample = path.join(dataDir, 'observer', 'sockets', 'zobs2-0123456789abcdef', 'contract_version_1', 'observer-0123456789abcdef');
  const preferData = Buffer.byteLength(sample) < 104;
  const firstFixture = !fixtureScopes.has(t);
  if (firstFixture) fixtureScopes.set(t, { roots: new Set(), temporary: path.join(dataDir, 'p') });
  const { roots, temporary } = fixtureScopes.get(t);
  roots.add(dataDir);
  const privateFixturePath = file => {
    const resolved = path.resolve(file);
    assert.ok([...roots].some(root => resolved === root || resolved.startsWith(root + path.sep)),
      'lifecycle filesystem writes must stay inside registered private fixtures');
  };
  // Install each test's filesystem guards once, even when it owns many fixtures.
  if (firstFixture) {
    await fs.mkdir(temporary, { mode: 0o700 });
    const realpath = fs.realpath.bind(fs);
    t.mock.method(fs, 'realpath', file => {
      if (file !== '/tmp') return realpath(file);
      assert.equal(preferData, false, 'short lifecycle data paths must not resolve tmp');
      return Promise.resolve(temporary);
    });
    for (const name of ['mkdir', 'rm']) {
      const operation = fs[name].bind(fs);
      t.mock.method(fs, name, (file, ...args) => { privateFixturePath(file); return operation(file, ...args); });
    }
  }
  console.log('Observer lifecycle preflight:', JSON.stringify({ dataDir, temporary,
    fullSessionBytes: Buffer.byteLength(sample), socketBranch: preferData ? 'data' : 'private mapped tmp',
    sharedTmpWrites: 'rejected by mkdir/rm guards', nativeCommands: 'substituted' }));
  const binaryPath = path.join(dataDir, 'zellij');
  await fs.writeFile(binaryPath, 'inert fixture; never executed', { mode: 0o700 });
  const calls = [];
  const adapter = new TmuxObserverContainment({ dataDir, platform: process.platform, arch: process.arch,
    exec: async (file, args) => { calls.push(args); return { stdout: args.includes('display-message') ? '/tmp/fixture-target.sock\n' : '' }; },
    observe: async (pid) => role(pid), snapshot: async () => [], choosePort: async () => 23456,
    cleanupTimeoutMs: 1, startupTimeoutMs: 1, ...extra });
  const publish = async () => {
    const state = await adapter._publish({ generation: 1, binaryPath, runtime: 'codex' });
    const expectedParent = preferData ? path.join(dataDir, 'observer', 'sockets') : path.join(temporary, `zobs-${process.getuid()}`);
    assert.equal(path.dirname(state.socketRoot), expectedParent);
    privateFixturePath(state.socketRoot);
    t.after(() => fs.rm(state.socketRoot, { recursive: true, force: true }));
    return state;
  };
  return { adapter, publish, calls, dataDir, binaryPath };
}

// Native tmux with LC_ALL=C renders control characters in format strings as '_'.
// Expand the requested format so tests exercise the query/parser contract.

test('reused recorded server PID does not authorize its foreign replacement or descendants', async (t) => {
  const f = await fixture(t); const s = await f.publish();
  await fs.mkdir(path.join(s.root, 'pending', 'claim'));
  await writeAtomic(path.join(s.root, 'pending', 'claim', 'worker.json'), { nonce: s.nonce, role: role(109) });
  await fs.rename(path.join(s.root, 'pending'), path.join(s.root, 'starting'));
  await writeAtomic(path.join(s.root, 'starting', 'server.json'), { nonce: s.nonce, role: role(110) });
  const live = [{ ...role(110, 'unrelated server'), start: 'replacement' }, role(111, 'foreign child', 110)];
  f.adapter.observe = async (pid) => live.find((r) => r.pid === pid) || null;
  f.adapter.snapshot = async () => live;
  f.adapter.signal = () => assert.fail('foreign process signaled');
  await f.adapter.reconcilePersisted();
  assert.equal(await exists(s.root), false);
});

function agentTmux({ status = 'on', applied = null } = {}) {
  const calls = [];
  let size = { cols: 80, rows: 24 };
  const exec = async (file, args) => {
    calls.push([file, args]);
    const format = args.at(-1);
    if (args.includes('has-session')) return { stdout: '' };
    if (format === '#{socket_path}') return { stdout: '/tmp/agent.sock\n' };
    if (format === '#{status}') return { stdout: `${status}\n` };
    if (args.includes('resize-window')) {
      size = applied || { cols: Number(args[args.indexOf('-x') + 1]), rows: Number(args[args.indexOf('-y') + 1]) };
      return { stdout: '' };
    }
    if (format === '#{window_width} #{window_height} #{status}') return { stdout: `${size.cols} ${size.rows} ${status}\n` };
    throw new Error(`unexpected tmux call ${args.join(' ')}`);
  };
  return { calls, exec };
}

test('resizeAgent resizes only the runtime session on its own socket and verifies the result', async (t) => {
  const tmux = agentTmux();
  const f = await fixture(t, { exec: tmux.exec, tmuxPath: '/usr/bin/tmux' });
  assert.deepEqual(await f.adapter.resizeAgent({ runtime: 'claude', cols: 132, rows: 60 }), { cols: 132, rows: 60, statusLines: 1 });
  assert.ok(tmux.calls.every(([file]) => file === '/usr/bin/tmux'));
  const resize = tmux.calls.find(([, args]) => args.includes('resize-window'))[1];
  assert.deepEqual(resize, ['-N', '-S', '/tmp/agent.sock', 'resize-window', '-t', '=claude-main:', '-x', '132', '-y', '60']);
  const codex = agentTmux();
  f.adapter.exec = codex.exec;
  await f.adapter.resizeAgent({ runtime: 'codex', cols: 100, rows: 40 });
  assert.ok(codex.calls.find(([, args]) => args.includes('resize-window'))[1].includes('=codex-main:'));
});

test('containment rejects foreign tmux names and replaced group identities before publishing', async t => {
  const target = { sessionMode: 'multi', sessionGroup: 'telegram:42', runtime: 'codex', runId: 'group-run', tmuxName: 'foreign-session' };
  const f = await fixture(t, { resolveTarget: async () => ({ ...target }) });
  await assert.rejects(f.adapter._publish({ generation: 1, binaryPath: f.binaryPath, runtime: 'codex', observerTarget: { ...target } }), { code: 'target_mismatch' });
  assert.equal(f.calls.length, 0);
  target.tmuxName = 'zylos-group-telegram=42';
  await assert.rejects(f.adapter._publish({ generation: 1, binaryPath: f.binaryPath, runtime: 'codex', observerTarget: { ...target, runId: 'previous' } }), { code: 'target_mismatch' });
  assert.equal(f.calls.length, 0);
});
