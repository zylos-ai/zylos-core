import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { smartSync, formatMergeResult } from '../cli/lib/smart-merge.js';
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
  test('new file: added to dest', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(src, 'newfile.js', 'new content');

    const result = smartSync(src, dest);
    assert.ok(result.added.includes('newfile.js'));
    assert.equal(readFile(dest, 'newfile.js'), 'new content');
  });

  test('no manifest: overwrite all files', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(dest, 'a.js', 'old');
    writeFile(src, 'a.js', 'new');

    const result = smartSync(src, dest);
    assert.ok(result.overwritten.includes('a.js'));
    assert.equal(readFile(dest, 'a.js'), 'new');
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

  test('neither changed: no action', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(dest, 'a.js', 'same');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    writeFile(src, 'a.js', 'same');

    const result = smartSync(src, dest);
    assert.equal(result.overwritten.length, 0);
    assert.equal(result.kept.length, 0);
    assert.equal(result.merged.length, 0);
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.added.length, 0);
  });

  test('creates subdirectories for new files', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(src, 'sub/dir/file.js', 'content');

    const result = smartSync(src, dest);
    assert.ok(result.added.includes('sub/dir/file.js'));
    assert.equal(readFile(dest, 'sub/dir/file.js'), 'content');
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
    assert.ok(result.deleted.includes('sub/removed.js'));
    assert.equal(fileExists(dest, 'sub/removed.js'), false);
    // Empty parent directory should be cleaned up
    assert.equal(fs.existsSync(path.join(dest, 'sub')), false);
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
    assert.ok(!result.deleted.includes('custom.js'));
    assert.equal(fileExists(dest, 'custom.js'), true);
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

  test('untracked manifest collision with identical content is unchanged, not a conflict', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const backupDir = mkTmp();

    writeFile(dest, 'a.js', 'tracked');
    saveManifest(dest, generateManifest(dest));

    writeFile(dest, 'same.js', 'byte-identical');
    writeFile(src, 'a.js', 'tracked');
    writeFile(src, 'same.js', 'byte-identical');

    fs.utimesSync(path.join(dest, 'same.js'), new Date(1000), new Date(1000));
    const before = fs.statSync(path.join(dest, 'same.js')).mtimeMs;
    const result = smartSync(src, dest, { backupDir });

    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(fs.readdirSync(backupDir), []);
    assert.equal(readFile(dest, 'same.js'), 'byte-identical');
    assert.equal(fs.statSync(path.join(dest, 'same.js')).mtimeMs, before);
  });

  test('returns the next manifest without committing it', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(src, 'a.js', 'new content');

    const result = smartSync(src, dest);

    // The transaction owner commits this candidate after later steps succeed.
    const manifestPath = path.join(dest, '.zylos', 'manifest.json');
    assert.equal(fs.existsSync(manifestPath), false);
    assert.ok(result.nextManifest.files['a.js']);
  });

  test('outer baseline commit saves originals after sync', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(src, 'a.js', 'source content');

    const result = smartSync(src, dest);
    saveMergeBaseline(dest, src, result.nextManifest);

    // Originals should be saved
    const originalsPath = path.join(dest, '.zylos', 'originals', 'a.js');
    assert.equal(fs.existsSync(originalsPath), true);
    assert.equal(fs.readFileSync(originalsPath, 'utf8'), 'source content');
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

  test('clean-merged local modification survives the next sync; manifest records source hash', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Original version with saved originals for three-way merge
    writeFile(dest, 'a.js', 'line1\nline2\nline3\nline4\nline5\n');
    saveManifest(dest, generateManifest(dest));
    saveOriginals(dest, dest);

    // User modifies line 2; upstream modifies line 5
    writeFile(dest, 'a.js', 'line1\nuser-modified\nline3\nline4\nline5\n');
    writeFile(src, 'a.js', 'line1\nline2\nline3\nline4\nupstream-modified\n');

    const result = smartSync(src, dest);
    assert.ok(result.merged.includes('a.js'));
    // Manifest records the package hash, so the merged delta stays "local"
    assert.equal(result.nextManifest.files['a.js'], hashFile(path.join(src, 'a.js')));
    saveMergeBaseline(dest, src, result.nextManifest);

    // Next sync with unchanged upstream must keep the merged content
    const result2 = smartSync(src, dest);
    assert.ok(result2.kept.includes('a.js'));
    assert.ok(!result2.overwritten.includes('a.js'));
    assert.ok(readFile(dest, 'a.js').includes('user-modified'));
    assert.ok(readFile(dest, 'a.js').includes('upstream-modified'));
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

  test('read-only manifest file does not block the atomic baseline commit', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install
    writeFile(dest, 'a.js', 'original');
    saveManifest(dest, generateManifest(dest));
    saveOriginals(dest, dest);

    writeFile(src, 'a.js', 'updated');

    // The live manifest must never be written in place — the commit is a
    // rename, which replaces a read-only file without opening it for write.
    // An in-place write here could truncate the manifest on I/O failure.
    fs.chmodSync(path.join(dest, '.zylos', 'manifest.json'), 0o444);

    const result = smartSync(src, dest);
    assert.deepEqual(result.errors, []);
    saveMergeBaseline(dest, src, result.nextManifest);
    assert.equal(loadManifest(dest).files['a.js'], hashFile(path.join(src, 'a.js')));
    assert.equal(readFile(dest, '.zylos/originals/a.js'), 'updated');
  });

  test('staging failure leaves the previous baseline pair untouched', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install with originals v1
    writeFile(dest, 'a.js', 'original');
    saveManifest(dest, generateManifest(dest));
    saveOriginals(dest, dest);
    const manifestBefore = fs.readFileSync(path.join(dest, '.zylos', 'manifest.json'), 'utf8');

    writeFile(src, 'a.js', 'updated');

    // Read-only .zylos: no staging file can be created — the baseline commit
    // must fail without touching either live piece
    fs.chmodSync(path.join(dest, '.zylos'), 0o555);

    const result = smartSync(src, dest);
    let commitError;
    try {
      saveMergeBaseline(dest, src, result.nextManifest);
    } catch (err) {
      commitError = err;
    }
    fs.chmodSync(path.join(dest, '.zylos'), 0o755);

    assert.deepEqual(result.errors, []);
    assert.notEqual(commitError, undefined);
    assert.equal(fs.readFileSync(path.join(dest, '.zylos', 'manifest.json'), 'utf8'), manifestBefore);
    assert.equal(readFile(dest, '.zylos/originals/a.js'), 'original');
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

  test('uncommitted staged transaction is rolled back, not absorbed', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Previous install
    writeFile(dest, 'a.js', 'original');
    saveManifest(dest, generateManifest(dest));
    saveOriginals(dest, dest);

    // Simulate a crash before the commit point: a staged manifest (bogus
    // content) and staged originals are still lying around
    writeFile(dest, '.zylos/manifest.json.tmp', '{"files":{"bogus.js":"deadbeef"}}');
    writeFile(dest, '.zylos/originals.new/bogus.js', 'staged junk');

    writeFile(src, 'a.js', 'original');
    const result = smartSync(src, dest);

    assert.deepEqual(result.errors, []);
    // The bogus staged manifest never became live; recovery produced a clean candidate.
    assert.equal(loadManifest(dest).files['bogus.js'], undefined);
    assert.equal(result.nextManifest.files['a.js'], hashFile(path.join(src, 'a.js')));
    // No stale transaction artifacts survive
    assert.equal(fs.existsSync(path.join(dest, '.zylos', 'manifest.json.tmp')), false);
    assert.equal(fs.existsSync(path.join(dest, '.zylos', 'originals.new')), false);
    assert.equal(readFile(dest, '.zylos/originals/a.js'), 'original');
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
    assert.ok(result.overwritten.includes('a.js'));
    assert.equal(result.kept.length, 0);
    assert.equal(readFile(dest, 'a.js'), 'upstream version');
  });

  test('overwrite mode: still adds new files', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(src, 'new.js', 'new content');

    const result = smartSync(src, dest, { mode: 'overwrite' });
    assert.ok(result.added.includes('new.js'));
    assert.equal(readFile(dest, 'new.js'), 'new content');
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
    assert.ok(result.deleted.includes('removed.js'));
    assert.equal(fileExists(dest, 'removed.js'), false);
  });

  test('overwrite mode: deletes upstream-removed file even with local modifications', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install with two files
    writeFile(dest, 'a.js', 'keep');
    writeFile(dest, 'removed.js', 'original');
    saveManifest(dest, generateManifest(dest));

    // User modifies the file upstream is about to remove
    writeFile(dest, 'removed.js', 'user changes');

    // New version only ships a.js
    writeFile(src, 'a.js', 'keep');

    const result = smartSync(src, dest, { mode: 'overwrite' });
    // Overwrite-all contract: no merge-mode preservation
    assert.ok(result.deleted.includes('removed.js'));
    assert.equal(result.preserved.length, 0);
    assert.equal(fileExists(dest, 'removed.js'), false);
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
    assert.ok(result.overwritten.includes('a.js'));
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.merged.length, 0);
    assert.equal(result.kept.length, 0);
    assert.equal(readFile(dest, 'a.js'), 'upstream version');
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
    assert.ok(formatted.includes('1 overwritten'));
    assert.ok(formatted.includes('2 kept'));
    assert.ok(formatted.includes('1 merged'));
    assert.ok(formatted.includes('1 conflicts'));
    assert.ok(formatted.includes('1 added'));
    assert.ok(formatted.includes('1 deleted'));
    assert.ok(formatted.includes('1 errors'));
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
    assert.equal(formatMergeResult(result), 'no changes');
  });
});
