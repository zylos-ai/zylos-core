// covers: cli/lib/upgrade-entry.js cli/lib/upgrade-discovery.js cli/lib/upgrade-maintenance.cjs cli/lib/upgrade-recovery.cjs cli/lib/dashboard-install.js cli/lib/request-runtime-restart.js cli/lib/am-sock-client.js cli/lib/__tests__/helpers/protected-package-crash.js cli/lib/__tests__/helpers/stop-after-prepared-journal.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProtectedPackageCrashFixture } from './helpers/protected-package-crash.js';

function createFixtureRoot() {
  if (process.platform === 'linux') {
    try { return fs.mkdtempSync('/dev/shm/pkg-crash-'); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(error.code)) throw error;
    }
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-crash-'));
}

// Integration: real npm install and recovery before and after installer exit.
// Run for package recovery changes, not unrelated CLI changes. Use the isolated
// runner; the fixture uses a private HOME, ZYLOS_DIR, PM2_HOME and npm prefix.
for (const managedDashboard of [false, true]) for (const stage of ['before', 'after']) test(`real npm SIGKILL ${stage} install recovers v0.9.2-as-0.9.3 and permits retry${managedDashboard ? ' with retained Dashboard v20' : ''}`, {
  timeout: 1200000,
}, async t => {
  const root = createFixtureRoot();
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
  const retry = await f.entry(f.handoff(target, 'retry-download'), t.signal);
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
