import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runSelfUpgradeFinalize, resumeUpgradeFinalization } from '../self-upgrade.js';
import { resumeFinalize } from '../upgrade-resume.js';
import { generateManifest, loadManifest, saveMergeBaseline } from '../manifest.js';
import { smartSync } from '../smart-merge.js';

const actual = createRequire(import.meta.url)('../upgrade-maintenance.cjs');

function fixture(t, { added = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-baselines-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.backup/self-upgrade/tx'), download = path.join(root, 'download');
  const skillsDir = path.join(root, '.claude/skills');
  const target = path.join(skillsDir, 'example'), source = path.join(download, 'skills/example');
  const db = path.join(root, '.backup/db/tx');
  for (const folder of [dir, source, target, db]) fs.mkdirSync(folder, { recursive: true });
  if (!added) {
    fs.writeFileSync(path.join(source, 'SKILL.md'), 'upstream v1\n');
    fs.copyFileSync(path.join(source, 'SKILL.md'), path.join(target, 'SKILL.md'));
    saveMergeBaseline(target, source, generateManifest(source));
  }
  fs.writeFileSync(path.join(source, 'SKILL.md'), 'upstream v2\n');
  fs.writeFileSync(path.join(target, 'local-only.txt'), 'user owned\n');
  const manifest = { formatVersion: 2, function: 'core-self-upgrade-db', status: 'complete', id: 'tx',
    databases: ['comm-bridge/c4.db', 'scheduler/scheduler.db', 'web-console/web-console.db', 'components/dashboard/dashboard.db']
      .map(source => ({ source, status: 'missing', file: null, bytes: 0, sha256: null, userVersion: null, integrityCheck: null })) };
  actual.durable(path.join(db, 'manifest.json'), manifest);
  const journal = { transactionId: 'tx', zylosDir: root, skillsDir, initialIdentity: {}, installationIntent: true, phase: 'installing',
    from: 'old', to: 'new', dbBackupDir: db, snapshotManifestHash: actual.hash(path.join(db, 'manifest.json')), originalServices: [] };
  actual.durable(path.join(dir, 'journal.json'), journal);
  const load = () => actual.read(path.join(dir, 'journal.json'));
  const m = { ...actual, transaction: load, validateOriginalJournal: () => {}, stop: () => {}, marker: () => {},
    canRecognizeProcesses: () => true, acquire: () => () => {},
    discover: () => ({ candidates: [{ dir, journal: load() }], diagnostics: [] }) };
  let starts = 0;
  const deps = { maintenance: m, verifySnapshot: () => {}, assertDashboardUninstalled: () => {},
    syncSkills: ctx => {
      const merged = smartSync(source, target);
      assert.deepEqual(merged.errors, []);
      ctx.pendingBaselines = [{ destDir: target, srcDir: source, manifest: merged.nextManifest }];
      return { step: 5, status: 'done' };
    },
    installDependencies: () => ({ step: 6, status: 'done' }), prepareRuntimeClis: () => {}, dataReady: () => {},
    prepareRuntime: () => ({}), stage: () => ({}),
    commitCutoff: ctx => m.update(dir, ctx.journal, { phase: 'compensation_closed',
      postCutoff: { items: { hooks: { state: 'pending' } } }, dashboardInstall: null,
      compensationCutoff: { formatVersion: 1, transactionId: 'tx', snapshotManifestHash: journal.snapshotManifestHash,
        closed: true, closedAt: new Date().toISOString(), writer: 'finalizer' } }),
    publish: () => ({ ok: false, lastError: { code: 'INJECTED_CUTOFF_FAILURE', reason: 'publication interrupted' } }),
    updateConfig: () => {}, ensureMemoryMigration: () => {}, refreshMaintenanceReader: () => {},
    startServices: () => { starts++; return { status: 'done' }; }, verifyServices: () => ({ status: 'done' }),
    dashboardOwner: { verifyDashboard: () => ({ state: 'ready', errors: [] }) },
    readModeStatus: () => ({ sessionMode: 'single', transition: null }),
    readMode: () => ({ mode: 'single' }), readTransition: () => null,
    restart: () => ({ ok: true, data: { result: 'exit_enqueued' } }), audit: () => [],
    protectedSuccess: ctx => m.update(dir, ctx.journal, { phase: 'upgrade_complete' }) };
  const initial = () => runSelfUpgradeFinalize({ schemaVersion: 2, preInstallProtection: true,
    zylosDir: root, transactionId: 'tx', transactionDir: dir, tempDir: download }, deps);
  const resume = () => resumeFinalize(root, {}, { maintenance: m, quiesce: () => {},
    finalize: ctx => {
      assert.equal(Object.hasOwn(ctx, 'pendingBaselines'), false);
      assert.equal(Object.hasOwn(ctx, 'tempDir'), false);
      return resumeUpgradeFinalization(ctx, { ...deps, publish: () => ({ ok: true }) });
    } });
  return { initial, resume, load, dir, download, target, source, get starts() { return starts; } };
}

for (const added of [false, true]) test(`fresh resume commits actual ${added ? 'first' : 'updated'} baseline and subsequent upgrade has no false conflict`, async t => {
  const f = fixture(t, { added });
  const first = await f.initial();
  assert.equal(first.success, false);
  assert.match(first.error, /publication interrupted/);
  assert.equal(f.load().phase, 'recovery_required');
  assert.equal(f.starts, 0);
  if (added) assert.equal(loadManifest(f.target), null);
  else {
    assert.equal(fs.readFileSync(path.join(f.target, '.zylos/originals/SKILL.md'), 'utf8'), 'upstream v1\n');
    assert.notEqual(loadManifest(f.target).files['SKILL.md'], generateManifest(f.target).files['SKILL.md']);
  }
  // Drop all downloaded inputs: only the transaction's fsynced copy survives.
  fs.rmSync(f.download, { recursive: true });
  const result = await f.resume();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.load().phase, 'upgrade_complete');
  assert.equal(f.starts, 1);
  const original = path.join(f.target, '.zylos/originals/SKILL.md');
  assert.equal(fs.readFileSync(original, 'utf8'), 'upstream v2\n');
  assert.equal(loadManifest(f.target).files['SKILL.md'], generateManifest(path.dirname(original)).files['SKILL.md']);
  assert.equal(Object.hasOwn(loadManifest(f.target).files, 'local-only.txt'), false);
  fs.mkdirSync(f.source, { recursive: true });
  fs.writeFileSync(path.join(f.source, 'SKILL.md'), 'upstream v3\n');
  const next = smartSync(f.source, f.target);
  assert.deepEqual(next.errors, []);
  assert.deepEqual(next.conflicts, []);
  assert.deepEqual(next.overwritten, ['SKILL.md']);
  assert.equal(fs.readFileSync(path.join(f.target, 'SKILL.md'), 'utf8'), 'upstream v3\n');
  assert.equal(fs.readFileSync(path.join(f.target, 'local-only.txt'), 'utf8'), 'user owned\n');
});

for (const defect of ['missing', 'corrupt']) test(`resume rejects ${defect} durable baseline before service startup`, async t => {
  const f = fixture(t);
  await f.initial();
  const before = loadManifest(f.target);
  const staged = path.join(f.dir, 'skill-baselines/example/SKILL.md');
  if (defect === 'missing') fs.unlinkSync(staged);
  else fs.writeFileSync(staged, 'untrusted bytes');
  const result = await f.resume();
  assert.equal(result.ok, false);
  assert.match(result.error.message, /baseline is corrupt/);
  assert.equal(f.load().phase, 'recovery_required');
  assert.equal(f.starts, 0);
  assert.deepEqual(loadManifest(f.target), before);
});
