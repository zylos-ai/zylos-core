import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { removeOwnedTree } from '../../remove-owned-tree.js';

// Static imports finish while privileged, so a root-owned checkout need not be
// readable after dropping identity. All later filesystem access is fixture-only.
const [root, tree, locked, user, group, permission] = process.argv.slice(2);
const uid = Number(user), gid = Number(group);
assert.equal(process.getuid(), 0);
assert.ok(Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0);
assert.equal(fs.realpathSync(root), root);
for (const name of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
  assert.ok(process.env[name]?.startsWith(root + path.sep), `${name} belongs to the private fixture`);
  assert.equal(fs.realpathSync(process.env[name]), process.env[name]);
}
process.chdir(root);
process.setgroups([]);
process.setgid(gid);
process.setuid(uid);
assert.equal(process.getuid(), uid);
assert.equal(process.getgid(), gid);
assert.equal(fs.statSync(tree).uid, uid, 'The unprivileged child owns the writable deletion directory');
fs.accessSync(tree, fs.constants.W_OK | fs.constants.X_OK);
if (permission === 'unreadable') {
  assert.throws(() => fs.readdirSync(locked), error => ['EACCES', 'EPERM'].includes(error.code));
} else {
  fs.readdirSync(locked);
  const directory = permission === 'readonly-parent' ? root : locked;
  assert.throws(() => fs.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK),
    error => ['EACCES', 'EPERM'].includes(error.code));
}
assert.throws(() => removeOwnedTree(root, tree), error => ['EACCES', 'EPERM'].includes(error.code));
process.stdout.write(JSON.stringify({ uid, gid, permissionDenied: true, writableTree: true }) + '\n');
