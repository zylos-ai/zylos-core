import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryBrowser, memoryErrorPayload, validateMemoryQueryPath } from '../src/lib/memory-browser.js';

function makeZylosDir() {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-memory-browser-test-'));
  fs.mkdirSync(path.join(zylosDir, 'memory', 'reference'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, 'memory', 'identity.md'), '# Identity\n');
  fs.writeFileSync(path.join(zylosDir, 'memory', 'reference', 'projects.md'), '# Projects\n');
  fs.mkdirSync(path.join(zylosDir, 'memory', '.git'), { recursive: true });
  try {
    fs.symlinkSync(os.tmpdir(), path.join(zylosDir, 'memory', 'escape-link'));
  } catch {
    // Some platforms disallow symlinks in temp dirs; the tree test still covers .git hiding.
  }
  return zylosDir;
}

test('memory tree returns navigation metadata without hashes or symlinks', async () => {
  const zylosDir = makeZylosDir();
  try {
    const browser = new MemoryBrowser({ zylosDir });
    const tree = await browser.tree();
    const serialized = JSON.stringify(tree);
    assert.equal(serialized.includes('.git'), false);
    assert.equal(serialized.includes('escape-link'), false);
    assert.equal(serialized.includes('sha256'), false);
    const identity = tree.root.children.find(node => node.name === 'identity.md');
    assert.equal(identity.type, 'file');
    assert.equal(identity.renderable, true);
    assert.equal(typeof identity.size_bytes, 'number');
    assert.equal(typeof identity.mtime, 'string');
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('memory file returns text metadata and rejects traversal, large, and binary files', async () => {
  const zylosDir = makeZylosDir();
  try {
    const memoryDir = path.join(zylosDir, 'memory');
    fs.writeFileSync(path.join(memoryDir, 'large.md'), Buffer.alloc(1024 * 1024 + 1, 'a'));
    fs.writeFileSync(path.join(memoryDir, 'binary.md'), Buffer.from([0xff, 0xfe, 0x00, 0x61]));
    try {
      fs.symlinkSync(path.join(memoryDir, 'identity.md'), path.join(memoryDir, 'identity-link.md'));
      fs.symlinkSync(path.join(memoryDir, 'reference'), path.join(memoryDir, 'reference-link'));
    } catch {
      // Some platforms disallow symlinks in temp dirs; other path checks still run.
    }
    const browser = new MemoryBrowser({ zylosDir });

    const file = await browser.file('identity.md');
    assert.equal(file.path, 'identity.md');
    assert.equal(file.markdown, true);
    assert.equal(file.text, '# Identity\n');
    assert.match(file.sha256, /^[a-f0-9]{64}$/);

    await assert.rejects(() => browser.file('../state.md'), /invalid_memory_path/);
    await assert.rejects(() => browser.file('/tmp/state.md'), /invalid_memory_path/);
    await assert.rejects(() => browser.file('reference/../../.env'), /invalid_memory_path/);
    await assert.rejects(() => browser.file('large.md'), (err) => err.code === 'memory_file_too_large' && err.status === 413);
    await assert.rejects(() => browser.file('binary.md'), (err) => err.code === 'unsupported_memory_file' && err.status === 415);
    if (fs.existsSync(path.join(memoryDir, 'identity-link.md'))) {
      await assert.rejects(() => browser.file('identity-link.md'), (err) => err.code === 'invalid_memory_path');
    }
    if (fs.existsSync(path.join(memoryDir, 'reference-link'))) {
      await assert.rejects(() => browser.file('reference-link/projects.md'), (err) => err.code === 'invalid_memory_path');
    }
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('memory writeFile saves existing text files with optimistic locking', async () => {
  const zylosDir = makeZylosDir();
  try {
    const memoryDir = path.join(zylosDir, 'memory');
    const browser = new MemoryBrowser({ zylosDir });
    const before = await browser.file('identity.md');

    const saved = await browser.writeFile('identity.md', {
      text: '# Identity\nUpdated\n',
      sha256: before.sha256
    });
    assert.equal(saved.path, 'identity.md');
    assert.equal(saved.text, '# Identity\nUpdated\n');
    assert.match(saved.sha256, /^[a-f0-9]{64}$/);
    assert.notEqual(saved.sha256, before.sha256);
    assert.equal(fs.readFileSync(path.join(memoryDir, 'identity.md'), 'utf8'), '# Identity\nUpdated\n');

    const after = await browser.file('identity.md');
    assert.equal(after.sha256, saved.sha256);
    assert.equal(after.text, saved.text);
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('memory writeFile rejects stale hashes and leaves file unchanged', async () => {
  const zylosDir = makeZylosDir();
  try {
    const memoryDir = path.join(zylosDir, 'memory');
    const browser = new MemoryBrowser({ zylosDir });
    const before = await browser.file('identity.md');
    fs.writeFileSync(path.join(memoryDir, 'identity.md'), '# Identity\nExternal\n');
    const current = await browser.file('identity.md');

    await assert.rejects(
      () => browser.writeFile('identity.md', { text: '# Mine\n', sha256: before.sha256 }),
      (err) => {
        assert.equal(err.code, 'memory_conflict');
        assert.equal(err.status, 409);
        assert.equal(err.current.sha256, current.sha256);
        assert.equal(Object.hasOwn(err.current, 'text'), false);
        return true;
      }
    );
    assert.equal(fs.readFileSync(path.join(memoryDir, 'identity.md'), 'utf8'), '# Identity\nExternal\n');
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('memory writeFile validates write body, supported file type, and size', async () => {
  const zylosDir = makeZylosDir();
  try {
    const memoryDir = path.join(zylosDir, 'memory');
    fs.writeFileSync(path.join(memoryDir, 'notes.bin'), 'plain text');
    const browser = new MemoryBrowser({ zylosDir });
    const before = await browser.file('identity.md');

    await assert.rejects(() => browser.writeFile('identity.md', { text: '# Bad\n', sha256: 'not-a-hash' }), (err) => err.code === 'invalid_memory_write');
    await assert.rejects(() => browser.writeFile('identity.md', { text: 'bad\u0000text', sha256: before.sha256 }), (err) => err.code === 'invalid_memory_write');
    await assert.rejects(() => browser.writeFile('identity.md', { text: 'a'.repeat(1024 * 1024 + 1), sha256: before.sha256 }), (err) => err.code === 'memory_file_too_large' && err.status === 413);
    await assert.rejects(() => browser.writeFile('missing.md', { text: '# Missing\n', sha256: before.sha256 }), (err) => err.code === 'memory_file_not_found' && err.status === 404);
    await assert.rejects(() => browser.writeFile('notes.bin', { text: 'updated', sha256: before.sha256 }), (err) => err.code === 'unsupported_memory_file' && err.status === 415);
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('memory git metadata uses validated relative paths and returns latest commit', async () => {
  const zylosDir = makeZylosDir();
  try {
    const memoryDir = path.join(zylosDir, 'memory');
    execFileSync('git', ['-C', memoryDir, 'init'], { stdio: 'ignore' });
    execFileSync('git', ['-C', memoryDir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', memoryDir, 'config', 'user.name', 'Test User']);
    execFileSync('git', ['-C', memoryDir, 'add', 'identity.md']);
    execFileSync('git', ['-C', memoryDir, 'commit', '-m', 'add identity'], { stdio: 'ignore' });

    const browser = new MemoryBrowser({ zylosDir });
    const result = await browser.git('identity.md');
    assert.equal(result.path, 'identity.md');
    assert.equal(result.commit.subject, 'add identity');
    assert.match(result.commit.hash, /^[a-f0-9]{40}$/);
    assert.match(result.commit.short_hash, /^[a-f0-9]+$/);
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('memory query path grammar allows nested query slashes but rejects unsafe paths', () => {
  assert.equal(validateMemoryQueryPath('reference/projects.md'), 'reference/projects.md');
  assert.throws(() => validateMemoryQueryPath('../state.md'), /invalid_memory_path/);
  assert.throws(() => validateMemoryQueryPath('reference/../../.env'), /invalid_memory_path/);
  assert.throws(() => validateMemoryQueryPath('C:\\secret.md'), /invalid_memory_path/);
  assert.throws(() => validateMemoryQueryPath('reference\\projects.md'), /invalid_memory_path/);
});

test('unexpected filesystem errors do not leak errno codes in API payloads', () => {
  const err = new Error('permission denied');
  err.code = 'EACCES';
  const payload = memoryErrorPayload(err);
  assert.equal(payload.status, 500);
  assert.deepEqual(payload.body, { error: 'memory_browser_failed' });
  assert.equal(JSON.stringify(payload.body).includes('EACCES'), false);
});

test('memory conflict payload includes current metadata without text', async () => {
  const current = {
    path: 'identity.md',
    name: 'identity.md',
    size_bytes: 12,
    mtime: new Date().toISOString(),
    sha256: 'a'.repeat(64),
    markdown: true
  };
  const err = new Error('memory_conflict');
  err.code = 'memory_conflict';
  err.status = 409;
  err.memoryBrowserError = true;
  err.current = current;

  const payload = memoryErrorPayload(err);
  assert.equal(payload.status, 409);
  assert.deepEqual(payload.body, { error: 'memory_conflict', current });
  assert.equal(JSON.stringify(payload.body).includes('"text"'), false);
});
