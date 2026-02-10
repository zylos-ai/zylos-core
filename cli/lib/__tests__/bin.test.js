import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// We need to set ZYLOS_DIR before importing bin.js (it reads BIN_DIR from config at import time)
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-bin-test-'));
process.env.ZYLOS_DIR = tmpRoot;

const { linkBins, unlinkBins } = await import('../bin.js');
const { BIN_DIR } = await import('../config.js');

describe('linkBins', () => {
  let skillDir;

  beforeEach(() => {
    skillDir = path.join(tmpRoot, 'skills', `test-${Date.now()}`);
    fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });
    // Create a dummy CLI script
    fs.writeFileSync(path.join(skillDir, 'src', 'cli.js'), '#!/usr/bin/env node\nconsole.log("hello");\n');
  });

  afterEach(() => {
    // Clean up bin dir symlinks
    if (fs.existsSync(BIN_DIR)) {
      for (const entry of fs.readdirSync(BIN_DIR)) {
        try { fs.unlinkSync(path.join(BIN_DIR, entry)); } catch { /* ignore */ }
      }
    }
  });

  it('returns null for empty/undefined bin field', () => {
    assert.equal(linkBins(skillDir, undefined), null);
    assert.equal(linkBins(skillDir, null), null);
    assert.equal(linkBins(skillDir, {}), null);
  });

  it('returns null for non-object bin field', () => {
    assert.equal(linkBins(skillDir, 'not-an-object'), null);
    assert.equal(linkBins(skillDir, 42), null);
  });

  it('creates symlink for valid bin entry', () => {
    const result = linkBins(skillDir, { 'test-cmd': 'src/cli.js' });

    assert.ok(result);
    assert.ok(result['test-cmd']);
    assert.equal(result['test-cmd'], path.join(BIN_DIR, 'test-cmd'));

    // Verify symlink exists and points to correct target
    const linkTarget = fs.readlinkSync(path.join(BIN_DIR, 'test-cmd'));
    assert.equal(linkTarget, path.join(skillDir, 'src', 'cli.js'));
  });

  it('makes target executable', () => {
    // Start with non-executable
    fs.chmodSync(path.join(skillDir, 'src', 'cli.js'), 0o644);

    linkBins(skillDir, { 'test-cmd': 'src/cli.js' });

    const stat = fs.statSync(path.join(skillDir, 'src', 'cli.js'));
    // Check executable bit is set (owner)
    assert.ok(stat.mode & 0o100, 'Expected executable bit to be set');
  });

  it('handles multiple bin entries', () => {
    fs.writeFileSync(path.join(skillDir, 'src', 'other.js'), '#!/usr/bin/env node\n');

    const result = linkBins(skillDir, {
      'cmd-a': 'src/cli.js',
      'cmd-b': 'src/other.js',
    });

    assert.ok(result);
    assert.ok(result['cmd-a']);
    assert.ok(result['cmd-b']);
    assert.ok(fs.existsSync(path.join(BIN_DIR, 'cmd-a')));
    assert.ok(fs.existsSync(path.join(BIN_DIR, 'cmd-b')));
  });

  it('skips entries with missing target', () => {
    const result = linkBins(skillDir, {
      'good-cmd': 'src/cli.js',
      'bad-cmd': 'src/nonexistent.js',
    });

    assert.ok(result);
    assert.ok(result['good-cmd']);
    assert.equal(result['bad-cmd'], undefined);
  });

  it('returns null when all targets are missing', () => {
    const result = linkBins(skillDir, {
      'bad-a': 'missing-a.js',
      'bad-b': 'missing-b.js',
    });

    assert.equal(result, null);
  });

  it('overwrites existing symlink pointing elsewhere', () => {
    // Create a pre-existing symlink pointing somewhere else
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.symlinkSync('/tmp/old-target', path.join(BIN_DIR, 'test-cmd'));

    const result = linkBins(skillDir, { 'test-cmd': 'src/cli.js' });

    assert.ok(result);
    const linkTarget = fs.readlinkSync(path.join(BIN_DIR, 'test-cmd'));
    assert.equal(linkTarget, path.join(skillDir, 'src', 'cli.js'));
  });
});

describe('unlinkBins', () => {
  let binDir;

  beforeEach(() => {
    binDir = BIN_DIR;
    fs.mkdirSync(binDir, { recursive: true });
  });

  it('handles null/undefined gracefully', () => {
    // Should not throw
    unlinkBins(null);
    unlinkBins(undefined);
    unlinkBins({});
  });

  it('removes existing symlinks', () => {
    const linkPath = path.join(binDir, 'test-cmd');
    fs.symlinkSync('/tmp/some-target', linkPath);
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink());

    unlinkBins({ 'test-cmd': linkPath });

    // Symlink should be gone
    assert.throws(() => fs.lstatSync(linkPath), { code: 'ENOENT' });
  });

  it('ignores already-missing symlinks', () => {
    // Should not throw when path doesn't exist
    unlinkBins({ 'missing-cmd': path.join(binDir, 'nonexistent') });
  });

  it('does not remove regular files (safety check)', () => {
    const filePath = path.join(binDir, 'regular-file');
    fs.writeFileSync(filePath, 'not a symlink');

    unlinkBins({ 'regular-file': filePath });

    // Regular file should still exist
    assert.ok(fs.existsSync(filePath));

    // Cleanup
    fs.unlinkSync(filePath);
  });

  it('removes multiple symlinks', () => {
    const linkA = path.join(binDir, 'cmd-a');
    const linkB = path.join(binDir, 'cmd-b');
    fs.symlinkSync('/tmp/target-a', linkA);
    fs.symlinkSync('/tmp/target-b', linkB);

    unlinkBins({ 'cmd-a': linkA, 'cmd-b': linkB });

    assert.throws(() => fs.lstatSync(linkA), { code: 'ENOENT' });
    assert.throws(() => fs.lstatSync(linkB), { code: 'ENOENT' });
  });
});
