import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeCorePackageLocation } from '../core-package-location.js';
import { step5_syncCoreSkills, completeUpgradeFinalization, resumeUpgradeFinalization } from '../self-upgrade.js';
import { deployUpgradeBootstrap } from '../upgrade-protection.js';
import { formatSelfUpgradeCompletion } from '../../commands/component.js';

const require = createRequire(import.meta.url);
const maintenance = require('../upgrade-maintenance.cjs');
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-location-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zylosDir = path.join(root, 'home/zylos');
  const skillDir = path.join(zylosDir, '.claude/skills/comm-bridge');
  fs.mkdirSync(skillDir, { recursive: true });
  const packageAt = name => {
    const directory = path.join(root, name);
    fs.mkdirSync(path.join(directory, 'cli/lib'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'zylos', type: 'module', version: '1.0.0' }));
    fs.writeFileSync(path.join(directory, 'cli/lib/config.js'), 'export {};\n');
    return directory;
  };
  const oldRoot = packageAt('old-package'), packageRoot = packageAt('installed-package'), tempDir = packageAt('download');
  fs.mkdirSync(path.join(tempDir, 'skills'));
  return { root, zylosDir, skillDir, packageRoot, oldRoot, tempDir,
    record: path.join(skillDir, '.zylos/core-package.json') };
}

test('location publication validates package identity and atomically retains the old record on failure', t => {
  const f = fixture(t);
  writeCorePackageLocation({ skillDir: f.skillDir, packageRoot: f.oldRoot });
  const before = fs.readFileSync(f.record);
  const failing = Object.create(fs);
  failing.renameSync = () => { throw Object.assign(Error('record rename denied'), { code: 'EACCES' }); };
  assert.throws(() => writeCorePackageLocation({ skillDir: f.skillDir, packageRoot: f.packageRoot, fs: failing }), /rename denied/);
  assert.equal(fs.readFileSync(f.record).equals(before), true);
  assert.deepEqual(fs.readdirSync(path.dirname(f.record)), ['core-package.json']);
  fs.writeFileSync(path.join(f.packageRoot, 'package.json'), JSON.stringify({ name: 'other' }));
  assert.throws(() => writeCorePackageLocation({ skillDir: f.skillDir, packageRoot: f.packageRoot }), /zylos package/);
  assert.equal(fs.readFileSync(f.record).equals(before), true);
});

test('location publication rejects symlink metadata instead of modifying another directory', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.skillDir, '.zylos'));
  assert.throws(() => writeCorePackageLocation({ skillDir: f.skillDir, packageRoot: f.packageRoot }), /Unsafe.*metadata/);
  assert.equal(fs.readdirSync(outside).length, 0);
});

const synced = () => ({ synced: [], added: [], merged: [], deleted: [], preserved: [], conflicts: [], errors: [], pendingBaselines: [] });

// Integration boundary: real installed-package writer plus the real sync step,
// with only skill copying injected. Run for publication timing/root changes;
// skip unrelated runtime changes. Private files only; no installer/services.
test('skill sync publishes the installed root instead of the downloaded source and refreshes an old record', t => {
  const f = fixture(t);
  writeCorePackageLocation({ skillDir: f.skillDir, packageRoot: f.oldRoot });
  const ctx = { packageRoot: f.packageRoot, coreDir: f.oldRoot, tempDir: f.tempDir, mode: 'merge' };
  const result = step5_syncCoreSkills(ctx, { zylosDir: f.zylosDir, syncCoreSkills: synced });
  assert.equal(result.status, 'done');
  assert.deepEqual(read(f.record), { v: 1, packageRoot: f.packageRoot });
  assert.notEqual(read(f.record).packageRoot, f.tempDir);
  assert.equal(ctx.corePackageWarnings?.length ?? 0, 0);
  const original = fs.readFileSync(f.record);
  const failed = step5_syncCoreSkills({ ...ctx, packageRoot: f.oldRoot }, { zylosDir: f.zylosDir,
    syncCoreSkills: () => ({ ...synced(), errors: ['comm-bridge copy failed'] }) });
  assert.equal(failed.status, 'failed');
  assert.equal(fs.readFileSync(f.record).equals(original), true);
});

// Integration boundary: real sync warning -> successful finalization result ->
// real human formatter. Run for warning/result projection changes; skip unrelated
// runtime work. Temporary deployment, injected services/CLI/DB observations;
// no sockets, child processes or production services are started.
test('record publication failure remains a distinct JSON and readable warning without failing upgrade completion', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.skillDir, '.zylos'), 'metadata blocked');
  const ctx = { packageRoot: f.packageRoot, coreDir: f.oldRoot, tempDir: f.tempDir, mode: 'merge',
    zylosDir: f.zylosDir, from: '0.9.5', to: '1.0.0', servicesWereRunning: [], steps: [], mergeConflicts: [], mergedFiles: [],
    journal: { phase: 'compensation_closed' }, transactionDir: path.join(f.root, 'transaction'),
    maintenance: { canRecognizeProcesses: () => true } };
  const step = step5_syncCoreSkills(ctx, { zylosDir: f.zylosDir, syncCoreSkills: synced });
  assert.equal(step.status, 'done');
  assert.equal(ctx.corePackageWarnings.length, 1);
  const finalizer = {
    updateConfig() {}, ensureMemoryMigration() {}, verifyPublicationForServices() {},
    startServices: () => ({ status: 'done' }), verifyServices: () => ({ status: 'done' }),
    dashboardOwner: { verifyDashboard: () => ({ state: 'ready', errors: [] }) },
    readModeStatus: () => ({ sessionMode: 'single', transition: null }),
    readMode: () => ({ mode: 'single' }), readTransition: () => null,
    restart: () => ({ ok: true, data: { result: 'exit_enqueued' } }), audit: () => [], protectedSuccess() {},
  };
  const result = await completeUpgradeFinalization(ctx, finalizer);
  const json = JSON.parse(JSON.stringify(result));
  assert.equal(json.success, true);
  assert.equal(json.completion.install, 'done');
  assert.equal(json.corePackageWarnings[0].code, 'CORE_PACKAGE_LOCATION_WRITE_FAILED');
  assert.deepEqual(json.warnings, []);
  const text = formatSelfUpgradeCompletion(json);
  assert.match(text, /Core package location warning:/);
  assert.match(text, /ZYLOS_PACKAGE_ROOT/);
  assert.match(text, /zylos init/);
  assert.doesNotMatch(text, /Runtime warning/);
  ctx.journal.corePackageWarnings = structuredClone(json.corePackageWarnings);
  ctx.journal.originalServices = [];
  delete ctx.corePackageWarnings;
  ctx.dbManifest = {};
  const repaired = await resumeUpgradeFinalization(ctx, { ...finalizer, publish: () => ({ ok: true }) });
  assert.equal(repaired.success, true);
  assert.deepEqual(repaired.corePackageWarnings, json.corePackageWarnings);
});

// Integration boundary: real init's file-only skill-sync entry, in a bounded
// absolute-Node child. Run for init publication changes; skip other init/auth work.
// HOME/ZYLOS_DIR/PM2_HOME/TMPDIR point inside this owned temporary fixture; no
// services, authentication, network or installer is invoked by this helper.
test('initialization publishes the package that actually supplied its comm-bridge files', t => {
  const f = fixture(t), home = path.join(f.root, 'init-home'), zylosDir = path.join(home, 'zylos');
  const tmp = path.join(f.root, 'tmp'); fs.mkdirSync(tmp);
  const args = [fileURLToPath(new URL('./helpers/sync-core-skills.js', import.meta.url))];
  const options = {
    timeout: 30000, encoding: 'utf8', env: { ...process.env, HOME: home, ZYLOS_DIR: zylosDir,
      PM2_HOME: path.join(home, '.pm2'), TMPDIR: tmp, CODEX_HOME: path.join(home, '.codex') },
  };
  const output = execFileSync(process.execPath, args, options);
  assert.ok(JSON.parse(output.trim()).installed.includes('comm-bridge'));
  const record = path.join(zylosDir, '.claude/skills/comm-bridge/.zylos/core-package.json');
  assert.deepEqual(read(record), { v: 1, packageRoot: fs.realpathSync(repository) });
  fs.unlinkSync(record); fs.mkdirSync(record);
  const failure = execFileSync(process.execPath, args, options);
  assert.match(failure, /Failed to sync.*comm-bridge/);
  assert.equal(JSON.parse(failure.trim().split('\n').at(-1)).updated.includes('comm-bridge'), false);
  assert.equal(fs.statSync(record).isDirectory(), true);
});

// Integration boundary: actual protected recovery restoreCore over a private
// saved skill tree. Run for record placement/rollback changes; skip unrelated UI.
// The bootstrap, journal and backups are all owned temporary files. This invokes
// no package installer, runtime, database migration, PM2, socket or tmux process.
test('protected skill restoration restores the previous location record with the original tree', t => {
  const f = fixture(t);
  writeCorePackageLocation({ skillDir: f.skillDir, packageRoot: f.oldRoot });
  deployUpgradeBootstrap(f.zylosDir);
  const recovery = require(path.join(f.zylosDir, '.zylos/upgrade/recovery.cjs'));
  const transaction = path.join(f.root, 'saved'); fs.mkdirSync(transaction);
  const backup = path.join(transaction, 'code/skills/comm-bridge');
  fs.cpSync(f.skillDir, backup, { recursive: true });
  const originalHash = maintenance.treeHash(f.skillDir, { excludeNodeModules: false });
  const journal = { zylosDir: f.zylosDir, skillsDir: path.join(f.zylosDir, '.claude/skills'),
    initialIdentity: { ecosystemHash: null }, coreManifest: [{ name: 'comm-bridge', existedBefore: true, backedUp: true, originalHash }] };
  writeCorePackageLocation({ skillDir: f.skillDir, packageRoot: f.packageRoot });
  recovery.restoreCore(transaction, journal);
  assert.deepEqual(read(f.record), { v: 1, packageRoot: f.oldRoot });
  assert.equal(maintenance.treeHash(f.skillDir, { excludeNodeModules: false }), originalHash);
});
