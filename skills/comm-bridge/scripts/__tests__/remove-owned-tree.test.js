import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeOwnedTree } from '../remove-owned-tree.js';

function fixture(t, base = fs.realpathSync(os.tmpdir())) {
  const root = fs.mkdtempSync(path.join(base, 'owned-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const rejected = callback => assert.throws(callback, { code: 'OWNED_TREE_PATH_INVALID' });

test('owned tree rejects root, filesystem root, home, outside and traversal targets', t => {
  const root = fixture(t), tree = path.join(root, 'tree');
  fs.mkdirSync(tree); fs.writeFileSync(path.join(tree, 'keep'), 'unchanged');
  for (const target of [root, '/', os.homedir(), path.join(path.dirname(root), 'outside'), path.join(root, '..', 'escape')]) {
    rejected(() => removeOwnedTree(root, target));
  }
  rejected(() => removeOwnedTree('/', tree));
  rejected(() => removeOwnedTree('relative-root', tree));
  const home = fs.realpathSync(os.homedir());
  rejected(() => removeOwnedTree(fs.realpathSync(path.dirname(home)), home));
  assert.equal(fs.readFileSync(path.join(tree, 'keep'), 'utf8'), 'unchanged');
});

test('owned tree rejects a linked root, linked ancestor and linked target', t => {
  const root = fixture(t), tree = path.join(root, 'tree'), link = path.join(root, 'link');
  fs.mkdirSync(tree); fs.writeFileSync(path.join(tree, 'keep'), 'unchanged');
  fs.symlinkSync(tree, link, 'dir');
  rejected(() => removeOwnedTree(link, path.join(link, 'keep')));
  rejected(() => removeOwnedTree(root, path.join(link, 'keep')));
  rejected(() => removeOwnedTree(root, link));
  assert.equal(fs.readFileSync(path.join(tree, 'keep'), 'utf8'), 'unchanged');
});

test('owned tree removes only nested link entries and returns a file count', t => {
  const container = fixture(t), root = path.join(container, 'owned');
  const tree = path.join(root, 'tree'), external = path.join(container, 'external');
  fs.mkdirSync(tree, { recursive: true }); fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'keep'), 'outside remains');
  fs.writeFileSync(path.join(tree, 'file'), 'inside');
  fs.mkdirSync(path.join(tree, 'empty'));
  fs.symlinkSync(path.join(external, 'keep'), path.join(tree, 'file-link'));
  fs.symlinkSync(external, path.join(tree, 'directory-link'), 'dir');
  fs.symlinkSync(path.join(external, 'missing'), path.join(tree, 'dangling-link'));
  assert.equal(removeOwnedTree(root, tree), 4);
  assert.equal(fs.existsSync(tree), false);
  assert.equal(fs.readFileSync(path.join(external, 'keep'), 'utf8'), 'outside remains');
});

test('owned tree is idempotent for missing targets and handles a single file', t => {
  const root = fixture(t), file = path.join(root, 'file');
  assert.equal(removeOwnedTree(root, path.join(root, 'missing', 'tree')), 0);
  fs.writeFileSync(file, 'entry');
  assert.equal(removeOwnedTree(root, file), 1);
  assert.equal(removeOwnedTree(root, file), 0);
});

test('unreadable subtree aborts the entire preflight without deleting any entry', { timeout: 15000 }, t => {
  const privileged = typeof process.getuid === 'function' && process.getuid() === 0;
  // A root-runner TMPDIR can have private root-only ancestors. Allocate this
  // root-only child fixture directly in canonical system tmp, then chown it.
  const root = fixture(t, fs.realpathSync(privileged ? '/tmp' : os.tmpdir()));
  const tree = path.join(root, 'tree'), locked = path.join(tree, 'm-locked');
  const visible = path.join(tree, 'a-visible'), visibleLast = path.join(tree, 'z-visible');
  const hidden = path.join(locked, 'hidden');
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(visible, 'visible remains');
  fs.writeFileSync(visibleLast, 'last visible remains');
  fs.writeFileSync(hidden, 'hidden remains');
  let childEnv, uid, gid;
  if (privileged) {
    // Resolve an actual unprivileged OS identity; unknown numeric users may
    // not have the home-directory information the real helper also checks.
    uid = Number(execFileSync('id', ['-u', 'nobody'], { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 1024 }).trim());
    gid = Number(execFileSync('id', ['-g', 'nobody'], { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 1024 }).trim());
    assert.ok(Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0);
    childEnv = { PATH: process.env.PATH || '/usr/bin:/bin',
      ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}) };
    const directories = [];
    for (const name of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
      const directory = path.join(root, name.toLowerCase());
      fs.mkdirSync(directory, { mode: 0o700 });
      childEnv[name] = directory;
      directories.push(directory);
    }
    for (const file of [root, tree, locked, visible, visibleLast, hidden, ...directories]) fs.chownSync(file, uid, gid);
    fs.chmodSync(root, 0o700);
    fs.chmodSync(tree, 0o700);
  }
  fs.chmodSync(locked, 0);
  try {
    if (privileged) {
      const child = fileURLToPath(new URL('./helpers/owned-tree-permission-child.js', import.meta.url));
      const result = JSON.parse(execFileSync(process.execPath, [child, root, tree, locked, String(uid), String(gid)], {
        cwd: root, env: childEnv, encoding: 'utf8', timeout: 7000, killSignal: 'SIGKILL', maxBuffer: 4096,
      }));
      assert.equal(result.uid, uid);
      assert.equal(result.gid, gid);
      assert.equal(result.deniedRead, true);
      assert.equal(result.writableTree, true);
      t.diagnostic(`Permission proof: root child dropped to uid=${result.uid}, gid=${result.gid}; owned tree writable, locked readdir denied`);
    } else {
      // Permission enforcement is an actual OS boundary, not a mocked error.
      assert.throws(() => removeOwnedTree(root, tree), error => ['EACCES', 'EPERM'].includes(error.code));
      t.diagnostic(`Permission proof: unprivileged runner uid=${process.getuid?.() ?? 'unavailable'}`);
    }
  } finally { fs.chmodSync(locked, 0o700); }
  assert.equal(fs.readFileSync(visible, 'utf8'), 'visible remains');
  assert.equal(fs.readFileSync(visibleLast, 'utf8'), 'last visible remains');
  assert.equal(fs.readFileSync(hidden, 'utf8'), 'hidden remains');
});

// HOME may use a symlink spelling even though the deletion root is canonical.
test('owned tree protects the current home through an aliased HOME setting', t => {
  const root = fixture(t), home = path.join(root, 'private-home'), alias = path.join(root, 'home-alias');
  fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'keep'), 'home remains');
  fs.symlinkSync(home, alias, 'dir');
  const previous = process.env.HOME;
  try {
    process.env.HOME = alias;
    rejected(() => removeOwnedTree(root, home));
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
  assert.equal(fs.readFileSync(path.join(home, 'keep'), 'utf8'), 'home remains');
});
