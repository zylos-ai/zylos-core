import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeMemory, appendMemory } from '../memory-write.js';
import { dreamRunDirectory } from '../dream-lock.js';
import { withMemoryLock } from '../memory-lock.js';

const digest = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-write-'));
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'home/zylos'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp') };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) fs.mkdirSync(env[key], { recursive: true });
  const memory = path.join(env.ZYLOS_DIR, 'memory');
  fs.mkdirSync(memory);
  const file = path.join(memory, 'identity.md');
  fs.writeFileSync(file, 'original\n', { mode: 0o640 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, env, memory, file, settings: { path: 'identity.md', sha256: digest('original\n'), content: 'updated\n', env } };
}

test('conflict returns the current raw-byte hash and text without changing the file', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, 'newer é\r\n');
  await assert.rejects(writeMemory(f.settings), error => {
    assert.equal(error.code, 'MEMORY_CONFLICT');
    assert.deepEqual(error.current, { text: 'newer é\r\n', sha256: digest(fs.readFileSync(f.file)) });
    return true;
  });
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'newer é\r\n');
  assert.deepEqual(fs.readdirSync(f.memory), ['identity.md']);
});

test('invalid paths and non-files are rejected before locking', async t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'note.md'), 'outside');
  fs.symlinkSync(outside, path.join(f.memory, 'linked-dir'));
  fs.symlinkSync(path.join(outside, 'note.md'), path.join(f.memory, 'linked-file.md'));
  fs.mkdirSync(path.join(f.memory, 'directory'));
  const cases = ['', '../outside/note.md', 'a/../identity.md', '/etc/passwd', 'C:\\outside',
    'C:/outside', 'C:', 'a\\identity.md', 'a//identity.md', './identity.md', 'identity.md\0',
    'linked-dir/note.md', 'linked-file.md', 'missing.md', 'directory'];
  for (const value of cases) {
    await assert.rejects(writeMemory({ ...f.settings, path: value }), error => ['INVALID_MEMORY_PATH', 'MEMORY_FILE_NOT_FOUND'].includes(error.code), value);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'note.md'), 'utf8'), 'outside');
  assert.equal(fs.existsSync(path.join(f.env.ZYLOS_DIR, 'activity-monitor')), false);
});

test('write and rename failures leave the original and remove temporary files', async t => {
  const f = fixture(t);
  for (const method of ['writeFileSync', 'renameSync']) {
    const io = { ...fs, [method]() { throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' }); } };
    await assert.rejects(writeMemory(f.settings, { io }), { code: 'EIO' });
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
    assert.deepEqual(fs.readdirSync(f.memory), ['identity.md']);
  }
});

test('shared file edits serialize with the dream writer under its existing lock', async t => {
  const f = fixture(t);
  await withMemoryLock(dreamRunDirectory(f.env.ZYLOS_DIR), async () => {
    await assert.rejects(writeMemory({ ...f.settings, waitMs: 80 }), { code: 'LOCK_TIMEOUT' });
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
  });
  await writeMemory(f.settings);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'updated\n');
});

const projectHeader = [
  '# Current project',
  '<!-- zylos:entry kind=projects -->',
  '- **Status:** paused',
  '- **Updated:** 2026-11-10',
  '- **Description:** Keep this current description.',
];

test('append merges existing Keys and Moved from in order without changing other header or body bytes', async t => {
  const f = fixture(t);
  const original = [...projectHeader,
    '- **Keys:** alpha, beta, alpha',
    '- **Moved from:** old A, old B, old A',
    '- **Importance:** high',
    '', 'Existing body é.', '- **Keys:** body-only', '',
  ].join('\n');
  const paragraph = '\n## 整理补充（2026-11-12）\n- Appended fact.\n';
  fs.writeFileSync(f.file, original);
  fs.chmodSync(f.file, 0o640);
  const result = await appendMemory({ path: 'identity.md', keys: 'beta, gamma, gamma',
    movedFrom: 'old B, old C, old C', content: paragraph, env: f.env });
  const expected = [...projectHeader,
    '- **Keys:** alpha, beta, gamma',
    '- **Moved from:** old A, old B, old C',
    '- **Importance:** high',
    '', 'Existing body é.', '- **Keys:** body-only', '',
  ].join('\n') + paragraph;
  assert.equal(fs.readFileSync(f.file, 'utf8'), expected);
  assert.deepEqual(result, { path: 'identity.md', sha256: digest(expected) });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(f.memory), ['identity.md']);
});

test('concurrent append and hash-checked write preserve both contributions with conflict retry when needed', async t => {
  const f = fixture(t);
  const original = [...projectHeader, '', 'Original body.', ''].join('\n');
  fs.writeFileSync(f.file, original);
  const [append, write] = await Promise.allSettled([
    appendMemory({ path: 'identity.md', content: 'worker supplement\n', env: f.env }),
    writeMemory({ path: 'identity.md', sha256: digest(original), content: original + 'editor contribution\n', env: f.env }),
  ]);
  assert.equal(append.status, 'fulfilled', append.reason?.message);
  if (write.status === 'rejected') {
    assert.equal(write.reason.code, 'MEMORY_CONFLICT');
    const bytes = fs.readFileSync(f.file);
    const current = { text: bytes.toString('utf8'), sha256: digest(bytes) };
    await writeMemory({ path: 'identity.md', sha256: current.sha256,
      content: current.text + 'editor contribution\n', env: f.env });
  }
  const actual = fs.readFileSync(f.file, 'utf8');
  assert.ok(actual === original + 'worker supplement\neditor contribution\n' ||
    actual === original + 'editor contribution\nworker supplement\n', actual);
});
