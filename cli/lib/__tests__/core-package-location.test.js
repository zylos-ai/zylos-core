import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { writeCorePackageLocation } from '../core-package-location.js';
import { step5_syncCoreSkills } from '../self-upgrade.js';
import { deployUpgradeBootstrap } from '../upgrade-protection.js';

const require = createRequire(import.meta.url);
const maintenance = require('../upgrade-maintenance.cjs');
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
