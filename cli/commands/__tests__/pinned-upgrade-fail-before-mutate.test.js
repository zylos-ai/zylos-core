/**
 * cli/commands/component.js — pinned upgrade CLI coverage (#73, zylos0t
 * review #771: "fail-before-mutate", design doc §3.4).
 *
 * These tests drive the real handlePinnedUpgrade()/upgradeComponent() CLI
 * logic (not just the lower-level runUpgrade() pipeline, already covered by
 * test/upgrade-pinned-clean-reinstall.e2e.test.js and
 * cli/lib/__tests__/upgrade-pinned.test.js). The only things mocked are
 * cli/lib/upgrade.js's exports — getRepo/downloadToTemp/runUpgrade/
 * getLocalVersion/checkDowngradeSchemaCompatibility — via node:test's native
 * mock.module (already used the same way in
 * cli/lib/__tests__/runtime-launch.test.js), so no real network/GitHub call
 * or real npm-install pipeline is ever exercised here. components.json and
 * the skill-tree fixture are real files on disk, so registry/disk mutation
 * (or the deliberate absence of it) can be asserted directly.
 *
 * Per the same isolation pattern as cli/lib/__tests__/upgrade-pinned.test.js:
 * config.js's SKILLS_DIR/COMPONENTS_FILE etc. are consts computed ONCE from
 * process.env.ZYLOS_DIR at first import, and node:test isolates each *file*
 * into its own worker process, so setting ZYLOS_DIR here before the dynamic
 * import below is safe.
 */
import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ZYLOS_FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pinned-cli-'));
process.env.ZYLOS_DIR = ZYLOS_FIXTURE_DIR;

const SKILLS_DIR = path.join(ZYLOS_FIXTURE_DIR, '.claude', 'skills');
const CONFIG_DIR = path.join(ZYLOS_FIXTURE_DIR, '.zylos');
const COMPONENTS_FILE = path.join(CONFIG_DIR, 'components.json');
fs.mkdirSync(SKILLS_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });

// Per-test-configurable behavior for the mocked cli/lib/upgrade.js exports.
const scenario = {
  getRepo: () => 'org/demo',
  downloadToTemp: () => ({ success: true, tempDir: '/tmp/unset' }),
  runUpgrade: () => ({ success: true, to: null, pinnedSwapCompleted: true, steps: [] }),
  getLocalVersion: () => ({ success: true, version: null }),
  checkDowngradeSchemaCompatibility: () => ({ compatible: true, currentSchema: 1, targetSchema: 1 }),
};

const calls = { runUpgrade: [], downloadToTemp: [], cleanupTemp: [] };

// Import the REAL module first so every export it provides (including ones
// only cli/lib/self-upgrade.js needs, like getAllowedTmpRoots) stays intact
// -- mock.module below replaces the whole namespace, so anything not
// re-spread here would otherwise vanish and break unrelated importers.
const realUpgrade = await import('../../lib/upgrade.js');

// Mocking a relative specifier here resolves it the same way `import()`
// would from THIS file, but node:test's mock registry matches by final
// resolved module URL — so component.js's own `from '../lib/upgrade.js'`
// (resolved relative to component.js) hits the same mock transparently.
mock.module('../../lib/upgrade.js', {
  namedExports: {
    ...realUpgrade,
    getRepo: (component) => scenario.getRepo(component),
    runUpgrade: (component, opts) => {
      calls.runUpgrade.push({ component, opts });
      return scenario.runUpgrade(component, opts);
    },
    downloadToTemp: (repo, version, branch, opts) => {
      calls.downloadToTemp.push({ repo, version, branch, opts });
      return scenario.downloadToTemp(repo, version, branch, opts);
    },
    readChangelog: () => null,
    filterChangelog: () => null,
    cleanupTemp: (dir) => { calls.cleanupTemp.push(dir); },
    getLocalVersion: (dir) => scenario.getLocalVersion(dir),
    checkDowngradeSchemaCompatibility: (...a) => scenario.checkDowngradeSchemaCompatibility(...a),
  },
});

const { upgradeComponent } = await import('../component.js');

after(() => {
  fs.rmSync(ZYLOS_FIXTURE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  calls.runUpgrade.length = 0;
  calls.downloadToTemp.length = 0;
  calls.cleanupTemp.length = 0;
});

function writeComponentsJson(obj) {
  fs.writeFileSync(COMPONENTS_FILE, JSON.stringify(obj, null, 2));
}

function readComponentsJson() {
  return JSON.parse(fs.readFileSync(COMPONENTS_FILE, 'utf8'));
}

function makeSkillDir(name, version) {
  const dir = path.join(SKILLS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\nversion: ${version}\n---\n\n# ${name}\n`);
  return dir;
}

class ExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

/**
 * Run upgradeComponent() with process.exit()/console.log/console.error
 * intercepted (test-scoped via t.mock — automatically restored when the
 * test ends). Returns the observed exit code (null if upgradeComponent
 * returned normally) and the parsed --json output line, if any.
 */
async function runUpgradeCli(t, args) {
  const logs = [];
  t.mock.method(console, 'log', (...a) => { logs.push(a.map(String).join(' ')); });
  t.mock.method(console, 'error', (...a) => { logs.push(a.map(String).join(' ')); });
  t.mock.method(process, 'exit', (code) => { throw new ExitSignal(code); });

  let exitCode = null;
  try {
    await upgradeComponent(args);
  } catch (err) {
    if (err instanceof ExitSignal) {
      exitCode = err.code;
    } else {
      throw err;
    }
  }
  const jsonLine = logs.find((l) => l.trim().startsWith('{'));
  const output = jsonLine ? JSON.parse(jsonLine) : null;
  return { exitCode, output, logs };
}

// ---------------------------------------------------------------------------
// Fix 1(A): pre-swap metadata validation
// ---------------------------------------------------------------------------

test('Fix 1(A): downloaded package version mismatch fails BEFORE any disk/registry mutation', async (t) => {
  const name = 'pin-mismatch';
  makeSkillDir(name, '1.0.0');
  writeComponentsJson({ [name]: { version: '1.0.0', repo: 'org/demo' } });
  const before = readComponentsJson();
  const beforeSkill = fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
  const tempDir = '/tmp/fake-tempdir-mismatch';

  scenario.downloadToTemp = () => ({ success: true, tempDir });
  // tempDir metadata reports a DIFFERENT version than requested.
  scenario.getLocalVersion = (dir) => (dir === tempDir ? { success: true, version: '9.9.9' } : { success: true, version: '1.0.0' });
  scenario.runUpgrade = () => { throw new Error('runUpgrade must NOT be called when pre-swap validation fails'); };

  const { exitCode, output } = await runUpgradeCli(t, [`${name}@2.0.0`, '--yes', '--json']);

  assert.equal(exitCode, 1);
  assert.equal(output.error, 'version_download_mismatch');
  assert.equal(calls.runUpgrade.length, 0, 'runUpgrade (the disk swap) must never be invoked');
  assert.deepStrictEqual(readComponentsJson(), before, 'components.json must be byte-for-byte unchanged');
  assert.equal(fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8'), beforeSkill, 'on-disk skill tree must be unchanged');
});

test('Fix 1(A): an unreadable downloaded package version also fails pre-swap (never "indeterminate")', async (t) => {
  const name = 'pin-unreadable';
  makeSkillDir(name, '1.0.0');
  writeComponentsJson({ [name]: { version: '1.0.0', repo: 'org/demo' } });
  const before = readComponentsJson();
  const tempDir = '/tmp/fake-tempdir-unreadable';

  scenario.downloadToTemp = () => ({ success: true, tempDir });
  scenario.getLocalVersion = (dir) => (dir === tempDir ? { success: false, error: 'Version not found in SKILL.md or package.json' } : { success: true, version: '1.0.0' });
  scenario.runUpgrade = () => { throw new Error('runUpgrade must NOT be called when pre-swap validation fails'); };

  const { exitCode, output } = await runUpgradeCli(t, [`${name}@2.0.0`, '--yes', '--json']);

  assert.equal(exitCode, 1);
  assert.equal(output.error, 'version_download_mismatch');
  assert.equal(calls.runUpgrade.length, 0);
  assert.deepStrictEqual(readComponentsJson(), before);
});

// ---------------------------------------------------------------------------
// Fix 1(B): registry write deferred until after disk read-back
// ---------------------------------------------------------------------------

test('Fix 1(B): registry is NOT written when post-swap on-disk read-back fails', async (t) => {
  const name = 'pin-diskfail';
  makeSkillDir(name, '1.0.0');
  writeComponentsJson({ [name]: { version: '1.0.0', repo: 'org/demo' } });
  const before = readComponentsJson();
  const tempDir = '/tmp/fake-tempdir-diskfail';

  scenario.downloadToTemp = () => ({ success: true, tempDir });
  // Pre-swap check passes (tempDir reports the requested version)...
  scenario.getLocalVersion = (dir) => (dir === tempDir ? { success: true, version: '2.0.0' } : { success: true, version: '9.9.9' });
  // ...but the pipeline's own disk read-back (skillDir) disagrees despite success:true.
  scenario.runUpgrade = () => ({ success: true, to: '2.0.0', pinnedSwapCompleted: true, steps: [] });

  const { exitCode, output } = await runUpgradeCli(t, [`${name}@2.0.0`, '--yes', '--json']);

  assert.equal(exitCode, 1);
  assert.equal(output.error, 'version_readback_mismatch');
  assert.match(output.message, /Registry left unchanged/);
  assert.deepStrictEqual(readComponentsJson(), before, 'components.json must be untouched when disk read-back fails');
});

test('Fix 1(B): registry is NOT written when pinnedSwapCompleted is false, even if on-disk version coincidentally matches target (daniel round-3 "inherited broken tree")', async (t) => {
  const name = 'pin-swap-not-completed';
  // Pre-existing tree already reads back as the target version (e.g. a stale,
  // unrelated broken tree left by a tolerated rollback failure elsewhere).
  makeSkillDir(name, '2.0.0');
  writeComponentsJson({ [name]: { version: '1.0.0', repo: 'org/demo' } });
  const before = readComponentsJson();
  const tempDir = '/tmp/fake-tempdir-noswap';

  scenario.downloadToTemp = () => ({ success: true, tempDir });
  scenario.getLocalVersion = () => ({ success: true, version: '2.0.0' }); // matches target for BOTH tempDir and skillDir
  // ...but THIS attempt never actually performed the swap-in.
  scenario.runUpgrade = () => ({ success: true, to: '2.0.0', pinnedSwapCompleted: false, steps: [] });

  const { exitCode, output } = await runUpgradeCli(t, [`${name}@2.0.0`, '--yes', '--json']);

  assert.equal(exitCode, 1);
  assert.equal(output.error, 'version_readback_mismatch');
  assert.match(output.message, /never completed the clean-reinstall swap-in/);
  assert.deepStrictEqual(readComponentsJson(), before);
});

test('Fix 1(B): registry write ordering — a fully successful pin writes the registry only after both read-backs pass', async (t) => {
  const name = 'pin-fully-successful';
  makeSkillDir(name, '1.0.0');
  writeComponentsJson({ [name]: { version: '1.0.0', repo: 'org/demo' } });
  const tempDir = '/tmp/fake-tempdir-success';

  scenario.downloadToTemp = () => ({ success: true, tempDir });
  scenario.getLocalVersion = () => ({ success: true, version: '2.0.0' });
  scenario.runUpgrade = () => ({ success: true, to: '2.0.0', pinnedSwapCompleted: true, steps: [] });

  const { exitCode, output } = await runUpgradeCli(t, [`${name}@2.0.0`, '--yes', '--json']);

  assert.equal(exitCode, null, 'success path must not call process.exit');
  assert.equal(output.success, true);
  assert.equal(readComponentsJson()[name].version, '2.0.0');
});

test('Fix 1(B)/P1 (zylos0t re-review): a divergent runUpgrade result.to never mutates the registry nor leaks into the result — the validated request version is pinned', async (t) => {
  const name = 'pin-divergent-resultto';
  makeSkillDir(name, '1.0.0');
  writeComponentsJson({ [name]: { version: '1.0.0', repo: 'org/demo' } });
  const tempDir = '/tmp/fake-tempdir-divergent';

  scenario.downloadToTemp = () => ({ success: true, tempDir });
  // Both the downloaded package AND the on-disk tree agree on the requested target.
  scenario.getLocalVersion = () => ({ success: true, version: '2.0.0' });
  // ...but the pipeline REPORTS a divergent `to` (e.g. a build-metadata suffix).
  // Old code wrote `result.to || version` -> components.json would become
  // "2.0.0+wrong", then the registry read-back (=== version) would fail and the
  // command would exit non-zero WITH the mutation already persisted.
  scenario.runUpgrade = () => ({ success: true, to: '2.0.0+wrong', pinnedSwapCompleted: true, steps: [] });

  const { exitCode, output } = await runUpgradeCli(t, [`${name}@2.0.0`, '--yes', '--json']);

  assert.equal(exitCode, null, 'must succeed: request and disk both === target, so there is no real mismatch');
  assert.equal(output.success, true);
  assert.equal(output.error, undefined, 'must NOT be a version_readback_mismatch');
  assert.equal(readComponentsJson()[name].version, '2.0.0', 'registry must hold the validated request version, never result.to');
  assert.equal(output.to, '2.0.0', 'the reported installed version must be the validated version, not the divergent result.to');
});

// ---------------------------------------------------------------------------
// Fix 2: pinned `@version --check` is a real pre-check
// ---------------------------------------------------------------------------

test('Fix 2: pinned --check fails when the requested tag cannot be resolved/downloaded', async (t) => {
  const name = 'pin-check-missing-tag';
  makeSkillDir(name, '1.0.0');
  writeComponentsJson({ [name]: { version: '1.0.0', repo: 'org/demo' } });

  scenario.downloadToTemp = () => ({ success: false, error: 'HTTP 404: tag not found' });

  const { exitCode, output } = await runUpgradeCli(t, [`${name}@9.9.9`, '--check', '--json']);

  assert.equal(exitCode, 1);
  assert.equal(output.error, 'version_download_failed');
  assert.match(output.message, /Could not resolve/);
});

test('Fix 2: pinned --check surfaces a downgrade schema-incompatibility precheck', async (t) => {
  const name = 'pin-check-downgrade-incompatible';
  makeSkillDir(name, '2.0.0');
  writeComponentsJson({ [name]: { version: '2.0.0', repo: 'org/demo' } });
  const tempDir = '/tmp/fake-tempdir-check-downgrade';

  scenario.downloadToTemp = () => ({ success: true, tempDir });
  scenario.checkDowngradeSchemaCompatibility = () => ({
    compatible: false,
    currentSchema: 2,
    targetSchema: 1,
    error: 'Refusing downgrade: installed data schema version (2) is newer than the target version\'s supported schema (1).',
  });

  const { exitCode, output } = await runUpgradeCli(t, [`${name}@1.0.0`, '--check', '--json']);

  assert.equal(exitCode, 1);
  assert.equal(output.error, 'downgrade_incompatible_schema');
  assert.match(output.message, /Refusing downgrade/);
});

test('Fix 2: pinned --check succeeds (direction=upgrade) when the tag resolves cleanly AND its metadata matches', async (t) => {
  const name = 'pin-check-ok';
  makeSkillDir(name, '1.0.0');
  writeComponentsJson({ [name]: { version: '1.0.0', repo: 'org/demo' } });
  const tempDir = '/tmp/fake-tempdir-check-ok';

  scenario.downloadToTemp = () => ({ success: true, tempDir });
  // The downloaded package's own metadata must match the requested version —
  // --check now runs the same pre-swap validation the real upgrade does (P2).
  scenario.getLocalVersion = () => ({ success: true, version: '2.0.0' });

  const { exitCode, output } = await runUpgradeCli(t, [`${name}@2.0.0`, '--check', '--json']);

  assert.equal(exitCode, null);
  assert.equal(output.success, true);
  assert.equal(output.direction, 'upgrade');
  assert.equal(output.target, '2.0.0');
});

test('Fix 2/P2 (zylos0t re-review): pinned --check FAILS (parity with real upgrade) when the tag resolves but its package metadata != requested version', async (t) => {
  const name = 'pin-check-metadata-mismatch';
  makeSkillDir(name, '1.0.0');
  writeComponentsJson({ [name]: { version: '1.0.0', repo: 'org/demo' } });
  const before = readComponentsJson();
  const tempDir = '/tmp/fake-tempdir-check-mismatch';

  scenario.downloadToTemp = () => ({ success: true, tempDir });
  // Tag downloads fine, but the package inside reports a DIFFERENT version than
  // requested — the real `zylos upgrade x@2.0.0` would reject this pre-swap, so
  // `--check` must reject it too (no false green).
  scenario.getLocalVersion = (dir) => (dir === tempDir ? { success: true, version: '2.0.0-oops' } : { success: true, version: '1.0.0' });

  const { exitCode, output } = await runUpgradeCli(t, [`${name}@2.0.0`, '--check', '--json']);

  assert.equal(exitCode, 1, '--check must surface the would-be refusal, not report success');
  assert.equal(output.error, 'version_download_mismatch');
  assert.equal(output.action, 'check');
  assert.deepStrictEqual(readComponentsJson(), before, '--check must never mutate the registry');
});

// ---------------------------------------------------------------------------
// Fix 3: persist the exact source tag on pinned success
// ---------------------------------------------------------------------------

test('Fix 3: a fully successful pin persists source={type: github-release, ref: <exact tag>, refType: tag}', async (t) => {
  const name = 'pin-source-tag';
  makeSkillDir(name, '1.0.0');
  writeComponentsJson({
    [name]: {
      version: '1.0.0',
      repo: 'org/demo',
      // Stale source from an earlier branch install — must be overwritten
      // once this component is pinned to an exact release tag. (Not a
      // "local-*" source type: that would trip the unrelated
      // getLocalSourceUpgradeError guard earlier in upgradeComponent().)
      source: { type: 'github-release', repo: 'org/demo', ref: 'main', refType: 'branch' },
    },
  });
  const tempDir = '/tmp/fake-tempdir-source';

  scenario.getRepo = () => 'org/demo';
  scenario.downloadToTemp = () => ({ success: true, tempDir });
  scenario.getLocalVersion = () => ({ success: true, version: '2.0.0' });
  scenario.runUpgrade = () => ({ success: true, to: '2.0.0', pinnedSwapCompleted: true, steps: [] });

  const { exitCode, output } = await runUpgradeCli(t, [`${name}@2.0.0`, '--yes', '--json']);

  assert.equal(exitCode, null);
  assert.equal(output.success, true);
  const after = readComponentsJson();
  assert.equal(after[name].version, '2.0.0');
  assert.deepStrictEqual(after[name].source, { type: 'github-release', repo: 'org/demo', ref: '2.0.0', refType: 'tag' });
});

test('Fix 3: source is NOT updated when the pin fails pre-swap validation', async (t) => {
  const name = 'pin-source-tag-fail';
  makeSkillDir(name, '1.0.0');
  const staleSource = { type: 'github-release', repo: 'org/demo', ref: 'main', refType: 'branch' };
  writeComponentsJson({ [name]: { version: '1.0.0', repo: 'org/demo', source: staleSource } });
  const tempDir = '/tmp/fake-tempdir-source-fail';

  scenario.downloadToTemp = () => ({ success: true, tempDir });
  scenario.getLocalVersion = (dir) => (dir === tempDir ? { success: true, version: '1.9.9' } : { success: true, version: '1.0.0' });
  scenario.runUpgrade = () => { throw new Error('runUpgrade must NOT be called'); };

  const { exitCode, output } = await runUpgradeCli(t, [`${name}@2.0.0`, '--yes', '--json']);

  assert.equal(exitCode, 1);
  assert.equal(output.error, 'version_download_mismatch');
  assert.deepStrictEqual(readComponentsJson()[name].source, staleSource);
});
