import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { TmuxObserverContainment } from '../src/lib/observer-containment-tmux.js';
import { observerSocketRoot, mkdirPrivate, validateState, writeAtomic, privatePath, exists } from '../src/lib/observer-tmux-state.js';
import { assertObserverTestIsolation } from './helpers/observer-isolation.js';

assertObserverTestIsolation();

// Canonical /private/tmp fixtures on macOS exceed the 16-byte root budget
// needed by these data-path and 103/104-byte boundary cases.
const test = (name, fn) => nodeTest(name, { skip: process.platform === 'darwin'
  ? 'Requires a canonical fixture root <=16 bytes; macOS /private/tmp is too long' : false }, fn);

const nonce = '0123456789abcdef0123456789abcdef';
const leaf = `zobs2-${nonce.slice(0, 16)}`;
const session = `observer-${nonce.slice(0, 16)}`;
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(fsSync.existsSync('/dev/shm') ? '/dev/shm' : '/tmp', 'o')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'd');
  const temporary = path.join(base, 't');
  for (const root of [dataDir, temporary]) await fs.mkdir(root, { mode: 0o700 });
  return { base, dataDir, temporary };
}
function dataPathOfLength(base, length) {
  const suffix = path.join('observer', 'sockets', leaf, 'contract_version_1', session);
  const count = length - Buffer.byteLength(path.join(base, 'a', suffix)) + 1;
  assert.ok(count > 0);
  return path.join(base, 'a'.repeat(count));
}

test('short data socket paths do not resolve temporary storage and have private parents', async t => {
  const f = await fixture(t);
  const realpath = fs.realpath.bind(fs);
  t.mock.method(fs, 'realpath', file => { assert.notEqual(file, '/tmp', 'data-first selection must not resolve tmp'); return realpath(file); });
  const socket = await observerSocketRoot(f.dataDir, nonce);
  assert.equal(socket, path.join(f.dataDir, 'observer', 'sockets', leaf));
  await mkdirPrivate(path.dirname(socket));
  const stat = await privatePath(path.dirname(socket));
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o777, 0o700);
});

for (const length of [103, 104]) test(`full session socket length ${length} selects the correct directory`, async t => {
  const f = await fixture(t);
  const dataDir = dataPathOfLength(f.base, length);
  await fs.mkdir(dataDir, { mode: 0o700 });
  const local = path.join(dataDir, 'observer', 'sockets', leaf);
  assert.equal(Buffer.byteLength(path.join(local, 'contract_version_1', session)), length);
  const socket = await observerSocketRoot(dataDir, nonce);
  assert.equal(socket, length === 103 ? local : path.join(await fs.realpath('/tmp'), `zobs-${process.getuid()}`, leaf));
  assert.ok(Buffer.byteLength(path.join(socket, 'tmux')) < 104);
  assert.ok(Buffer.byteLength(path.join(socket, 'contract_version_1', session)) < 104);
});

test('multibyte data paths use bytes rather than character counts', async t => {
  const f = await fixture(t);
  const dataDir = path.join(f.base, '\u754c');
  await fs.mkdir(dataDir, { mode: 0o700 });
  const full = path.join(dataDir, 'observer', 'sockets', leaf, 'contract_version_1', session);
  assert.ok(full.length < 104);
  assert.ok(Buffer.byteLength(full) >= 104);
  assert.equal(await observerSocketRoot(dataDir, nonce), path.join(await fs.realpath('/tmp'), `zobs-${process.getuid()}`, leaf));
});

for (const kind of ['missing', 'long']) test(`fixed tmp fallback ignores ${kind} environment temporary storage`, async t => {
  const f = await fixture(t);
  const dataDir = dataPathOfLength(f.base, 104);
  await fs.mkdir(dataDir, { mode: 0o700 });
  const temporary = path.join(f.base, kind === 'missing' ? 'missing' : 't'.repeat(100));
  if (kind === 'long') await fs.mkdir(temporary, { mode: 0o700 });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  t.after(() => { process.env.TMPDIR = previous; });
  assert.equal(await observerSocketRoot(dataDir, nonce), path.join(await fs.realpath('/tmp'), `zobs-${process.getuid()}`, leaf));
  if (kind === 'missing') assert.equal(await exists(temporary), false);
});

test('fixed tmp fallback refuses an overlong canonical tmp path', async t => {
  const f = await fixture(t);
  const dataDir = dataPathOfLength(f.base, 104);
  await fs.mkdir(dataDir, { mode: 0o700 });
  const realpath = fs.realpath.bind(fs);
  t.mock.method(fs, 'realpath', file => file === '/tmp' ? Promise.resolve(path.join(f.base, 't'.repeat(100))) : realpath(file));
  await assert.rejects(observerSocketRoot(dataDir, nonce), { code: 'observer_socket_path_too_long' });
});

for (const long of [false, true]) for (const kind of ['permissions', 'symlink']) {
  test(`${long ? 'long' : 'short'} data paths reject unsafe ${kind} without falling back`, async t => {
    const f = await fixture(t);
    const dataDir = long ? dataPathOfLength(f.base, 104) : f.dataDir;
    const parent = path.join(dataDir, 'observer', 'sockets');
    await fs.mkdir(path.dirname(parent), { recursive: true, mode: 0o700 });
    if (kind === 'symlink') await fs.symlink(f.temporary, parent);
    else { await fs.mkdir(parent, { mode: 0o700 }); await fs.chmod(parent, 0o755); }
    const realpath = fs.realpath.bind(fs);
    t.mock.method(fs, 'realpath', file => { assert.notEqual(file, '/tmp', 'unsafe data must not fall back'); return realpath(file); });
    await assert.rejects(observerSocketRoot(dataDir, nonce), { code: 'unsafe_runtime_state' });
    assert.equal((await fs.stat(f.temporary)).mode & 0o777, 0o700);
  });
}

test('foreign directory ownership is refused without changing its mode', async t => {
  const f = await fixture(t);
  const parent = path.join(f.dataDir, 'observer', 'sockets');
  await mkdirPrivate(parent);
  const lstat = fs.lstat.bind(fs);
  t.mock.method(fs, 'lstat', async file => file === parent
    ? Object.assign(await lstat(file), { uid: process.getuid() + 1 }) : lstat(file));
  await assert.rejects(observerSocketRoot(f.dataDir, nonce), { code: 'unsafe_runtime_state' });
});

async function published(t, { fallback = false } = {}) {
  const f = await fixture(t);
  if (fallback) {
    f.dataDir = dataPathOfLength(f.base, 104);
    await fs.mkdir(f.dataDir, { mode: 0o700 });
    const realpath = fs.realpath.bind(fs);
    t.mock.method(fs, 'realpath', file => file === '/tmp' ? Promise.resolve(f.temporary) : realpath(file));
  }
  const binaryPath = path.join(f.base, 'zellij');
  await fs.writeFile(binaryPath, 'inert; never executed', { mode: 0o700 });
  const commands = [];
  const adapter = new TmuxObserverContainment({ dataDir: f.dataDir,
    exec: async (file, args) => { commands.push(args); return { stdout: args.includes('display-message') ? path.join(f.base, 'agent.sock') : '' }; },
    choosePort: async () => 23456, snapshot: async () => [],
    observe: async pid => ({ pid, ppid: 1, start: `start-${pid}`, status: 'S', command: 'fixture' }),
  });
  const state = await adapter._publish({ generation: 1, runtime: 'codex', binaryPath });
  return { ...f, adapter, state, commands };
}

test('newly published generations validate without accessing tmp and reconcile only their own scope', async t => {
  const f = await published(t);
  const foreign = path.join(f.dataDir, 'observer', 'sockets', 'unrelated');
  await fs.writeFile(foreign, 'retain');
  const realpath = fs.realpath.bind(fs);
  t.mock.method(fs, 'realpath', file => { assert.notEqual(file, '/tmp'); return realpath(file); });
  assert.equal((await validateState(f.state.root)).socketRoot, f.state.socketRoot);
  f.commands.length = 0;
  await f.adapter.reconcilePersisted();
  assert.equal(await exists(f.state.root), false);
  assert.equal(await fs.readFile(foreign, 'utf8'), 'retain');
  assert.equal(f.commands.length, 0);
});

for (const scope of ['data', 'tmp']) test(`persisted ${scope} socket scope reconciles after its parent disappears`, async t => {
  const f = await published(t, { fallback: scope === 'tmp' });
  const parent = path.dirname(f.state.socketRoot);
  assert.equal(await exists(f.state.socketRoot), false);
  await fs.rmdir(parent);
  assert.equal((await validateState(f.state.root)).socketRoot, f.state.socketRoot);
  assert.equal(await exists(parent), false, 'validation must not recreate missing parents');
  f.commands.length = 0;
  await f.adapter.reconcilePersisted();
  assert.equal(await exists(f.state.root), false);
  assert.equal(await exists(parent), false);
  assert.equal(f.commands.length, 0);
});

test('persisted fixed tmp scope validates and reconciles after TMPDIR changes', async t => {
  const f = await published(t, { fallback: true });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = path.join(f.base, 'changed');
  t.after(() => { process.env.TMPDIR = previous; });
  assert.equal((await validateState(f.state.root)).socketRoot, f.state.socketRoot);
  f.commands.length = 0;
  await f.adapter.reconcilePersisted();
  assert.equal(await exists(f.state.root), false);
  assert.equal(f.commands.length, 0);
});

for (const scope of ['data', 'tmp']) for (const kind of ['owner', 'permissions', 'symlink', 'file']) {
  test(`persisted ${scope} socket scope refuses a parent with invalid ${kind}`, async t => {
    const f = await published(t, { fallback: scope === 'tmp' });
    const parent = path.dirname(f.state.socketRoot);
    if (kind === 'owner') {
      const lstat = fs.lstat.bind(fs);
      t.mock.method(fs, 'lstat', async file => file === parent
        ? Object.assign(await lstat(file), { uid: process.getuid() + 1 }) : lstat(file));
    } else if (kind === 'permissions') await fs.chmod(parent, 0o755);
    else {
      await fs.rmdir(parent);
      if (kind === 'symlink') await fs.symlink(f.temporary, parent);
      else await fs.writeFile(parent, 'retain', { mode: 0o600 });
    }
    await assert.rejects(validateState(f.state.root), { code: 'unsafe_runtime_state' });
    await assert.rejects(f.adapter.reconcilePersisted(), { code: 'unsafe_runtime_state' });
    assert.equal(await exists(f.state.root), true, 'rejected metadata must not remove the generation');
  });
}

test('persisted tmp scope refuses foreign anchors, account directories and nonce leaves', async t => {
  const f = await published(t, { fallback: true });
  const parent = path.dirname(f.state.socketRoot);
  for (const socketRoot of [path.join(f.base, path.basename(parent), path.basename(f.state.socketRoot)),
    path.join(f.temporary, `zobs-${process.getuid() + 1}`, path.basename(f.state.socketRoot)),
    path.join(parent, 'zobs2-ffffffffffffffff')]) {
    await writeAtomic(path.join(f.state.root, 'state.json'), { ...f.state, socketRoot, outerSocket: path.join(socketRoot, 'tmux') });
    await assert.rejects(validateState(f.state.root), { code: 'unsafe_runtime_state' });
  }
});

for (const scope of ['data', 'tmp']) test(`persisted ${scope} identity remains recoverable beyond the current publication length limit`, async t => {
  const f = await published(t, { fallback: true });
  let socketRoot;
  if (scope === 'data') socketRoot = path.join(f.dataDir, 'observer', 'sockets', path.basename(f.state.socketRoot));
  else {
    const temporary = path.join(f.base, 'temporary-'.repeat(8));
    const realpath = fs.realpath.bind(fs);
    t.mock.method(fs, 'realpath', file => file === '/tmp' ? Promise.resolve(temporary) : realpath(file));
    socketRoot = path.join(temporary, `zobs-${process.getuid()}`, path.basename(f.state.socketRoot));
  }
  await mkdirPrivate(path.dirname(socketRoot));
  assert.ok(Buffer.byteLength(path.join(socketRoot, 'contract_version_1', f.state.sessionName)) >= 104);
  const state = { ...f.state, socketRoot, outerSocket: path.join(socketRoot, 'tmux') };
  await writeAtomic(path.join(state.root, 'state.json'), state);
  assert.equal((await validateState(state.root)).socketRoot, socketRoot);
  await writeAtomic(path.join(state.root, 'state.json'), { ...state, socketRoot: socketRoot + '-foreign' });
  await assert.rejects(validateState(state.root), { code: 'unsafe_runtime_state' });
  await writeAtomic(path.join(state.root, 'state.json'), state);
  f.commands.length = 0;
  await f.adapter.reconcilePersisted();
  assert.equal(await exists(state.root), false);
  assert.equal(await exists(socketRoot), false);
  assert.equal(f.commands.length, 0);
});

test('schema two accepts only the same nonce historical tmp socket without creating it', async t => {
  const f = await published(t);
  const historical = path.join(await fs.realpath('/tmp'), `zobs2-${f.state.nonce.slice(0, 16)}`);
  const legacy = { ...f.state, socketRoot: historical, outerSocket: path.join(historical, 'tmux') };
  await writeAtomic(path.join(legacy.root, 'state.json'), legacy);
  const lstat = fs.lstat.bind(fs);
  t.mock.method(fs, 'lstat', file => { assert.ok(!String(file).startsWith(historical), 'legacy validation must not touch the socket'); return lstat(file); });
  assert.equal((await validateState(legacy.root)).socketRoot, historical);
  for (const socketRoot of [historical + '-foreign', path.join(f.temporary, path.basename(historical)),
    path.join(path.dirname(historical), 'zobs2-ffffffffffffffff')]) {
    await writeAtomic(path.join(legacy.root, 'state.json'), { ...legacy, socketRoot, outerSocket: path.join(socketRoot, 'tmux') });
    await assert.rejects(validateState(legacy.root), { code: 'unsafe_runtime_state' });
  }
  await writeAtomic(path.join(legacy.root, 'state.json'), { ...legacy, hashes: { ...legacy.hashes, binary: '0'.repeat(64) } });
  await assert.rejects(validateState(legacy.root), { code: 'unsafe_runtime_state' });
});

test('data directories and nonce values produce distinct socket scopes', async t => {
  const f = await fixture(t);
  const other = path.join(f.base, 'e');
  await fs.mkdir(other, { mode: 0o700 });
  const sockets = await Promise.all([observerSocketRoot(f.dataDir, nonce), observerSocketRoot(other, nonce),
    observerSocketRoot(f.dataDir, 'fedcba98765432100123456789abcdef')]);
  assert.equal(new Set(sockets).size, 3);
});
