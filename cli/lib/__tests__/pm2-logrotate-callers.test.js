import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completeUpgradeFinalization } from '../self-upgrade.js';
import { formatSelfUpgradeCompletion } from '../../commands/component.js';
import { ensurePm2LogRotate, logRotateInstallCommand } from '../pm2-logrotate.js';
import { fakePm2 } from './helpers/fake-pm2-logrotate.js';

// Init and upgrade callers run the real log rotation code against a fake `pm2`
// under a private PM2_HOME. Other finalization services stay injected.


function finalizationFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'logrotate-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zylos/config.json'), '{}');
  const ctx = { zylosDir: root, from: 'old', to: 'new', tempDir: null, servicesWereRunning: ['scheduler'], steps: [],
    mergeConflicts: [], mergedFiles: [], journal: { phase: 'compensation_closed' }, transactionDir: path.join(root, 'transaction') };
  ctx.maintenance = { transaction: () => ctx.journal, classifyCutoff: () => 'closed', update(_dir, journal, changes) { Object.assign(journal, changes); },
    stop() {}, canRecognizeProcesses: () => true };
  const calls = [];
  const deps = {
    updateConfig() {}, ensureMemoryMigration() {}, rotateSession() {}, verifyPublicationForServices() {},
    startServices: () => { calls.push('start'); return { status: 'done' }; },
    verifyServices: () => ({ status: 'done' }),
    finalizeWebConsoleRemoval: () => ({ warnings: [], pm2Changed: false }),
    dashboardOwner: { verifyDashboard: () => ({ state: 'ready', errors: [] }) },
    readModeStatus: () => ({ sessionMode: 'multi', transition: null }),
    restart: () => { calls.push('restart'); return { ok: true, data: { result: 'accepted' } }; },
    protectedSuccess: () => { calls.push('terminal'); },
  };
  return { ctx, deps, calls };
}

test('upgrade completes with a warning and install command when the module cannot be installed', async t => {
  const f = fakePm2(t, { mode: 'fail' });
  const u = finalizationFixture(t);
  const result = await completeUpgradeFinalization(u.ctx, { ...u.deps, ensureLogRotation: () => ensurePm2LogRotate({ env: f.env }) });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.completion.install, 'done');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /PM2 log rotation is not installed \(pm2 install exited with 1/);
  assert.deepEqual(result.steps.find(step => step.name === 'pm2_log_rotation'),
    { step: 7, name: 'pm2_log_rotation', status: 'skipped', message: 'pm2-logrotate not installed; see the upgrade warning' });
  assert.deepEqual(u.calls, ['start', 'restart', 'terminal']);
  const printed = formatSelfUpgradeCompletion(result).split('\n').filter(line => line.startsWith('Upgrade warning: PM2 log rotation'));
  assert.equal(printed.length, 1);
  assert.ok(printed[0].endsWith(logRotateInstallCommand()));
});
