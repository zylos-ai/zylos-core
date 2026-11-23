import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmuxClientArgs } from '../tmux-client-args.js';


function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-directory-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('private directory selects an explicit default or named socket and validates existing permissions', t => {
  const root = directory(t), env = { TMUX_TMPDIR: root };
  const socketDirectory = path.join(root, `tmux-${process.getuid()}`);
  assert.deepEqual(tmuxClientArgs({}, env), ['-u', '-S', path.join(socketDirectory, 'default')]);
  assert.deepEqual(tmuxClientArgs({ socketName: 'test' }, env), ['-u', '-S', path.join(socketDirectory, 'test')]);
  assert.deepEqual(tmuxClientArgs({ socketPath: '/explicit/socket' }, env), ['-u', '-S', '/explicit/socket']);
  assert.equal(fs.statSync(socketDirectory).mode & 0o777, 0o700);
  fs.chmodSync(socketDirectory, 0o770);
  assert.deepEqual(tmuxClientArgs({}, env), ['-u', '-S', path.join(socketDirectory, 'default')]);
  fs.chmodSync(socketDirectory, 0o755);
  assert.throws(() => tmuxClientArgs({}, env), { code: 'TMUX_DIR_UNSAFE' });
});

test('socket directory owned by another user is rejected', t => {
  const root = directory(t), child = path.join(root, `tmux-${process.getuid()}`);
  fs.mkdirSync(child, { mode: 0o700 });
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', target => {
    assert.equal(target, child);
    const stat = lstat(target); stat.uid = process.getuid() + 1; return stat;
  });
  assert.throws(() => tmuxClientArgs({}, { TMUX_TMPDIR: root }), { code: 'TMUX_DIR_UNSAFE' });
});
