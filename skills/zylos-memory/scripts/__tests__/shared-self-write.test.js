import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyFragmentLocked } from '../self-write.js';
import { withMemoryLock } from '../memory-lock.js';
import { dreamRunDirectory } from '../dream-lock.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-workflow-self-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  return { root, runDir: dreamRunDirectory(root) };
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
