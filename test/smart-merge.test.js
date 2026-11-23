import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { smartSync } from '../cli/lib/smart-merge.js';
import { generateManifest, saveManifest, saveOriginals, saveMergeBaseline, loadManifest, hashFile } from '../cli/lib/manifest.js';

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
    assert.ok(result.overwritten.includes('a.js'));
    assert.equal(readFile(dest, 'a.js'), 'updated');
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
    assert.ok(result.kept.includes('a.js'));
    assert.equal(readFile(dest, 'a.js'), 'user modified');
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
    assert.ok(result.merged.includes('a.js'));

    const merged = readFile(dest, 'a.js');
    assert.ok(merged.includes('user-modified'));
    assert.ok(merged.includes('upstream-modified'));
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
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].file, 'a.js');

    // New version should win
    assert.equal(readFile(dest, 'a.js'), 'line1\nupstream-version\nline3\n');

    // Backup should have user's version
    assert.equal(readFile(backupDir, 'a.js'), 'line1\nuser-version\nline3\n');
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
    assert.ok(result.deleted.includes('removed.js'));
    assert.equal(fileExists(dest, 'removed.js'), false);
    assert.equal(fileExists(dest, 'a.js'), true);
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
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].file, 'b.js');

    // New version should win
    assert.equal(readFile(dest, 'b.js'), 'upstream version');

    // User's version should be backed up
    assert.equal(readFile(backupDir, 'b.js'), 'user version');
  });

});

describe('smartSync manifest authority', () => {
  test('user-added file survives two sync rounds and never enters the manifest', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install with only a.js
    writeFile(dest, 'a.js', 'original');
    saveManifest(dest, generateManifest(dest));

    // User adds a file the package never shipped
    writeFile(dest, 'custom.js', 'user data');

    // Package still ships only a.js
    writeFile(src, 'a.js', 'original');

    // Round 1: user file untouched and NOT absorbed into the manifest
    const first = smartSync(src, dest);
    saveMergeBaseline(dest, src, first.nextManifest);
    assert.equal(fileExists(dest, 'custom.js'), true);
    assert.equal(loadManifest(dest).files['custom.js'], undefined);

    // Round 2: a dest-scan manifest would now list custom.js as "upstream-removed"
    const result = smartSync(src, dest);
    assert.ok(!result.deleted.includes('custom.js'));
    assert.equal(fileExists(dest, 'custom.js'), true);
    assert.equal(readFile(dest, 'custom.js'), 'user data');
    assert.equal(loadManifest(dest).files['custom.js'], undefined);
  });

  test('kept local modification is not rolled back by a later sync; manifest records source hash', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install
    writeFile(dest, 'a.js', 'original');
    saveManifest(dest, generateManifest(dest));

    // User modifies locally; upstream unchanged
    writeFile(dest, 'a.js', 'user modified');
    writeFile(src, 'a.js', 'original');

    // Sync 2: local kept, manifest must record the SOURCE hash, not the local hash
    const result2 = smartSync(src, dest);
    assert.ok(result2.kept.includes('a.js'));
    assert.equal(result2.nextManifest.files['a.js'], hashFile(path.join(src, 'a.js')));
    saveMergeBaseline(dest, src, result2.nextManifest);

    // Sync 3: with a dest-scan manifest the local mod would look unmodified and
    // the (unchanged) upstream would look new — silently rolling the user back
    const result3 = smartSync(src, dest);
    assert.ok(result3.kept.includes('a.js'));
    assert.ok(!result3.overwritten.includes('a.js'));
    assert.equal(readFile(dest, 'a.js'), 'user modified');
  });

  test('upstream-deleted + locally-modified file is preserved and backed up; unmodified one still deleted', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const backupDir = mkTmp();

    // Simulate previous install with three files
    writeFile(dest, 'a.js', 'keep');
    writeFile(dest, 'modified-then-removed.js', 'original');
    writeFile(dest, 'clean-then-removed.js', 'untouched');
    saveManifest(dest, generateManifest(dest));

    // User modifies one of the files upstream is about to remove
    writeFile(dest, 'modified-then-removed.js', 'user changes');

    // New version only ships a.js
    writeFile(src, 'a.js', 'keep');

    const result = smartSync(src, dest, { backupDir });

    // Locally-modified file: preserved in place + backed up, not deleted
    assert.ok(result.preserved.includes('modified-then-removed.js'));
    assert.ok(!result.deleted.includes('modified-then-removed.js'));
    assert.equal(readFile(dest, 'modified-then-removed.js'), 'user changes');
    assert.equal(readFile(backupDir, 'modified-then-removed.js'), 'user changes');

    // Unmodified file: still deleted as before
    assert.ok(result.deleted.includes('clean-then-removed.js'));
    assert.equal(fileExists(dest, 'clean-then-removed.js'), false);

    // Neither appears in the new manifest
    const manifest = result.nextManifest;
    assert.equal(manifest.files['modified-then-removed.js'], undefined);
    assert.equal(manifest.files['clean-then-removed.js'], undefined);
  });

  test('crash after legacy originals staging: next sync recovers before merging', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Previous install with originals v1 (three-way merge base)
    writeFile(dest, 'a.js', 'line1\nline2\nline3\nline4\nline5\n');
    saveManifest(dest, generateManifest(dest));
    saveOriginals(dest, dest);

    // Simulate a crash mid-transaction: originals were moved aside and never
    // restored (the legacy .bak staging scheme)
    fs.renameSync(
      path.join(dest, '.zylos', 'originals'),
      path.join(dest, '.zylos', 'originals.bak')
    );

    // User edit + upstream edit on different lines — clean-mergeable, but only
    // if the originals are recovered before the merge logic reads them
    writeFile(dest, 'a.js', 'line1\nuser-modified\nline3\nline4\nline5\n');
    writeFile(src, 'a.js', 'line1\nline2\nline3\nline4\nupstream-modified\n');

    const result = smartSync(src, dest);
    assert.ok(result.merged.includes('a.js'));
    assert.deepEqual(result.conflicts, []);
    assert.ok(readFile(dest, 'a.js').includes('user-modified'));
    assert.ok(readFile(dest, 'a.js').includes('upstream-modified'));
    assert.equal(fs.existsSync(path.join(dest, '.zylos', 'originals.bak')), false);
  });

  test('sync with errors keeps the previous manifest and originals', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install
    writeFile(dest, 'a.js', 'original');
    saveManifest(dest, generateManifest(dest));
    const manifestBefore = JSON.stringify(loadManifest(dest));

    // Make the destination file unwritable so the overwrite fails
    fs.chmodSync(path.join(dest, 'a.js'), 0o444);
    writeFile(src, 'a.js', 'updated');

    const result = smartSync(src, dest);
    assert.ok(result.errors.length > 0);

    // Baseline untouched: manifest identical, no originals recorded
    assert.equal(JSON.stringify(loadManifest(dest)), manifestBefore);
    assert.equal(fs.existsSync(path.join(dest, '.zylos', 'originals')), false);
  });
});
