import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProtectedPackageCrashFixture } from './helpers/protected-package-crash.js';

// Explicit opt-in: these tests install real npm packages into private prefixes
// and require registry access, native SQLite support, Linux /proc and flock.
for (const managedDashboard of [false, true]) for (const stage of ['before', 'after']) test(`real npm SIGKILL ${stage} install recovers v0.9.2-as-0.9.3 and permits retry${managedDashboard ? ' with retained Dashboard v20' : ''}`, {
  skip: process.env.ZYLOS_RUN_PACKAGE_CRASH_E2E !== '1', timeout: 1200000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `package-crash-${stage}-`));
  t.diagnostic(`Isolated fixture (retained on failure) at ${root}`);
  const f = createProtectedPackageCrashFixture(root, { managedDashboard }), { target } = await f.build();
  const original = f.logicalDatabases();
  assert.ok(Object.entries(original).every(([name, db]) => db.integrity === 'ok' && db.version === (name.startsWith('components/') ? 0 : 1)));
  const input = f.handoff(target, 'interrupted-download');
  const observed = await f.kill(input, stage);
  assert.equal(observed.journal.firstTakeover, true);
  assert.equal(observed.journal.dashboardOwnerManaged, managedDashboard);
  assert.equal(observed.journal.installationIntent === true, stage === 'after');
  // Before installation, the downloaded target represents the future 0.9.3
  // bridge; afterwards discovery comes from the actual installed target.
  const recovered = f.recover(stage === 'after' ? f.core : input.tempDir);
  assert.equal(recovered.active, true);
  if (stage === 'after') {
    assert.equal(recovered.result.completed, true, JSON.stringify(recovered));
    assert.equal(recovered.result.stage, 'restored_complete');
  } else {
    assert.equal(recovered.result.complete, true, JSON.stringify(recovered));
    assert.equal(recovered.result.stage, 'aborted_before_install');
  }
  assert.equal(f.version(), '0.9.3');
  assert.deepEqual(f.logicalDatabases(), original);
  const saved = f.journal().find(item => item.dir === observed.dir).journal;
  assert.equal(saved.phase, stage === 'after' ? 'restored_complete' : 'aborted_before_install');
  if (stage === 'after') assert.equal(saved.originalPackageRestored, true);
  if (managedDashboard) {
    assert.equal(fs.existsSync(path.join(f.core, 'skills/dashboard')), false);
    assert.equal(fs.existsSync(path.join(f.skills, 'dashboard')), false);
  }
  const retry = f.entry(f.handoff(target, 'retry-download'));
  assert.equal(retry.status, 0, JSON.stringify(retry));
  assert.equal(retry.result.success, true, JSON.stringify(retry));
  assert.equal(retry.result.completion.install, 'done');
  assert.equal(f.version(), '1.0.0');
  const next = f.logicalDatabases();
  assert.ok(Object.values(next).every(db => db.integrity === 'ok'));
  assert.match(JSON.stringify(next['comm-bridge/c4.db']), /durable business row/);
  if (managedDashboard) assertDashboardUpgraded(next);
  assert.equal(f.journal().filter(item => item.journal.phase === 'upgrade_complete').length, 1);
  assert.match(fs.readFileSync(f.calls, 'utf8'), /pm2 stop activity-monitor/);
  fs.rmSync(root,{recursive:true});
});

function assertDashboardUpgraded(databases) {
  const dashboard = databases['components/dashboard/dashboard.db'];
  assert.equal(dashboard.integrity, 'ok');
  const migrations = dashboard.tables.find(table => table.schema.name === 'schema_migrations');
  assert.deepEqual(migrations.rows.map(row => JSON.parse(row).version).sort((a, b) => a - b), [20, 21]);
  assert.match(JSON.stringify(dashboard), /preserved Dashboard row/);
}

for (const failureStage of [undefined, 'before', 'after']) test(`first Dashboard takeover with retained v20 ${failureStage ? `compensates ${failureStage} installation failure` : 'completes upgrade'}`, {
  skip: process.env.ZYLOS_RUN_PACKAGE_CRASH_E2E !== '1', timeout: 1200000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `package-dashboard-${failureStage || 'success'}-`));
  t.diagnostic(`Isolated fixture (retained on failure) at ${root}`);
  const f = createProtectedPackageCrashFixture(root, { managedDashboard: true });
  const { target } = await f.build();
  const original = f.logicalDatabases();
  const result = f.entry(f.handoff(target, 'download'), { failureStage });
  const saved = f.journal();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].journal.firstTakeover, true);
  assert.equal(saved[0].journal.dashboardOwnerManaged, true);
  if (failureStage) {
    assert.equal(result.status, 1, JSON.stringify(result));
    assert.equal(result.result.success, false);
    assert.match(result.result.error, failureStage === 'before' ? /injected pre-install failure/ : /injected post-install failure/);
    assert.equal(result.result.recovery_required, false, JSON.stringify(result));
    assert.equal(saved[0].journal.phase, failureStage === 'after' ? 'restored_complete' : 'aborted_before_install');
    assert.equal(saved[0].journal.installationIntent === true, failureStage === 'after');
    assert.equal(f.version(), '0.9.3');
    assert.deepEqual(f.logicalDatabases(), original);
    assert.equal(fs.existsSync(path.join(f.core, 'skills/dashboard')), false);
    assert.equal(fs.existsSync(path.join(f.skills, 'dashboard')), false);
    const retry = f.entry(f.handoff(target, 'retry-download'));
    assert.equal(retry.status, 0, JSON.stringify(retry));
    assert.equal(retry.result.success, true, JSON.stringify(retry));
  } else {
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.equal(result.result.success, true, JSON.stringify(result));
    assert.equal(result.result.completion.install, 'done');
  }
  assert.equal(f.version(), '1.0.0');
  assertDashboardUpgraded(f.logicalDatabases());
  assert.equal(f.journal().filter(item => item.journal.phase === 'upgrade_complete').length, 1);
  assert.match(fs.readFileSync(f.calls, 'utf8'), /pm2 stop activity-monitor/);
  fs.rmSync(root, { recursive: true });
});
