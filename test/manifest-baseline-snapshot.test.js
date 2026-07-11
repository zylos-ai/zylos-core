/**
 * Unit tests for the baseline snapshot/restore helpers (#715 R5):
 * snapshotMergeBaseline / restoreMergeBaseline / removeMergeBaseline /
 * hasBaselineSnapshot.
 *
 * Contracts under test:
 *  - snapshot canonicalizes (recoverMergeBaseline) before copying, and fails
 *    loud — no snapshot accepted — when recovery fails or the live manifest
 *    is corrupt (never classified as 'absent').
 *  - restore is typed (pair / manifest-only / absent), owned by the manifest
 *    module, and fails loud on missing/torn/corrupt snapshots BEFORE touching
 *    the live site.
 *  - the pair restore reuses the saveMergeBaseline transaction — the live
 *    manifest only ever advances via the atomic rename.
 *  - manifest-only and absent branches are re-runnable: interrupted restores
 *    converge when run again; originals are never fabricated for legacy
 *    sites; only baseline-owned artifacts are removed.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateManifest,
  saveManifest,
  saveOriginals,
  loadManifest,
  snapshotMergeBaseline,
  restoreMergeBaseline,
  removeMergeBaseline,
  hasBaselineSnapshot,
} from '../cli/lib/manifest.js';

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

function exists(dir, relPath) {
  return fs.existsSync(path.join(dir, relPath));
}

/** Component with a committed v1 baseline pair. */
function setupPairV1(dest) {
  writeFile(dest, 'a.js', 'v1');
  saveManifest(dest, generateManifest(dest));
  saveOriginals(dest, dest);
}

/** Advance the component's files + baseline to v2 (as a step3 commit would). */
function commitV2(dest) {
  writeFile(dest, 'a.js', 'v2');
  saveManifest(dest, generateManifest(dest));
  saveOriginals(dest, dest);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-baseline-snap-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('snapshotMergeBaseline', () => {
  test('pair: snapshots manifest bytes + originals, state descriptor written', () => {
    const dest = mkTmp();
    setupPairV1(dest);
    const manifestBytes = readFile(dest, '.zylos/manifest.json');

    const snap = path.join(mkTmp(), 'snap');
    const { state } = snapshotMergeBaseline(dest, snap);

    expect(state).toBe('pair');
    expect(hasBaselineSnapshot(snap)).toBe(true);
    expect(readFile(snap, 'manifest.json')).toBe(manifestBytes);
    expect(readFile(snap, 'originals/a.js')).toBe('v1');
  });

  test('manifest-only (legacy): snapshots the manifest, no originals', () => {
    const dest = mkTmp();
    writeFile(dest, 'a.js', 'v1');
    saveManifest(dest, generateManifest(dest));

    const snap = path.join(mkTmp(), 'snap');
    const { state } = snapshotMergeBaseline(dest, snap);

    expect(state).toBe('manifest-only');
    expect(hasBaselineSnapshot(snap)).toBe(true);
    expect(exists(snap, 'manifest.json')).toBe(true);
    expect(exists(snap, 'originals')).toBe(false);
  });

  test('absent: records the absence, copies nothing', () => {
    const dest = mkTmp();
    writeFile(dest, 'a.js', 'v1');

    const snap = path.join(mkTmp(), 'snap');
    const { state } = snapshotMergeBaseline(dest, snap);

    expect(state).toBe('absent');
    expect(hasBaselineSnapshot(snap)).toBe(true);
    expect(exists(snap, 'manifest.json')).toBe(false);
    expect(exists(snap, 'originals')).toBe(false);
  });

  test('canonicalizes first: staged residue of an uncommitted transaction is discarded, not snapshotted', () => {
    const dest = mkTmp();
    setupPairV1(dest);
    const manifestV1Bytes = readFile(dest, '.zylos/manifest.json');
    // Interrupted-uncommitted leftovers: marker + staged originals
    writeFile(dest, '.zylos/manifest.json.tmp', '{"files":{},"generated_at":"staged"}');
    writeFile(dest, '.zylos/originals.new/a.js', 'v2-staged-uncommitted');

    const snap = path.join(mkTmp(), 'snap');
    const { state } = snapshotMergeBaseline(dest, snap);

    // Snapshot reflects the recovered (rolled-back) v1 pair
    expect(state).toBe('pair');
    expect(readFile(snap, 'manifest.json')).toBe(manifestV1Bytes);
    expect(readFile(snap, 'originals/a.js')).toBe('v1');
    // and the live site was canonicalized in the process
    expect(exists(dest, '.zylos/manifest.json.tmp')).toBe(false);
    expect(exists(dest, '.zylos/originals.new')).toBe(false);
  });

  test('recovery failure propagates — no snapshot is accepted', () => {
    const dest = mkTmp();
    setupPairV1(dest);
    // Unresolvable legacy state: originals drifted AND originals.bak matches neither
    writeFile(dest, '.zylos/originals/a.js', 'drifted');
    writeFile(dest, '.zylos/originals.bak/a.js', 'neither');

    const snap = path.join(mkTmp(), 'snap');
    expect(() => snapshotMergeBaseline(dest, snap)).toThrow(/manual inspection/);
    expect(hasBaselineSnapshot(snap)).toBe(false);
  });

  test('corrupt live manifest fails loud — never classified as absent', () => {
    const dest = mkTmp();
    writeFile(dest, 'a.js', 'v1');
    writeFile(dest, '.zylos/manifest.json', 'not json {{{');

    const snap = path.join(mkTmp(), 'snap');
    expect(() => snapshotMergeBaseline(dest, snap)).toThrow(/not valid JSON/);
    expect(hasBaselineSnapshot(snap)).toBe(false);
    // live site untouched
    expect(readFile(dest, '.zylos/manifest.json')).toBe('not json {{{');
  });
});

describe('restoreMergeBaseline: pair (atomic reuse of saveMergeBaseline)', () => {
  test('round-trips the v1 pair over a committed v2 pair, byte-identical manifest', () => {
    const dest = mkTmp();
    setupPairV1(dest);
    const manifestV1Bytes = readFile(dest, '.zylos/manifest.json');
    const snap = path.join(mkTmp(), 'snap');
    snapshotMergeBaseline(dest, snap);

    commitV2(dest);

    const { state } = restoreMergeBaseline(dest, snap);
    expect(state).toBe('pair');
    expect(readFile(dest, '.zylos/manifest.json')).toBe(manifestV1Bytes);
    expect(readFile(dest, '.zylos/originals/a.js')).toBe('v1');
    expect(exists(dest, '.zylos/manifest.json.tmp')).toBe(false);
    expect(exists(dest, '.zylos/originals.new')).toBe(false);
  });

  test('interrupted commit: live manifest did not advance; re-run converges', () => {
    const dest = mkTmp();
    setupPairV1(dest);
    const snap = path.join(mkTmp(), 'snap');
    snapshotMergeBaseline(dest, snap);

    commitV2(dest);
    const manifestV2Bytes = readFile(dest, '.zylos/manifest.json');

    // Inject failure at the atomic commit rename — the latest pre-commit point
    const realRename = fs.renameSync;
    fs.renameSync = (src, dst) => {
      if (String(src).endsWith('manifest.json.tmp')) {
        const err = new Error('EIO: injected commit failure');
        err.code = 'EIO';
        throw err;
      }
      return realRename(src, dst);
    };
    try {
      expect(() => restoreMergeBaseline(dest, snap)).toThrow(/EIO/);
    } finally {
      fs.renameSync = realRename;
    }

    // throw ⟺ live manifest did not advance (no non-atomic write path)
    expect(readFile(dest, '.zylos/manifest.json')).toBe(manifestV2Bytes);

    // Re-run with the fault gone converges to the snapshot generation
    const { state } = restoreMergeBaseline(dest, snap);
    expect(state).toBe('pair');
    expect(loadManifest(dest).files['a.js']).toBeDefined();
    expect(readFile(dest, '.zylos/originals/a.js')).toBe('v1');
    expect(exists(dest, '.zylos/manifest.json.tmp')).toBe(false);
    expect(exists(dest, '.zylos/originals.new')).toBe(false);
  });

  test('double-run is idempotent', () => {
    const dest = mkTmp();
    setupPairV1(dest);
    const manifestV1Bytes = readFile(dest, '.zylos/manifest.json');
    const snap = path.join(mkTmp(), 'snap');
    snapshotMergeBaseline(dest, snap);
    commitV2(dest);

    restoreMergeBaseline(dest, snap);
    restoreMergeBaseline(dest, snap);
    expect(readFile(dest, '.zylos/manifest.json')).toBe(manifestV1Bytes);
    expect(readFile(dest, '.zylos/originals/a.js')).toBe('v1');
  });
});

describe('restoreMergeBaseline: manifest-only (legacy)', () => {
  function setupLegacySnapshotThenV2(dest) {
    writeFile(dest, 'a.js', 'v1');
    saveManifest(dest, generateManifest(dest));
    const snap = path.join(mkTmp(), 'snap');
    snapshotMergeBaseline(dest, snap);
    commitV2(dest);
    return snap;
  }

  test('restores the old manifest bytes and removes originals — never fabricates a merge base', () => {
    const dest = mkTmp();
    const snap = setupLegacySnapshotThenV2(dest);
    const manifestV1Bytes = readFile(snap, 'manifest.json');

    const { state } = restoreMergeBaseline(dest, snap);
    expect(state).toBe('manifest-only');
    expect(readFile(dest, '.zylos/manifest.json')).toBe(manifestV1Bytes);
    expect(exists(dest, '.zylos/originals')).toBe(false);
    expect(exists(dest, '.zylos/manifest.json.tmp')).toBe(false);
  });

  test('interruption windows converge on re-run (marker staged / originals dropped / pre-rename)', () => {
    const dest = mkTmp();
    const snap = setupLegacySnapshotThenV2(dest);
    const manifestV1Bytes = readFile(snap, 'manifest.json');

    // Simulate a crash mid-restore: marker staged and originals already
    // dropped, commit rename never ran (worst intermediate state).
    writeFile(dest, '.zylos/manifest.json.tmp', manifestV1Bytes);
    fs.rmSync(path.join(dest, '.zylos', 'originals'), { recursive: true, force: true });

    const { state } = restoreMergeBaseline(dest, snap);
    expect(state).toBe('manifest-only');
    expect(readFile(dest, '.zylos/manifest.json')).toBe(manifestV1Bytes);
    expect(exists(dest, '.zylos/originals')).toBe(false);
    expect(exists(dest, '.zylos/manifest.json.tmp')).toBe(false);
  });

  test('injected rename failure: manifest not advanced, re-run converges', () => {
    const dest = mkTmp();
    const snap = setupLegacySnapshotThenV2(dest);
    const manifestV2Bytes = readFile(dest, '.zylos/manifest.json');
    const manifestV1Bytes = readFile(snap, 'manifest.json');

    const realRename = fs.renameSync;
    fs.renameSync = (src, dst) => {
      if (String(src).endsWith('manifest.json.tmp')) {
        const err = new Error('EIO: injected commit failure');
        err.code = 'EIO';
        throw err;
      }
      return realRename(src, dst);
    };
    try {
      expect(() => restoreMergeBaseline(dest, snap)).toThrow(/EIO/);
    } finally {
      fs.renameSync = realRename;
    }

    // Live manifest only ever advances via the rename
    expect(readFile(dest, '.zylos/manifest.json')).toBe(manifestV2Bytes);
    expect(exists(dest, '.zylos/manifest.json.tmp')).toBe(false);

    const { state } = restoreMergeBaseline(dest, snap);
    expect(state).toBe('manifest-only');
    expect(readFile(dest, '.zylos/manifest.json')).toBe(manifestV1Bytes);
    expect(exists(dest, '.zylos/originals')).toBe(false);
  });

  test('double-run is idempotent', () => {
    const dest = mkTmp();
    const snap = setupLegacySnapshotThenV2(dest);
    const manifestV1Bytes = readFile(snap, 'manifest.json');

    restoreMergeBaseline(dest, snap);
    restoreMergeBaseline(dest, snap);
    expect(readFile(dest, '.zylos/manifest.json')).toBe(manifestV1Bytes);
    expect(exists(dest, '.zylos/originals')).toBe(false);
  });
});

describe('restoreMergeBaseline: absent', () => {
  function setupAbsentSnapshotThenV2(dest) {
    writeFile(dest, 'a.js', 'v1');
    const snap = path.join(mkTmp(), 'snap');
    snapshotMergeBaseline(dest, snap);
    commitV2(dest);
    return snap;
  }

  test('removes baseline-owned artifacts only — other .zylos metadata survives', () => {
    const dest = mkTmp();
    const snap = setupAbsentSnapshotThenV2(dest);
    // Non-baseline metadata that must survive the absent restore
    writeFile(dest, '.zylos/other-metadata.json', '{"keep":true}');

    const { state } = restoreMergeBaseline(dest, snap);
    expect(state).toBe('absent');
    expect(exists(dest, '.zylos/manifest.json')).toBe(false);
    expect(exists(dest, '.zylos/originals')).toBe(false);
    expect(readFile(dest, '.zylos/other-metadata.json')).toBe('{"keep":true}');
  });

  test('interrupted removal converges on re-run', () => {
    const dest = mkTmp();
    const snap = setupAbsentSnapshotThenV2(dest);

    // Inject failure on the originals removal (manifest already gone by then
    // would also converge — either interruption order re-runs cleanly)
    const realRm = fs.rmSync;
    fs.rmSync = (p, opts) => {
      if (String(p).endsWith(path.join('.zylos', 'originals'))) {
        const err = new Error('EIO: injected removal failure');
        err.code = 'EIO';
        throw err;
      }
      return realRm(p, opts);
    };
    try {
      expect(() => restoreMergeBaseline(dest, snap)).toThrow(/EIO/);
    } finally {
      fs.rmSync = realRm;
    }

    const { state } = restoreMergeBaseline(dest, snap);
    expect(state).toBe('absent');
    expect(exists(dest, '.zylos/manifest.json')).toBe(false);
    expect(exists(dest, '.zylos/originals')).toBe(false);
  });

  test('double-run is idempotent', () => {
    const dest = mkTmp();
    const snap = setupAbsentSnapshotThenV2(dest);
    restoreMergeBaseline(dest, snap);
    restoreMergeBaseline(dest, snap);
    expect(exists(dest, '.zylos/manifest.json')).toBe(false);
    expect(exists(dest, '.zylos/originals')).toBe(false);
  });
});

describe('restoreMergeBaseline: fail-loud on bad snapshots (before touching the live site)', () => {
  function committedV2WithBytes() {
    const dest = mkTmp();
    setupPairV1(dest);
    commitV2(dest);
    return { dest, manifestV2Bytes: readFile(dest, '.zylos/manifest.json') };
  }

  test('missing state descriptor throws; live baseline untouched', () => {
    const { dest, manifestV2Bytes } = committedV2WithBytes();
    const snap = mkTmp(); // empty dir — no descriptor
    expect(() => restoreMergeBaseline(dest, snap)).toThrow(/state descriptor/);
    expect(readFile(dest, '.zylos/manifest.json')).toBe(manifestV2Bytes);
    expect(readFile(dest, '.zylos/originals/a.js')).toBe('v2');
  });

  test('corrupt state descriptor throws; never treated as absent', () => {
    const { dest, manifestV2Bytes } = committedV2WithBytes();
    const snap = mkTmp();
    writeFile(snap, 'baseline-state.json', 'not json {{{');
    expect(() => restoreMergeBaseline(dest, snap)).toThrow(/not valid JSON/);
    expect(readFile(dest, '.zylos/manifest.json')).toBe(manifestV2Bytes);
  });

  test('unknown state value throws', () => {
    const { dest, manifestV2Bytes } = committedV2WithBytes();
    const snap = mkTmp();
    writeFile(snap, 'baseline-state.json', '{"state":"weird"}');
    expect(() => restoreMergeBaseline(dest, snap)).toThrow(/unknown snapshot state/);
    expect(readFile(dest, '.zylos/manifest.json')).toBe(manifestV2Bytes);
  });

  test('pair state with corrupt snapshot manifest throws', () => {
    const { dest, manifestV2Bytes } = committedV2WithBytes();
    const snap = mkTmp();
    writeFile(snap, 'baseline-state.json', '{"state":"pair"}');
    writeFile(snap, 'manifest.json', 'not json {{{');
    fs.mkdirSync(path.join(snap, 'originals'), { recursive: true });
    expect(() => restoreMergeBaseline(dest, snap)).toThrow(/not valid JSON/);
    expect(readFile(dest, '.zylos/manifest.json')).toBe(manifestV2Bytes);
  });

  test('pair state without originals (torn snapshot) throws', () => {
    const { dest, manifestV2Bytes } = committedV2WithBytes();
    const snap = mkTmp();
    const manifestBytes = JSON.stringify(generateManifest(dest), null, 2);
    writeFile(snap, 'baseline-state.json', '{"state":"pair"}');
    writeFile(snap, 'manifest.json', manifestBytes);
    expect(() => restoreMergeBaseline(dest, snap)).toThrow(/torn/);
    expect(readFile(dest, '.zylos/manifest.json')).toBe(manifestV2Bytes);
    expect(readFile(dest, '.zylos/originals/a.js')).toBe('v2');
  });
});

describe('removeMergeBaseline', () => {
  test('removes manifest, originals, staging and legacy leftovers; keeps other .zylos content; idempotent', () => {
    const dest = mkTmp();
    setupPairV1(dest);
    writeFile(dest, '.zylos/manifest.json.tmp', '{}');
    writeFile(dest, '.zylos/originals.new/a.js', 'x');
    writeFile(dest, '.zylos/originals.bak/a.js', 'y');
    writeFile(dest, '.zylos/other-metadata.json', '{"keep":true}');

    removeMergeBaseline(dest);
    removeMergeBaseline(dest); // idempotent

    expect(exists(dest, '.zylos/manifest.json')).toBe(false);
    expect(exists(dest, '.zylos/originals')).toBe(false);
    expect(exists(dest, '.zylos/manifest.json.tmp')).toBe(false);
    expect(exists(dest, '.zylos/originals.new')).toBe(false);
    expect(exists(dest, '.zylos/originals.bak')).toBe(false);
    expect(readFile(dest, '.zylos/other-metadata.json')).toBe('{"keep":true}');
  });

  test('no-op when .zylos does not exist', () => {
    const dest = mkTmp();
    expect(() => removeMergeBaseline(dest)).not.toThrow();
  });
});
