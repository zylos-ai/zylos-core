import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { smartSync, formatMergeResult } from '../cli/lib/smart-merge.js';
import { generateManifest, saveManifest, saveOriginals } from '../cli/lib/manifest.js';

let tmpRoot;

function mkTmp() {
  return fs.mkdtempSync(path.join(tmpRoot, 'test-'));
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function readFile(dir, relPath) {
  return fs.readFileSync(path.join(dir, relPath), 'utf8');
}

function fileExists(dir, relPath) {
  return fs.existsSync(path.join(dir, relPath));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('smartSync', () => {
  test('new file: added to dest', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(src, 'newfile.js', 'new content');

    const result = smartSync(src, dest);
    expect(result.added).toContain('newfile.js');
    expect(readFile(dest, 'newfile.js')).toBe('new content');
  });

  test('no manifest: overwrite all files', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(dest, 'a.js', 'old');
    writeFile(src, 'a.js', 'new');

    const result = smartSync(src, dest);
    expect(result.overwritten).toContain('a.js');
    expect(readFile(dest, 'a.js')).toBe('new');
  });

  test('local unmodified + new changed: overwrite', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install: write file, save manifest
    writeFile(dest, 'a.js', 'original');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    // New version has changes
    writeFile(src, 'a.js', 'updated');

    const result = smartSync(src, dest);
    expect(result.overwritten).toContain('a.js');
    expect(readFile(dest, 'a.js')).toBe('updated');
  });

  test('local modified + new unchanged: keep local', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install
    writeFile(dest, 'a.js', 'original');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    // User modified locally
    writeFile(dest, 'a.js', 'user modified');

    // New version same as original (no upstream change)
    writeFile(src, 'a.js', 'original');

    const result = smartSync(src, dest);
    expect(result.kept).toContain('a.js');
    expect(readFile(dest, 'a.js')).toBe('user modified');
  });

  test('both changed different sections: clean merge via diff3', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Original version
    const originalContent = 'line1\nline2\nline3\nline4\nline5\n';
    writeFile(dest, 'a.js', originalContent);
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);
    saveOriginals(dest, dest); // Save originals for three-way merge base

    // User modifies line 2
    writeFile(dest, 'a.js', 'line1\nuser-modified\nline3\nline4\nline5\n');

    // New version modifies line 5
    writeFile(src, 'a.js', 'line1\nline2\nline3\nline4\nupstream-modified\n');

    const result = smartSync(src, dest);
    expect(result.merged).toContain('a.js');

    const merged = readFile(dest, 'a.js');
    expect(merged).toContain('user-modified');
    expect(merged).toContain('upstream-modified');
  });

  test('both changed same line: conflict — overwrite + backup', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const backupDir = mkTmp();

    // Original version
    writeFile(dest, 'a.js', 'line1\noriginal\nline3\n');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);
    saveOriginals(dest, dest);

    // User modifies same line
    writeFile(dest, 'a.js', 'line1\nuser-version\nline3\n');

    // New version also modifies same line
    writeFile(src, 'a.js', 'line1\nupstream-version\nline3\n');

    const result = smartSync(src, dest, { backupDir });
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].file).toBe('a.js');

    // New version should win
    expect(readFile(dest, 'a.js')).toBe('line1\nupstream-version\nline3\n');

    // Backup should have user's version
    expect(readFile(backupDir, 'a.js')).toBe('line1\nuser-version\nline3\n');
  });

  test('neither changed: no action', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(dest, 'a.js', 'same');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    writeFile(src, 'a.js', 'same');

    const result = smartSync(src, dest);
    expect(result.overwritten.length).toBe(0);
    expect(result.kept.length).toBe(0);
    expect(result.merged.length).toBe(0);
    expect(result.conflicts.length).toBe(0);
    expect(result.added.length).toBe(0);
  });

  test('creates subdirectories for new files', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(src, 'sub/dir/file.js', 'content');

    const result = smartSync(src, dest);
    expect(result.added).toContain('sub/dir/file.js');
    expect(readFile(dest, 'sub/dir/file.js')).toBe('content');
  });

  test('deletes files removed in new version', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install with two files
    writeFile(dest, 'a.js', 'keep');
    writeFile(dest, 'removed.js', 'to be removed');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    // New version only has a.js (removed.js is gone)
    writeFile(src, 'a.js', 'keep');

    const result = smartSync(src, dest);
    expect(result.deleted).toContain('removed.js');
    expect(fileExists(dest, 'removed.js')).toBe(false);
    expect(fileExists(dest, 'a.js')).toBe(true);
  });

  test('deletes files in subdirectories and cleans up empty dirs', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install with file in subdir
    writeFile(dest, 'a.js', 'keep');
    writeFile(dest, 'sub/removed.js', 'to be removed');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    // New version only has a.js
    writeFile(src, 'a.js', 'keep');

    const result = smartSync(src, dest);
    expect(result.deleted).toContain('sub/removed.js');
    expect(fileExists(dest, 'sub/removed.js')).toBe(false);
    // Empty parent directory should be cleaned up
    expect(fs.existsSync(path.join(dest, 'sub'))).toBe(false);
  });

  test('preserves user-added files not in old manifest', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install with only a.js
    writeFile(dest, 'a.js', 'original');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    // User adds custom.js (not in old manifest)
    writeFile(dest, 'custom.js', 'user file');

    // New version still only has a.js
    writeFile(src, 'a.js', 'original');

    const result = smartSync(src, dest);
    // User-added file should be preserved (not deleted)
    expect(result.deleted).not.toContain('custom.js');
    expect(fileExists(dest, 'custom.js')).toBe(true);
  });

  test('user-added file collision: conflict + backup', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const backupDir = mkTmp();

    // Simulate previous install with only a.js
    writeFile(dest, 'a.js', 'original');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    // User adds b.js (not in old manifest)
    writeFile(dest, 'b.js', 'user version');

    // New version also has b.js
    writeFile(src, 'a.js', 'original');
    writeFile(src, 'b.js', 'upstream version');

    const result = smartSync(src, dest, { backupDir });
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].file).toBe('b.js');

    // New version should win
    expect(readFile(dest, 'b.js')).toBe('upstream version');

    // User's version should be backed up
    expect(readFile(backupDir, 'b.js')).toBe('user version');
  });

  test('updates manifest after sync', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(src, 'a.js', 'new content');

    smartSync(src, dest);

    // Manifest should exist and reflect current state
    const manifestPath = path.join(dest, '.zylos', 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.files['a.js']).toBeTruthy();
  });

  test('saves originals after sync', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(src, 'a.js', 'source content');

    smartSync(src, dest);

    // Originals should be saved
    const originalsPath = path.join(dest, '.zylos', 'originals', 'a.js');
    expect(fs.existsSync(originalsPath)).toBe(true);
    expect(fs.readFileSync(originalsPath, 'utf8')).toBe('source content');
  });
});

describe('smartSync mode: overwrite', () => {
  test('overwrite mode: overwrites locally modified files', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install
    writeFile(dest, 'a.js', 'original');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    // User modified locally
    writeFile(dest, 'a.js', 'user modified');

    // New version has changes
    writeFile(src, 'a.js', 'upstream version');

    const result = smartSync(src, dest, { mode: 'overwrite' });
    expect(result.overwritten).toContain('a.js');
    expect(result.kept.length).toBe(0);
    expect(readFile(dest, 'a.js')).toBe('upstream version');
  });

  test('overwrite mode: still adds new files', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(src, 'new.js', 'new content');

    const result = smartSync(src, dest, { mode: 'overwrite' });
    expect(result.added).toContain('new.js');
    expect(readFile(dest, 'new.js')).toBe('new content');
  });

  test('overwrite mode: still deletes removed files', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(dest, 'a.js', 'keep');
    writeFile(dest, 'removed.js', 'to be removed');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    writeFile(src, 'a.js', 'keep');

    const result = smartSync(src, dest, { mode: 'overwrite' });
    expect(result.deleted).toContain('removed.js');
    expect(fileExists(dest, 'removed.js')).toBe(false);
  });

  test('overwrite mode: no conflicts or merges', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Both sides changed — in merge mode this would be a conflict
    writeFile(dest, 'a.js', 'original');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);
    saveOriginals(dest, dest);

    writeFile(dest, 'a.js', 'user version');
    writeFile(src, 'a.js', 'upstream version');

    const result = smartSync(src, dest, { mode: 'overwrite' });
    expect(result.overwritten).toContain('a.js');
    expect(result.conflicts.length).toBe(0);
    expect(result.merged.length).toBe(0);
    expect(result.kept.length).toBe(0);
    expect(readFile(dest, 'a.js')).toBe('upstream version');
  });
});

describe('formatMergeResult', () => {
  test('formats all categories', () => {
    const result = {
      overwritten: ['a.js'],
      kept: ['b.js', 'c.js'],
      merged: ['d.js'],
      conflicts: [{ file: 'e.js', backupPath: '/tmp/e.js' }],
      added: ['f.js'],
      deleted: ['g.js'],
      errors: ['something failed'],
    };
    const formatted = formatMergeResult(result);
    expect(formatted).toContain('1 overwritten');
    expect(formatted).toContain('2 kept');
    expect(formatted).toContain('1 merged');
    expect(formatted).toContain('1 conflicts');
    expect(formatted).toContain('1 added');
    expect(formatted).toContain('1 deleted');
    expect(formatted).toContain('1 errors');
  });

  test('returns "no changes" for empty result', () => {
    const result = {
      overwritten: [],
      kept: [],
      merged: [],
      conflicts: [],
      added: [],
      deleted: [],
      errors: [],
    };
    expect(formatMergeResult(result)).toBe('no changes');
  });
});
