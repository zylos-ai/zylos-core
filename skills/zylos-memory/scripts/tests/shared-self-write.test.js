import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAllowedMemoryPath, applyFragmentLocked, apply } from '../self-write.js';
import { memoryScope, markerPath, withMemoryLock } from '../sync-lock.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p07-self-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_SESSION_GROUP: 'origin', ZYLOS_RUN_ID: 'self-test' };
  const scope = await memoryScope(env), token = 'a'.repeat(32);
  fs.mkdirSync(scope.runDir, { recursive: true }); fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.writeFileSync(markerPath(scope.runDir, 'origin'), JSON.stringify({ runId: env.ZYLOS_RUN_ID, kind: 'origin', token, startedAt: Date.now(), expiresAt: Date.now() + 1800000 }));
  const settings = { env, kind: 'origin', token }, deps = { currentRunId: async () => env.ZYLOS_RUN_ID };
  return { root, ...scope, settings, deps };
}
test('IB51 shared fragments retain other content and reject stale/ambiguous fragments', async t => {
  const f = await fixture(t), target = path.join(f.root, 'memory', 'identity.md');
  fs.writeFileSync(target, 'first: old\nsecond: old\n');
  const update = (expected, replacement) => apply({ ...f.settings, input: { path: 'identity.md', expected, replacement } }, f.deps);
  await update('first: old', 'first: new');
  await update('second: old', 'second: new');
  assert.equal(fs.readFileSync(target, 'utf8'), 'first: new\nsecond: new\n');
  for (const expected of ['first: old', 'new', '']) await assert.rejects(update(expected, 'bad'), { code: 'FRAGMENT_CONFLICT' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'first: new\nsecond: new\n');
});
test('IB51 create and empty-file edits distinguish null from empty expected', async t => {
  const f = await fixture(t), target = path.join(f.root, 'memory', 'reference', 'new.md');
  const create = () => apply({ ...f.settings, input: { path: 'reference/new.md', expected: null, replacement: '' } }, f.deps);
  await create(); await assert.rejects(create(), { code: 'FRAGMENT_CONFLICT' });
  await apply({ ...f.settings, input: { path: 'reference/new.md', expected: '', replacement: 'created' } }, f.deps);
  assert.equal(fs.readFileSync(target, 'utf8'), 'created');
  assert.throws(() => applyFragmentLocked({ target, expected: null, replacement: 'overwrite' }), { code: 'EXISTS' });
});
test('IB53 path validation checks normalized and actual symlink destinations', async t => {
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
test('IB51 stale token cannot write shared state; write fault leaves existing file intact', async t => {
  const f = await fixture(t), target = path.join(f.root, 'memory', 'identity.md');
  fs.writeFileSync(target, 'old');
  await assert.rejects(apply({ ...f.settings, token: 'b'.repeat(32), input: { path: 'identity.md', expected: 'old', replacement: 'new' } }, f.deps), { code: 'TOKEN_MISMATCH' });
  let assertions = 0;
  await assert.rejects(withMemoryLock(f.runDir, () => applyFragmentLocked({ target, expected: 'old', replacement: 'new', assertHeld() { if (++assertions === 2) throw new Error('injected before publication'); } })), /injected/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['identity.md']);
});
