import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removePrivateTree } from '../src/lib/observer-tmux-state.js';
import { assertObserverTestIsolation } from './helpers/observer-isolation.js';

assertObserverTestIsolation();

// Files only; run for Observer private-tree ownership or shared deletion changes.
// Official runner proves private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR before
// import; each case owns and cleans its root. No runtime, server, DB or network.
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'observer-cleanup-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'retired'); fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'first'), 'owned first');
  return { base, root };
}

test('private Observer cleanup removes its validated tree through the shared deletion function', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'nested')); fs.writeFileSync(path.join(f.root, 'nested/entry'), 'owned nested');
  await removePrivateTree(f.root);
  assert.equal(fs.existsSync(f.root), false);
});

test('a linked private cleanup entry rejects the whole tree before any deletion', async t => {
  const f = fixture(t), outside = path.join(f.base, 'outside'); fs.writeFileSync(outside, 'outside bytes');
  fs.symlinkSync(outside, path.join(f.root, 'linked'));
  await assert.rejects(removePrivateTree(f.root), { code: 'unsafe_runtime_state' });
  assert.equal(fs.readFileSync(path.join(f.root, 'first'), 'utf8'), 'owned first');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside bytes');
  assert.equal(fs.lstatSync(path.join(f.root, 'linked')).isSymbolicLink(), true);
});

test('private cleanup preserves its root-permission requirement and entry budget', async t => {
  const f = fixture(t);
  fs.chmodSync(f.root, 0o755);
  await assert.rejects(removePrivateTree(f.root), { code: 'unsafe_runtime_state' });
  fs.chmodSync(f.root, 0o700);
  await assert.rejects(removePrivateTree(f.root, { count: 4096 }), { code: 'unsafe_runtime_state' });
  assert.equal(fs.readFileSync(path.join(f.root, 'first'), 'utf8'), 'owned first');
});

test('a late private-tree inspection failure leaves earlier readable entries intact', async t => {
  const f = fixture(t), blocked = path.join(f.root, 'z-blocked'); fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, 'entry'), 'blocked contents');
  const operation = fs.promises.readdir.bind(fs.promises);
  const failure = Object.assign(new Error('private fixture access denied'), { code: 'EACCES' });
  const syscall = t.mock.method(fs.promises, 'readdir', async (file, ...args) => {
    if (file === blocked) throw failure;
    const entries = await operation(file, ...args);
    return file === f.root ? entries.sort() : entries;
  });
  try { await assert.rejects(removePrivateTree(f.root), error => error === failure); }
  finally { syscall.mock.restore(); }
  assert.equal(fs.readFileSync(path.join(f.root, 'first'), 'utf8'), 'owned first');
  assert.equal(fs.readFileSync(path.join(blocked, 'entry'), 'utf8'), 'blocked contents');
});
