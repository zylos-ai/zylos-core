import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

test('owned tree refuses an ancestor of the current home and leaves every entry intact', t => {
  const root = fixture(t), parent = path.join(root, 'parent'), home = path.join(parent, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'keep'), 'home contents');
  fs.writeFileSync(path.join(parent, 'sibling'), 'sibling contents');
  const previous = process.env.HOME;
  try {
    process.env.HOME = home;
    rejected(() => removeOwnedTree(root, parent));
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
  assert.equal(fs.readFileSync(path.join(home, 'keep'), 'utf8'), 'home contents');
  assert.equal(fs.readFileSync(path.join(parent, 'sibling'), 'utf8'), 'sibling contents');
});
