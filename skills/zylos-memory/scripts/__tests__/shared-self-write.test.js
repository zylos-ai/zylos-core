import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAllowedMemoryPath, applyFragmentLocked } from '../self-write.js';
import { memoryScope, withMemoryLock } from '../sync-lock.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-workflow-self-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_SESSION_GROUP: 'origin', ZYLOS_RUN_ID: 'self-test' };
  const scope = await memoryScope(env);
  fs.mkdirSync(scope.runDir, { recursive: true }); fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  return { root, ...scope };
}
test('shared fragments retain other content and reject stale/ambiguous fragments', async t => {
  const f = await fixture(t), target = path.join(f.root, 'memory', 'identity.md');
  fs.writeFileSync(target, 'first: old\nsecond: old\n');
  const update = (expected, replacement) => withMemoryLock(f.runDir, () => applyFragmentLocked({ target, expected, replacement }));
  await update('first: old', 'first: new');
  await update('second: old', 'second: new');
  assert.equal(fs.readFileSync(target, 'utf8'), 'first: new\nsecond: new\n');
  for (const expected of ['first: old', 'new', '']) await assert.rejects(update(expected, 'bad'), { code: 'FRAGMENT_CONFLICT' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'first: new\nsecond: new\n');
});
test('create and empty-file edits distinguish null from empty expected', async t => {
  const f = await fixture(t), target = path.join(f.root, 'memory', 'reference', 'new.md');
  const create = () => withMemoryLock(f.runDir, () => applyFragmentLocked({ target, expected: null, replacement: '' }));
  await create(); await assert.rejects(create(), { code: 'EXISTS' });
  await withMemoryLock(f.runDir, () => applyFragmentLocked({ target, expected: '', replacement: 'created' }));
  assert.equal(fs.readFileSync(target, 'utf8'), 'created');
  assert.throws(() => applyFragmentLocked({ target, expected: null, replacement: 'overwrite' }), { code: 'EXISTS' });
});
test('path validation checks normalized and actual symlink destinations', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside); fs.mkdirSync(path.join(f.root, 'memory', 'reference'));
  fs.symlinkSync(outside, path.join(f.root, 'memory', 'reference', 'escape'));
  fs.symlinkSync(path.join(outside, 'missing'), path.join(f.root, 'memory', 'reference', 'dangling'));
  for (const requested of ['../outside/file', '/tmp/file', 'state.md', 'reference/escape/file', 'reference/dangling', 'reference/../state.md']) {
    assert.throws(() => resolveAllowedMemoryPath({ root: f.root, path: requested }), { code: 'PATH_NOT_ALLOWED' });
  }
  assert.equal(resolveAllowedMemoryPath({ root: f.root, path: 'reference/../identity.md' }).path, 'identity.md');
  assert.equal(resolveAllowedMemoryPath({ root: f.root, path: 'users/u/profile.md' }).path, 'users/u/profile.md');
});
test('fragment publication failure leaves existing file intact', async t => {
  const f = await fixture(t), target = path.join(f.root, 'memory', 'identity.md');
  fs.writeFileSync(target, 'old');
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('injected before publication'); };
    await assert.rejects(withMemoryLock(f.runDir, () => applyFragmentLocked({ target, expected: 'old', replacement: 'new' })), { code: 'WRITE_FAILED' });
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(target, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['identity.md']);
});
