import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installMemoryScripts, memoryTestEnv, memoryTempRoot } from './fixtures/memory-installation.js';
import { MemoryBrowser } from '../src/lib/memory-browser.js';

function makeZylosDir() {
  const zylosDir = memoryTempRoot('wbr-');
  fs.mkdirSync(path.join(zylosDir, 'memory', 'reference'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, 'memory', 'identity.md'), '# Identity\n');
  fs.writeFileSync(path.join(zylosDir, 'memory', 'reference', 'projects.md'), '# Projects\n');
  fs.mkdirSync(path.join(zylosDir, 'memory', '.git'), { recursive: true });
  try {
    fs.symlinkSync(os.tmpdir(), path.join(zylosDir, 'memory', 'escape-link'));
  } catch {
    // Some platforms disallow symlinks in temp dirs.
  }
  installMemoryScripts(zylosDir);
  return zylosDir;
}

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
    const browser = new MemoryBrowser({ zylosDir, env: memoryTestEnv(zylosDir) });

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

// Integration: changed memory-save transport and file publication require this case; read-only UI changes may skip it.

// Integration: changed Core conflict mapping requires this case; read-only UI changes may skip it.
test('memory writeFile rejects stale hashes and leaves file unchanged', async () => {
  const zylosDir = makeZylosDir();
  try {
    const memoryDir = path.join(zylosDir, 'memory');
    const browser = new MemoryBrowser({ zylosDir, env: memoryTestEnv(zylosDir) });
    const before = await browser.file('identity.md');
    fs.writeFileSync(path.join(memoryDir, 'identity.md'), '# Identity\nExternal\n');
    const current = await browser.file('identity.md');

    await assert.rejects(
      () => browser.writeFile('identity.md', { text: '# Mine\n', sha256: before.sha256 }),
      (err) => {
        assert.equal(err.code, 'memory_conflict');
        assert.equal(err.status, 409);
        assert.equal(err.current.sha256, current.sha256);
        assert.equal(err.current.text, '# Identity\nExternal\n');
        return true;
      }
    );
    assert.equal(fs.readFileSync(path.join(memoryDir, 'identity.md'), 'utf8'), '# Identity\nExternal\n');
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});
