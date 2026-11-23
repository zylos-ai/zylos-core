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

test('a linked private cleanup entry rejects the whole tree before any deletion', async t => {
  const f = fixture(t), outside = path.join(f.base, 'outside'); fs.writeFileSync(outside, 'outside bytes');
  fs.symlinkSync(outside, path.join(f.root, 'linked'));
  await assert.rejects(removePrivateTree(f.root), { code: 'unsafe_runtime_state' });
  assert.equal(fs.readFileSync(path.join(f.root, 'first'), 'utf8'), 'owned first');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside bytes');
  assert.equal(fs.lstatSync(path.join(f.root, 'linked')).isSymbolicLink(), true);
});
