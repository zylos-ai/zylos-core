import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureInitLogRotation } from '../../commands/init.js';
import { completeUpgradeFinalization } from '../self-upgrade.js';
import { formatSelfUpgradeCompletion } from '../../commands/component.js';
import { ensurePm2LogRotate, logRotateInstallCommand } from '../pm2-logrotate.js';
import { fakePm2 } from './helpers/fake-pm2-logrotate.js';

// Init and upgrade callers run the real log rotation code against a fake `pm2`
// under a private PM2_HOME. Other finalization services stay injected.

function output() {
  const lines = { log: [], warn: [] };
  return { lines, log: text => lines.log.push(text), warn: text => lines.warn.push(text) };
}

for (const quiet of [false, true]) test(`init reports a failed install as one warning and still succeeds (quiet=${quiet})`, async t => {
  const f = fakePm2(t, { mode: 'fail' });
  const out = output();
  const result = await ensureInitLogRotation({ quiet }, { ensure: () => ensurePm2LogRotate({ env: f.env }), log: out.log, warn: out.warn });
  assert.equal(result.state, 'failed');
  assert.deepEqual(out.lines.log, []);
  assert.equal(out.lines.warn.length, 1);
  assert.match(out.lines.warn[0], /PM2 log rotation is not installed/);
  assert.ok(out.lines.warn[0].includes(logRotateInstallCommand()));
});

test('init installs a missing module and keeps an existing one', async t => {
  const f = fakePm2(t);
  const out = output();
  const deps = { ensure: () => ensurePm2LogRotate({ env: f.env }), log: out.log, warn: out.warn };
  assert.equal((await ensureInitLogRotation({}, deps)).state, 'installed');
  assert.match(out.lines.log[0], /PM2 log rotation installed \(pm2-logrotate: max_size=10M, retain=7, compress=true, workerInterval=30, rotateInterval=0 0 \* \* \*\)/);
  const callsAfterInstall = f.calls().length;
  assert.equal((await ensureInitLogRotation({}, deps)).state, 'present');
  assert.match(out.lines.log[1], /PM2 log rotation present \(pm2-logrotate settings kept\)/);
  assert.equal(f.calls().length, callsAfterInstall);
  assert.deepEqual(out.lines.warn, []);
});

test('init turns an unexpected error into a warning instead of failing', async () => {
  const out = output();
  const result = await ensureInitLogRotation({ quiet: true }, { ensure: () => { throw Error('PM2 home unavailable'); }, log: out.log, warn: out.warn });
  assert.equal(result.state, 'failed');
  assert.match(out.lines.warn[0], /PM2 log rotation is not installed \(PM2 home unavailable\)/);
});

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
    readModeStatus: () => ({ sessionMode: 'multi', transition: null }), readMode: () => ({ mode: 'multi' }), readTransition: () => null,
    restart: () => { calls.push('restart'); return { ok: true, data: { result: 'accepted' } }; },
    audit: () => [], protectedSuccess: () => { calls.push('terminal'); },
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

test('upgrade installs a missing module and leaves an existing one untouched', async t => {
  const f = fakePm2(t);
  const first = finalizationFixture(t);
  const installed = await completeUpgradeFinalization(first.ctx, { ...first.deps, ensureLogRotation: () => ensurePm2LogRotate({ env: f.env }) });
  assert.equal(installed.success, true);
  assert.deepEqual(installed.warnings, []);
  assert.equal(installed.steps.find(step => step.name === 'pm2_log_rotation').status, 'done');
  const conf = fs.readFileSync(f.confFile);
  const calls = f.calls().length;
  const second = finalizationFixture(t);
  const present = await completeUpgradeFinalization(second.ctx, { ...second.deps, ensureLogRotation: () => ensurePm2LogRotate({ env: f.env }) });
  assert.equal(present.success, true);
  assert.deepEqual(present.steps.find(step => step.name === 'pm2_log_rotation'),
    { step: 7, name: 'pm2_log_rotation', status: 'skipped', message: 'pm2-logrotate already present; settings kept' });
  assert.equal(f.calls().length, calls);
  assert.deepEqual(fs.readFileSync(f.confFile), conf);
});

test('upgrade finalization uses the default log rotation step with the process PM2 environment', async t => {
  const f = fakePm2(t, { mode: 'fail' });
  f.writeConf({ 'module-db-v2': { 'pm2-logrotate': {} }, 'pm2-logrotate': { retain: '90' } });
  const saved = { PATH: process.env.PATH, PM2_HOME: process.env.PM2_HOME, FAKE_PM2_LOG: process.env.FAKE_PM2_LOG };
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  Object.assign(process.env, { PATH: f.env.PATH, PM2_HOME: f.env.PM2_HOME, FAKE_PM2_LOG: f.env.FAKE_PM2_LOG });
  const u = finalizationFixture(t);
  const result = await completeUpgradeFinalization(u.ctx, u.deps);
  assert.equal(result.success, true);
  assert.equal(result.steps.find(step => step.name === 'pm2_log_rotation').message, 'pm2-logrotate already present; settings kept');
  assert.deepEqual(f.calls(), []);
  assert.equal(f.conf()['pm2-logrotate'].retain, '90');
});

test('upgrade turns an unexpected log rotation error into a warning', async t => {
  const u = finalizationFixture(t);
  const result = await completeUpgradeFinalization(u.ctx, { ...u.deps, ensureLogRotation: () => { throw Error('PM2 home unavailable'); } });
  assert.equal(result.success, true);
  assert.match(result.warnings[0], /PM2 log rotation is not installed \(PM2 home unavailable\)/);
});
