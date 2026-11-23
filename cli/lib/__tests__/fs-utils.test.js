import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tmpDirs = [];
const origHome = process.env.HOME;
const origTmpdir = process.env.TMPDIR;

const { syncTree } = await import('../fs-utils.js');

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = origHome;
  }
  if (origTmpdir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = origTmpdir;
  }
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function makeTmpDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-fs-utils-test-'));
  tmpDirs.push(tmpDir);
  return tmpDir;
}

describe('syncTree', () => {

  it('restores from a nested backup while preserving excluded directories', () => {
    const tmpDir = makeTmpDir();
    const destDir = path.join(tmpDir, 'skills', 'demo');
    const srcDir = path.join(destDir, '.backup', 'run-1');

    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(path.join(destDir, '.backup'), { recursive: true });
    fs.mkdirSync(path.join(destDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(destDir, '.zylos'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'SKILL.md'), 'old', 'utf8');
    fs.writeFileSync(path.join(destDir, 'SKILL.md'), 'broken', 'utf8');
    fs.writeFileSync(path.join(destDir, 'new-file.txt'), 'remove me', 'utf8');
    fs.writeFileSync(path.join(destDir, 'node_modules', 'keep.txt'), 'deps', 'utf8');
    fs.writeFileSync(path.join(destDir, '.zylos', 'manifest.json'), '{}', 'utf8');

    syncTree(srcDir, destDir, { excludes: ['node_modules', '.backup', '.zylos'] });

    assert.equal(fs.readFileSync(path.join(destDir, 'SKILL.md'), 'utf8'), 'old');
    assert.equal(fs.existsSync(path.join(destDir, 'new-file.txt')), false);
    assert.equal(fs.existsSync(path.join(destDir, '.backup', 'run-1', 'SKILL.md')), true);
    assert.equal(fs.readFileSync(path.join(destDir, 'node_modules', 'keep.txt'), 'utf8'), 'deps');
    assert.equal(fs.readFileSync(path.join(destDir, '.zylos', 'manifest.json'), 'utf8'), '{}');
  });
});

// Safe removal now rejects a destination entry that is itself a symlink.
// Exercise syncTree rather than only its shared deletion dependency.
it('syncTree refuses a linked destination entry without changing the linked directory', () => {
  const root = makeTmpDir();
  const src = path.join(root, 'source'), dest = path.join(root, 'destination'), outside = path.join(root, 'outside');
  for (const directory of [src, dest, outside]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside contents');
  fs.symlinkSync(outside, path.join(dest, 'linked'));
  assert.throws(() => syncTree(src, dest));
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside contents');
  assert.equal(fs.lstatSync(path.join(dest, 'linked')).isSymbolicLink(), true);
});
