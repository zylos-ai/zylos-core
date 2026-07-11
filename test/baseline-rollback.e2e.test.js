/**
 * E2E fault injection for the #715 R3 review P2: a smartSync baseline failure
 * followed by the REAL component rollback (cli/lib/upgrade.js rollback(), which
 * restores business files but excludes .zylos), then a retry.
 *
 * Contract under test — the baseline transaction's caller-visible semantics
 * must stay consistent with the outer rollback:
 *   - caller-visible FAILURE  ⟺ the live manifest did NOT advance, so rolling
 *     business files back yields a coherent old-generation state;
 *   - caller-visible SUCCESS  ⟺ business files carry the new version, so no
 *     rollback is triggered against an advanced manifest.
 * Either way a retry must genuinely apply the new version — never report
 * success while silently keeping old file content ("fake kept" success).
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { smartSync } from '../cli/lib/smart-merge.js';
import { generateManifest, saveManifest, saveOriginals, loadManifest, hashFile, snapshotMergeBaseline } from '../cli/lib/manifest.js';
import { copyTree } from '../cli/lib/fs-utils.js';
import { rollback } from '../cli/lib/upgrade.js';

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

/** Installed component at v1 with a committed v1 baseline (manifest + originals). */
function setupInstalledV1(dest) {
  writeFile(dest, 'a.js', 'v1');
  saveManifest(dest, generateManifest(dest));
  saveOriginals(dest, dest);
}

/** Same backup the upgrade pipeline's step2 takes before smart merge. */
function takeUpgradeBackup(dest) {
  const backupDir = path.join(mkTmp(), 'backup');
  copyTree(dest, backupDir, { excludes: ['node_modules', '.backup', '.zylos'] });
  // Since the R5 rework, step2 also snapshots the (canonicalized) baseline
  // into the backup's .zylos slot so rollback restores metadata together
  // with the files; a snapshotless backup would make rollback remove the
  // baseline as unknowable (see upgrade.js rollback()).
  snapshotMergeBaseline(dest, path.join(backupDir, '.zylos'));
  return backupDir;
}

/** The real component rollback, as the upgrade pipeline invokes it on step failure. */
function runRealRollback(backupDir, dest) {
  const results = rollback({ backupDir, skillDir: dest, serviceWasRunning: false });
  const restore = results.find(r => r.action === 'restore_files');
  expect(restore).toBeDefined();
  expect(restore.success).toBe(true);
  return results;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-baseline-rb-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('smartSync failure → real component rollback → retry (#715 R3 P2)', () => {
  test('post-commit originals-swap failure: failure semantics match rollback; retry really applies v2', () => {
    const dest = mkTmp();
    const srcV2 = mkTmp();
    setupInstalledV1(dest);
    const manifestV1Bytes = fs.readFileSync(path.join(dest, '.zylos', 'manifest.json'), 'utf8');

    writeFile(srcV2, 'a.js', 'v2');
    const v2Hash = hashFile(path.join(srcV2, 'a.js'));

    const backupDir = takeUpgradeBackup(dest);

    // Fault injection: the originals swap (originals.new → originals) fails
    // with EIO AFTER the manifest commit rename
    const realRename = fs.renameSync;
    fs.renameSync = (src, dst) => {
      if (String(src).endsWith('originals.new')) {
        const err = new Error('EIO: injected originals swap failure');
        err.code = 'EIO';
        throw err;
      }
      return realRename(src, dst);
    };
    let first;
    try {
      first = smartSync(srcV2, dest);
    } finally {
      fs.renameSync = realRename;
    }

    if (first.errors.length > 0) {
      // Caller-visible failure ⟹ the live manifest must NOT have advanced —
      // that is what makes the outer rollback (which excludes .zylos) land on
      // a coherent old-generation state instead of files@v1 + metadata@v2
      expect(fs.readFileSync(path.join(dest, '.zylos', 'manifest.json'), 'utf8')).toBe(manifestV1Bytes);

      // The real rollback the upgrade pipeline runs on step failure
      runRealRollback(backupDir, dest);
      expect(readFile(dest, 'a.js')).toBe('v1');
    } else {
      // Caller-visible success ⟹ business files must already carry v2; the
      // pipeline performs no rollback on success, so nothing may diverge
      expect(readFile(dest, 'a.js')).toBe('v2');
    }

    // Retry with the fault gone — must genuinely apply v2, not report success
    // while keeping v1 content ("fake kept")
    const retry = smartSync(srcV2, dest);
    expect(retry.errors).toEqual([]);
    expect(retry.kept).not.toContain('a.js');
    expect(readFile(dest, 'a.js')).toBe('v2');

    // Baseline converged to v2 with no stale transaction artifacts
    expect(loadManifest(dest).files['a.js']).toBe(v2Hash);
    expect(readFile(dest, '.zylos/originals/a.js')).toBe('v2');
    expect(fs.existsSync(path.join(dest, '.zylos', 'manifest.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(dest, '.zylos', 'originals.new'))).toBe(false);
  });

  test('pre-commit failure: manifest unchanged, rollback restores v1 files, retry applies v2 for real', () => {
    const dest = mkTmp();
    const srcV2 = mkTmp();
    setupInstalledV1(dest);
    const manifestV1Bytes = fs.readFileSync(path.join(dest, '.zylos', 'manifest.json'), 'utf8');

    writeFile(srcV2, 'a.js', 'v2');
    const v2Hash = hashFile(path.join(srcV2, 'a.js'));

    const backupDir = takeUpgradeBackup(dest);

    // Fault injection: the manifest COMMIT rename itself fails — the latest
    // possible pre-commit failure point
    const realRename = fs.renameSync;
    fs.renameSync = (src, dst) => {
      if (String(src).endsWith('manifest.json.tmp')) {
        const err = new Error('EIO: injected commit failure');
        err.code = 'EIO';
        throw err;
      }
      return realRename(src, dst);
    };
    let first;
    try {
      first = smartSync(srcV2, dest);
    } finally {
      fs.renameSync = realRename;
    }

    // The sync reported failure, business files were already rewritten to v2
    // by the merge pass, and the metadata did not advance (assertion ①)
    expect(first.errors.length).toBeGreaterThan(0);
    expect(readFile(dest, 'a.js')).toBe('v2');
    expect(fs.readFileSync(path.join(dest, '.zylos', 'manifest.json'), 'utf8')).toBe(manifestV1Bytes);
    expect(fs.existsSync(path.join(dest, '.zylos', 'manifest.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(dest, '.zylos', 'originals.new'))).toBe(false);

    // Real rollback restores the v1 business files (assertion ②) — .zylos is
    // excluded, which is exactly why the manifest must not have advanced
    runRealRollback(backupDir, dest);
    expect(readFile(dest, 'a.js')).toBe('v1');
    expect(readFile(dest, '.zylos/originals/a.js')).toBe('v1');

    // Retry with the fault gone: v2 must be truly applied — overwritten, not
    // "kept" as a phantom local modification (assertion ③)
    const retry = smartSync(srcV2, dest);
    expect(retry.errors).toEqual([]);
    expect(retry.kept).toEqual([]);
    expect(retry.overwritten).toContain('a.js');
    expect(readFile(dest, 'a.js')).toBe('v2');
    expect(loadManifest(dest).files['a.js']).toBe(v2Hash);
    expect(readFile(dest, '.zylos/originals/a.js')).toBe('v2');
  });
});
