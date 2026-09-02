/**
 * Real-pipeline coverage for the pinned (`zylos upgrade <c>@<version>`)
 * clean-reinstall path (#73), driving the actual runUpgrade({ pinned: true })
 * pipeline via a child process (see test/helpers/run-upgrade-driver.mjs).
 *
 * Requirements under test (owner/daniel-mandated, see cli/lib/upgrade.js
 * step3_pinnedCleanReinstall doc comment for the full design rationale):
 *
 *   ① version metadata written last, via staged-tree -> npm install +
 *      manifest all-green -> atomic swap-in (never observable half-applied).
 *   ② fail-clean: any failure cleans up the staging tree / leaves the live
 *      skillDir untouched, never a half-installed tree bearing target
 *      version metadata.
 *   🟡 whole-tree overwrite excludes node_modules/.backup/.zylos, and
 *      never destroys `.backup/` (the sole recovery path for the bad-state
 *      scenarios this feature targets).
 *   Daniel round 3 ("inherited broken tree"): the post-condition read-back
 *   must be bound to THIS attempt having completed the atomic swap-in
 *   (ctx.pinnedSwapCompleted / result.pinnedSwapCompleted), not merely to
 *   on-disk version equality — a stale, unrelated broken tree can already
 *   read back as the target version.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DRIVER = path.join(import.meta.dirname, 'helpers', 'run-upgrade-driver.mjs');

let tmpRoot;
let zylosDir;
let skillsDir;
let componentsDir;
let shimDir;
let failFlag;

function mkTmp() {
  return fs.mkdtempSync(path.join(tmpRoot, 'src-'));
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

/** A well-formed SKILL.md + package.json declaring `version`. */
function skillMd(version) {
  return `---\nname: fixture\nversion: ${version}\n---\n\n# fixture\n`;
}

/** Build a real, installable source tree at the given version. */
function makeSource(name, version, { extra = {} } = {}) {
  const source = mkTmp();
  writeFile(source, 'SKILL.md', skillMd(version));
  writeFile(source, 'package.json', JSON.stringify({ name, version }));
  writeFile(source, 'a.js', `content-${version}`);
  for (const [rel, content] of Object.entries(extra)) writeFile(source, rel, content);
  return source;
}

/** Install a fully-formed component tree directly under skillsDir (no pipeline involved). */
function installDirect(name, version) {
  const dest = path.join(skillsDir, name);
  writeFile(dest, 'SKILL.md', skillMd(version));
  writeFile(dest, 'package.json', JSON.stringify({ name, version }));
  writeFile(dest, 'a.js', `content-${version}`);
  return dest;
}

function skillDirFor(name) {
  return path.join(skillsDir, name);
}

function dataDirFor(name) {
  return path.join(componentsDir, name);
}

function runPinnedE2E(name, tempDir, targetVersion, { env = {} } = {}) {
  const child = spawnSync(process.execPath, [DRIVER, name, tempDir ?? '', targetVersion], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ZYLOS_DIR: zylosDir,
      PATH: shimDir + path.delimiter + process.env.PATH,
      ZYLOS_TEST_PINNED: '1',
      ZYLOS_TEST_BASELINE_COMMIT_FAIL: '0',
      ...env,
    },
    timeout: 60000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout);
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pinned-e2e-'));
  zylosDir = path.join(tmpRoot, 'zylos-home');
  skillsDir = path.join(zylosDir, '.claude', 'skills');
  componentsDir = path.join(zylosDir, 'components');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(componentsDir, { recursive: true });

  shimDir = path.join(tmpRoot, 'shim-bin');
  fs.mkdirSync(shimDir, { recursive: true });
  failFlag = path.join(shimDir, 'npm-fail');
  // The shim marks the CWD it ran `npm install` in (a marker file inside
  // node_modules) so tests can prove *where* the install ran (staging vs.
  // live skillDir) without depending on a real npm registry.
  fs.writeFileSync(path.join(shimDir, 'npm'), [
    '#!/bin/sh',
    `if [ -e "${failFlag}" ]; then exit 1; fi`,
    'mkdir -p node_modules',
    'echo installed > node_modules/.install-marker',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('pinned clean reinstall (#73): bidirectional pin + staged atomic swap', () => {
  test('pinned upgrade (v1 -> v2): whole tree replaced, npm install ran, read-back == target', () => {
    const name = 'pin-upgrade';
    fs.rmSync(failFlag, { force: true });
    installDirect(name, '1.0.0');
    const sourceV2 = makeSource(name, '2.0.0');

    const result = runPinnedE2E(name, sourceV2, '2.0.0');

    expect(result.success).toBe(true);
    expect(result.to).toBe('2.0.0');
    expect(result.pinnedSwapCompleted).toBe(true);
    expect(readFile(skillDirFor(name), 'a.js')).toBe('content-2.0.0');
    expect(exists(skillDirFor(name), 'node_modules/.install-marker')).toBe(true);
    const clean = result.steps.find(s => s.name === 'clean_reinstall');
    expect(clean.status).toBe('done');
    const npmStep = result.steps.find(s => s.name === 'npm_install');
    expect(npmStep.status).toBe('skipped');
    expect(npmStep.message).toMatch(/staged reinstall/);
  });

  test('pinned downgrade (v2 -> v1): same mechanism works in reverse (bidirectional pin)', () => {
    const name = 'pin-downgrade';
    fs.rmSync(failFlag, { force: true });
    installDirect(name, '2.0.0');
    const sourceV1 = makeSource(name, '1.0.0');

    const result = runPinnedE2E(name, sourceV1, '1.0.0');

    expect(result.success).toBe(true);
    expect(result.to).toBe('1.0.0');
    expect(result.pinnedSwapCompleted).toBe(true);
    expect(readFile(skillDirFor(name), 'a.js')).toBe('content-1.0.0');
  });

  test('half-installed recovery: skillDir entirely missing -> pinned install self-heals it', () => {
    const name = 'pin-missing-skilldir';
    fs.rmSync(failFlag, { force: true });
    expect(fs.existsSync(skillDirFor(name))).toBe(false);
    const sourceV1 = makeSource(name, '1.0.0');

    const result = runPinnedE2E(name, sourceV1, '1.0.0');

    expect(result.success).toBe(true);
    expect(result.pinnedSwapCompleted).toBe(true);
    expect(readFile(skillDirFor(name), 'a.js')).toBe('content-1.0.0');
    expect(exists(skillDirFor(name), 'node_modules/.install-marker')).toBe(true);
  });

  test('corrupt/incomplete skillDir (no SKILL.md, no package.json) -> pinned downgrade-to-stable recovers, .backup/ preserved', () => {
    const name = 'pin-corrupt-tree';
    fs.rmSync(failFlag, { force: true });
    const dest = skillDirFor(name);
    // Deliberately broken: only a stray file, no version-bearing metadata at all.
    writeFile(dest, 'garbage.txt', 'not a real install');
    const sourceStable = makeSource(name, '1.0.0');

    const result = runPinnedE2E(name, sourceStable, '1.0.0');

    expect(result.success).toBe(true);
    expect(result.pinnedSwapCompleted).toBe(true);
    expect(readFile(dest, 'a.js')).toBe('content-1.0.0');
    // step2_backup ran against the corrupt tree before the swap; its output
    // (.backup/<timestamp>/garbage.txt) must have been carried forward
    // across the whole-tree swap rather than destroyed (requirement 🟡).
    const backupRoot = path.join(dest, '.backup');
    expect(fs.existsSync(backupRoot)).toBe(true);
    const [snapshot] = fs.readdirSync(backupRoot);
    expect(readFile(path.join(backupRoot, snapshot), 'garbage.txt')).toBe('not a real install');
  });

  test('data dir is never touched by a pinned reinstall', () => {
    const name = 'pin-datadir-preserved';
    fs.rmSync(failFlag, { force: true });
    installDirect(name, '1.0.0');
    const dataDir = dataDirFor(name);
    writeFile(dataDir, 'db.json', JSON.stringify({ important: 'user-data' }));
    const dataMarkerBefore = readFile(dataDir, 'db.json');
    const sourceV2 = makeSource(name, '2.0.0');

    const result = runPinnedE2E(name, sourceV2, '2.0.0');

    expect(result.success).toBe(true);
    expect(readFile(dataDir, 'db.json')).toBe(dataMarkerBefore);
  });

  test('mid-pipeline failure (npm install fails in staging) leaves NO half-installed target-version metadata on disk', () => {
    const name = 'pin-midfail';
    installDirect(name, '1.0.0');
    const sourceV2 = makeSource(name, '2.0.0');

    fs.writeFileSync(failFlag, '');
    const failed = runPinnedE2E(name, sourceV2, '2.0.0');

    expect(failed.success).toBe(false);
    expect(failed.pinnedSwapCompleted).toBe(false);
    // The live skillDir must be untouched: still v1, not a half-applied v2.
    expect(readFile(skillDirFor(name), 'a.js')).toBe('content-1.0.0');
    expect(JSON.parse(readFile(skillDirFor(name), 'package.json')).version).toBe('1.0.0');
    // No orphaned staging directory left behind either (fail-clean, requirement ②).
    const siblings = fs.readdirSync(skillsDir).filter(n => n.startsWith(`${name}.`));
    expect(siblings).toEqual([]);

    fs.rmSync(failFlag, { force: true });
    const retry = runPinnedE2E(name, sourceV2, '2.0.0');
    expect(retry.success).toBe(true);
    expect(retry.pinnedSwapCompleted).toBe(true);
    expect(readFile(skillDirFor(name), 'a.js')).toBe('content-2.0.0');
  });

  test('mid-pipeline failure from a missing skillDir leaves it STILL missing (no phantom half-install)', () => {
    const name = 'pin-midfail-from-missing';
    expect(fs.existsSync(skillDirFor(name))).toBe(false);
    const sourceV1 = makeSource(name, '1.0.0');

    fs.writeFileSync(failFlag, '');
    const failed = runPinnedE2E(name, sourceV1, '1.0.0');

    expect(failed.success).toBe(false);
    expect(failed.pinnedSwapCompleted).toBe(false);
    expect(fs.existsSync(skillDirFor(name))).toBe(false);

    fs.rmSync(failFlag, { force: true });
    const retry = runPinnedE2E(name, sourceV1, '1.0.0');
    expect(retry.success).toBe(true);
    expect(readFile(skillDirFor(name), 'a.js')).toBe('content-1.0.0');
  });

  // --- Daniel round-3: "inherited broken tree" -----------------------------
  //
  // Simulates the exact scenario the coordinator's most recent instruction
  // called out: an UNRELATED prior (non-pinned, ordinary) upgrade tolerated a
  // silent rollback failure and left behind a skillDir whose metadata already
  // reads back as some version V, but the tree is genuinely broken. Recovery
  // dispatches a PINNED upgrade for that SAME version V. This attempt fails
  // EARLY -- before step3 ever touches the real skillDir (we force this by
  // pointing tempDir at a path that does not exist, which trips
  // step3_pinnedCleanReinstall's very first guard). A naive read-back that
  // only checks "does on-disk version == target" would be fooled by the
  // pre-existing metadata and misreport success. The fix requires
  // result.pinnedSwapCompleted (bound to *this* attempt's atomic swap) in
  // addition to version equality.
  test('inherited broken tree + early failure (before touching real disk) is NOT reported ready, even though on-disk metadata already == target', () => {
    const name = 'pin-inherited-broken-tree';
    const target = '3.7.0';
    const dest = skillDirFor(name);

    // Pre-seed a tree whose metadata already says target version, but which
    // is NOT a genuine install (no node_modules, no manifest, no real
    // content) -- exactly the shape a tolerated rollback failure would leave.
    writeFile(dest, 'SKILL.md', skillMd(target));
    writeFile(dest, 'package.json', JSON.stringify({ name, version: target }));
    writeFile(dest, 'a.js', 'BROKEN: this is not a real install');

    // Sanity check: a naive "read version off disk" check would already see
    // the dangerous condition this test exists to guard against.
    expect(JSON.parse(readFile(dest, 'package.json')).version).toBe(target);

    // Force an early failure: nonexistent tempDir trips
    // step3_pinnedCleanReinstall's first guard ("Temp directory not
    // available") before anything under ctx.skillDir is touched.
    const bogusTempDir = path.join(tmpRoot, 'does-not-exist-' + Math.random().toString(36).slice(2));
    fs.rmSync(failFlag, { force: true });

    const result = runPinnedE2E(name, bogusTempDir, target);

    // The pipeline correctly fails, and never claims to have completed a
    // swap-in during this attempt.
    expect(result.success).toBe(false);
    expect(result.pinnedSwapCompleted).toBe(false);
    expect(result.failedStep).toBe(3);

    // The inherited broken tree is untouched by any REAL install content --
    // still reads == target on disk (via its own stale metadata), and its
    // business file content is still the pre-seeded broken placeholder, not
    // anything materialized from a real source tree (there was none: tempDir
    // never existed). This proves version-equality ALONE is not sufficient
    // and a caller must also require pinnedSwapCompleted, exactly as
    // component.js's handlePinnedUpgrade does (swapCompletedThisAttempt
    // gate). (Note: rollback()'s pre-existing, unrelated `restore_dependencies`
    // step may still run `npm install` against the restored — still broken —
    // tree; that is expected repo behavior and is not evidence of a swap-in.)
    expect(JSON.parse(readFile(dest, 'package.json')).version).toBe(target);
    expect(readFile(dest, 'a.js')).toBe('BROKEN: this is not a real install');
  });
});
