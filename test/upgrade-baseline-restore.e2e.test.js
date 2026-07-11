/**
 * E2E fault injection for the #715 R4 review P2 (R5 rework): the merge
 * baseline commits at step3 of runUpgrade(), but later pipeline steps
 * (step4 npm install, step8 service restart) can still fail. The outer
 * rollback restores business files from the step2 backup but excludes
 * .zylos — leaving files@old + metadata@new, so a retry misreads every
 * upstream change as a local modification and reports success while
 * keeping old content (phantom success).
 *
 * R5 contract under test:
 *  - step2 canonicalizes (recoverMergeBaseline) BEFORE snapshotting the
 *    baseline into the backup; recovery failure fails step2 — no backup
 *    is accepted from a non-canonical site.
 *  - every outer rollback also restores the old baseline, atomically,
 *    through the manifest module — files and metadata always move together
 *    (pair / legacy manifest-only / absent all round-trip).
 *  - the baseline restore is an independent, visible rollback action
 *    (restore_baseline) — its failure is never masked by restore_files.
 *
 * Drives the REAL runUpgrade() pipeline in a child process (Jest's sandboxed
 * process.env is not inherited by execSync grandchildren, so the PATH-shim
 * npm must be injected via an explicit child environment) with a stateful
 * fake npm for step4 fault injection: first attempt fails, retry passes.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateManifest,
  saveManifest,
  saveOriginals,
  loadManifest,
  hashFile,
} from '../cli/lib/manifest.js';
import { copyTree } from '../cli/lib/fs-utils.js';
import { rollback } from '../cli/lib/upgrade.js';

const DRIVER = path.join(import.meta.dirname, 'helpers', 'run-upgrade-driver.mjs');

let tmpRoot;
let zylosDir;      // ZYLOS_DIR fixture root the child pipeline resolves against
let skillsDir;
let shimDir;       // PATH shim directory with a controllable fake npm
let failFlag;      // step4 npm fails while this file exists

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

/**
 * Install a component fixture at v1 under the fixture SKILLS_DIR.
 * baseline: 'pair' (manifest + originals), 'manifest-only' (legacy), 'absent'
 */
function installComponentV1(name, { baseline = 'pair' } = {}) {
  const dir = path.join(skillsDir, name);
  writeFile(dir, 'a.js', 'v1');
  writeFile(dir, 'package.json', JSON.stringify({ name, version: '1.0.0' }, null, 2));
  if (baseline === 'pair') {
    saveManifest(dir, generateManifest(dir));
    saveOriginals(dir, dir);
  } else if (baseline === 'manifest-only') {
    saveManifest(dir, generateManifest(dir));
  }
  return dir;
}

/** New-version source directory, as downloadToTemp would produce. */
function makeV2Temp(name) {
  const tempDir = mkTmp();
  writeFile(tempDir, 'a.js', 'v2');
  writeFile(tempDir, 'package.json', JSON.stringify({ name, version: '2.0.0' }, null, 2));
  return tempDir;
}

/** Run the real runUpgrade() pipeline in a child process with the shim on PATH. */
function runUpgradeE2E(name, tempDir) {
  const child = spawnSync(process.execPath, [DRIVER, name, tempDir, '2.0.0'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ZYLOS_DIR: zylosDir,
      PATH: shimDir + path.delimiter + process.env.PATH,
    },
    timeout: 60000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout);
}

function armNpmFailure() {
  fs.writeFileSync(failFlag, '');
}

function clearNpmFailure() {
  fs.rmSync(failFlag, { force: true });
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-r5-baseline-e2e-'));
  zylosDir = path.join(tmpRoot, 'zylos-home');
  skillsDir = path.join(zylosDir, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  // PATH-shim npm: exits 1 while the flag file exists, 0 otherwise.
  shimDir = path.join(tmpRoot, 'shim-bin');
  fs.mkdirSync(shimDir, { recursive: true });
  failFlag = path.join(shimDir, 'npm-fail-flag');
  const shim = [
    '#!/bin/sh',
    '# fake npm for step4 fault injection (zylos #715 R5 e2e)',
    `if [ -e "${failFlag}" ]; then`,
    '  echo "injected npm failure (R5 e2e)" >&2',
    '  exit 1',
    'fi',
    'exit 0',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(shimDir, 'npm'), shim, { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('runUpgrade later-step failure → rollback restores baseline with files (#715 R4 P2)', () => {
  test('step4 npm failure after step3 baseline commit: rollback restores files AND baseline; retry truly applies v2', () => {
    const name = 'r5-e2e-pair';
    const dir = installComponentV1(name);
    const manifestV1Bytes = readFile(dir, '.zylos/manifest.json');
    const tempDir = makeV2Temp(name);

    // Attempt 1: step3 commits the v2 baseline, then step4 npm fails →
    // the pipeline rolls back.
    armNpmFailure();
    const first = runUpgradeE2E(name, tempDir);

    expect(first.success).toBe(false);
    expect(first.failedStep).toBe(4);
    expect(first.rollback.performed).toBe(true);
    const restoreFiles = first.rollback.steps.find(s => s.action === 'restore_files');
    expect(restoreFiles?.success).toBe(true);

    // Discriminator (red pre-R5): business files AND baseline metadata must
    // move together. Pre-R5 the rollback excludes .zylos, so the manifest and
    // originals stay at v2 while a.js is back at v1.
    expect(readFile(dir, 'a.js')).toBe('v1');
    expect(readFile(dir, '.zylos/manifest.json')).toBe(manifestV1Bytes);
    expect(readFile(dir, '.zylos/originals/a.js')).toBe('v1');
    expect(fs.existsSync(path.join(dir, '.zylos', 'manifest.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.zylos', 'originals.new'))).toBe(false);

    // The baseline restore is its own visible rollback action (R5 gate #4)
    const restoreBaseline = first.rollback.steps.find(s => s.action === 'restore_baseline');
    expect(restoreBaseline).toBeDefined();
    expect(restoreBaseline.success).toBe(true);

    // Attempt 2 with the fault cleared: v2 must be truly applied —
    // overwritten, not phantom-"kept" as a local modification.
    clearNpmFailure();
    const retry = runUpgradeE2E(name, tempDir);

    expect(retry.success).toBe(true);
    const mergeStep = retry.steps.find(s => s.name === 'smart_merge');
    expect(mergeStep.status).toBe('done');
    expect(mergeStep.message).toMatch(/overwritten/);
    expect(mergeStep.message).not.toMatch(/kept/);
    expect(readFile(dir, 'a.js')).toBe('v2');
    expect(loadManifest(dir).files['a.js']).toBe(hashFile(path.join(tempDir, 'a.js')));
    expect(readFile(dir, '.zylos/originals/a.js')).toBe('v2');
    expect(fs.existsSync(path.join(dir, '.zylos', 'manifest.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.zylos', 'originals.new'))).toBe(false);
  });

  test('focused: pre-upgrade baseline absent — rollback removes the newly committed baseline', () => {
    const name = 'r5-e2e-absent';
    const dir = installComponentV1(name, { baseline: 'absent' });
    const tempDir = makeV2Temp(name);

    armNpmFailure();
    const first = runUpgradeE2E(name, tempDir);

    expect(first.success).toBe(false);
    expect(first.failedStep).toBe(4);
    expect(readFile(dir, 'a.js')).toBe('v1');

    // Discriminator (red pre-R5): step3 committed a v2 baseline where none
    // existed before; leaving it behind is exactly the files@v1 + metadata@v2
    // phantom-success setup. The absent restore removes baseline-owned
    // artifacts only.
    expect(fs.existsSync(path.join(dir, '.zylos', 'manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.zylos', 'originals'))).toBe(false);
    const restoreBaseline = first.rollback.steps.find(s => s.action === 'restore_baseline');
    expect(restoreBaseline?.success).toBe(true);

    // Retry behaves like the original no-baseline upgrade: applies v2 for real.
    clearNpmFailure();
    const retry = runUpgradeE2E(name, tempDir);
    expect(retry.success).toBe(true);
    const mergeStep = retry.steps.find(s => s.name === 'smart_merge');
    expect(mergeStep.message).not.toMatch(/kept/);
    expect(readFile(dir, 'a.js')).toBe('v2');
    expect(loadManifest(dir).files['a.js']).toBe(hashFile(path.join(tempDir, 'a.js')));
    expect(readFile(dir, '.zylos/originals/a.js')).toBe('v2');
  });

  test('focused: legacy manifest-only baseline — rollback restores manifest-only semantics, never fabricates originals', () => {
    const name = 'r5-e2e-legacy';
    const dir = installComponentV1(name, { baseline: 'manifest-only' });
    const manifestV1Bytes = readFile(dir, '.zylos/manifest.json');
    const tempDir = makeV2Temp(name);

    armNpmFailure();
    const first = runUpgradeE2E(name, tempDir);

    expect(first.success).toBe(false);
    expect(first.failedStep).toBe(4);
    expect(readFile(dir, 'a.js')).toBe('v1');

    // Discriminator (red pre-R5): manifest back to the exact v1 bytes and
    // originals ABSENT again — a v2 originals dir left beside a v1 manifest
    // would be a fabricated merge base.
    expect(readFile(dir, '.zylos/manifest.json')).toBe(manifestV1Bytes);
    expect(fs.existsSync(path.join(dir, '.zylos', 'originals'))).toBe(false);
    const restoreBaseline = first.rollback.steps.find(s => s.action === 'restore_baseline');
    expect(restoreBaseline?.success).toBe(true);

    clearNpmFailure();
    const retry = runUpgradeE2E(name, tempDir);
    expect(retry.success).toBe(true);
    const mergeStep = retry.steps.find(s => s.name === 'smart_merge');
    expect(mergeStep.message).not.toMatch(/kept/);
    expect(readFile(dir, 'a.js')).toBe('v2');
    expect(loadManifest(dir).files['a.js']).toBe(hashFile(path.join(tempDir, 'a.js')));
    expect(readFile(dir, '.zylos/originals/a.js')).toBe('v2');
  });

  test('focused: staged residue at step2 — canonical recovery runs before the snapshot, rollback lands on the recovered v1 pair', () => {
    const name = 'r5-e2e-residue';
    const dir = installComponentV1(name);
    const manifestV1Bytes = readFile(dir, '.zylos/manifest.json');
    // Leftovers of an interrupted (uncommitted) baseline transaction from a
    // previous run: staged manifest marker + staged originals. Recovery must
    // discard these BEFORE the backup snapshot — a snapshot of the raw site
    // would restore staged v2 originals against a v1 manifest.
    writeFile(dir, '.zylos/manifest.json.tmp', '{"files":{},"generated_at":"staged"}');
    writeFile(dir, '.zylos/originals.new/a.js', 'v2-staged-uncommitted');
    const tempDir = makeV2Temp(name);

    armNpmFailure();
    const first = runUpgradeE2E(name, tempDir);

    expect(first.success).toBe(false);
    expect(first.failedStep).toBe(4);
    expect(readFile(dir, 'a.js')).toBe('v1');
    expect(readFile(dir, '.zylos/manifest.json')).toBe(manifestV1Bytes);
    expect(readFile(dir, '.zylos/originals/a.js')).toBe('v1');
    expect(fs.existsSync(path.join(dir, '.zylos', 'manifest.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.zylos', 'originals.new'))).toBe(false);
  });

  test('recovery failure at step2 fails the upgrade before any merge — no backup accepted, site preserved', () => {
    const name = 'r5-e2e-recovery-fail';
    const dir = installComponentV1(name);
    // Unresolvable legacy state: originals drifted from the manifest AND a
    // legacy originals.bak that does not match either — recoverMergeBaseline
    // refuses to guess and throws.
    writeFile(dir, '.zylos/originals/a.js', 'drifted-not-matching-manifest');
    writeFile(dir, '.zylos/originals.bak/a.js', 'backup-not-matching-either');
    const tempDir = makeV2Temp(name);

    clearNpmFailure();
    const first = runUpgradeE2E(name, tempDir);

    // Discriminator (red pre-R5): recovery used to run only inside step3's
    // smartSync — with the R5 canonicalize-before-snapshot contract the
    // failure surfaces at step2 and no backup is taken.
    expect(first.success).toBe(false);
    expect(first.failedStep).toBe(2);

    // Nothing was merged, nothing rolled back over the site: business files
    // and the ambiguous .zylos site are preserved for manual inspection.
    expect(readFile(dir, 'a.js')).toBe('v1');
    expect(readFile(dir, '.zylos/originals/a.js')).toBe('drifted-not-matching-manifest');
    expect(readFile(dir, '.zylos/originals.bak/a.js')).toBe('backup-not-matching-either');
  });
});

describe('rollback() baseline-restore edges (#715 R5)', () => {
  // These call the real rollback() in-process with an explicit ctx; the
  // fixtures carry no package.json so no npm dependency restore runs.
  function installBareV1(name) {
    const dir = path.join(skillsDir, name);
    writeFile(dir, 'a.js', 'v1');
    saveManifest(dir, generateManifest(dir));
    saveOriginals(dir, dir);
    return dir;
  }

  test('backup without a baseline snapshot: rollback removes the committed baseline instead of leaving metadata@new', () => {
    const name = 'r5-rb-no-snapshot';
    const dir = installBareV1(name);
    // Business-files-only backup, as a pre-R5 step2 (or a torn snapshot)
    // would leave it — no .zylos snapshot inside.
    const backupDir = path.join(mkTmp(), 'backup');
    copyTree(dir, backupDir, { excludes: ['node_modules', '.backup', '.zylos'] });

    // The upgrade advanced files and baseline to v2 before failing.
    writeFile(dir, 'a.js', 'v2');
    saveManifest(dir, generateManifest(dir));
    saveOriginals(dir, dir);

    const results = rollback({ backupDir, skillDir: dir, serviceWasRunning: false });

    const restoreFiles = results.find(r => r.action === 'restore_files');
    expect(restoreFiles?.success).toBe(true);
    expect(readFile(dir, 'a.js')).toBe('v1');

    // The old baseline is unknowable from this backup: leaving the v2 pair
    // would recreate the phantom-success setup, so it must be removed —
    // reported as its own action.
    const restoreBaseline = results.find(r => r.action === 'restore_baseline');
    expect(restoreBaseline).toBeDefined();
    expect(restoreBaseline.success).toBe(true);
    expect(fs.existsSync(path.join(dir, '.zylos', 'manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.zylos', 'originals'))).toBe(false);
  });

  test('corrupt baseline snapshot: restore_baseline fails loud and is not masked by restore_files success', () => {
    const name = 'r5-rb-corrupt-snapshot';
    const dir = installBareV1(name);
    const backupDir = path.join(mkTmp(), 'backup');
    copyTree(dir, backupDir, { excludes: ['node_modules', '.backup', '.zylos'] });
    // Snapshot present but corrupt: state descriptor is not valid JSON.
    writeFile(backupDir, '.zylos/baseline-state.json', 'not json {{{');

    writeFile(dir, 'a.js', 'v2');
    saveManifest(dir, generateManifest(dir));
    saveOriginals(dir, dir);
    const manifestV2Bytes = readFile(dir, '.zylos/manifest.json');

    const results = rollback({ backupDir, skillDir: dir, serviceWasRunning: false });

    const restoreFiles = results.find(r => r.action === 'restore_files');
    expect(restoreFiles?.success).toBe(true);

    const restoreBaseline = results.find(r => r.action === 'restore_baseline');
    expect(restoreBaseline).toBeDefined();
    expect(restoreBaseline.success).toBe(false);
    expect(restoreBaseline.error).toBeTruthy();

    // Fail loud means fail closed: a corrupt snapshot must never be treated
    // as "absent" — the live baseline is left in place for inspection.
    expect(readFile(dir, '.zylos/manifest.json')).toBe(manifestV2Bytes);
    expect(readFile(dir, '.zylos/originals/a.js')).toBe('v2');
  });
});
