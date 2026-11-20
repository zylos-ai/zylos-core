import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { completeUpgradeFinalization, resumeUpgradeFinalization } from '../self-upgrade.js';
import { requestRuntimeRestart } from '../request-runtime-restart.js';
import { resumeFinalize } from '../upgrade-resume.js';
import { formatFinalizeResult } from '../../commands/component.js';
import { serviceRestartFixture } from './helpers/service-restart-fixture.js';

const maintenance = createRequire(import.meta.url)('../upgrade-maintenance.cjs');
const MANUAL_RESTART = /Manual runtime restart required/;

function finalizationFixture(t, from) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-session-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zylos/config.json'), '{}');
  const ctx = { zylosDir: root, from, to: '1.0.0', tempDir: null, servicesWereRunning: [], steps: [], mergeConflicts: [], mergedFiles: [] };
  ctx.journal = { phase: 'compensation_closed' };
  ctx.transactionDir = path.join(root, 'transaction');
  ctx.maintenance = { transaction: () => ctx.journal, classifyCutoff: () => 'closed',
    update(_dir, journal, changes) { Object.assign(journal, changes); }, stop() {}, canRecognizeProcesses: () => true };
  return ctx;
}

// The real restart request runs with recording stand-ins for the C4 control queue and the supervisor socket.
function finalizationDeps(calls) {
  return {
    updateConfig() {}, ensureMemoryMigration() {}, rotateSession() {}, verifyPublicationForServices() {}, protectedSuccess() {},
    startServices: () => ({ status: 'done' }), verifyServices: () => ({ status: 'done' }),
    restartErroredServices: () => ({ status: 'done' }),
    finalizeWebConsoleRemoval: async () => ({ warnings: [] }), ensureLogRotation: () => ({ state: 'present' }),
    dashboardOwner: { verifyDashboard: () => ({ state: 'ready', errors: [] }) },
    readModeStatus: () => ({ ok: true, data: { sessionMode: null, transition: null } }),
    restart: options => requestRuntimeRestart({ ...options,
      send: async request => {
        calls.push(request);
        return { kind: 'accepted', sent: true, reply: { result: 'done_empty', runCount: 0 } };
      },
      lookup: async () => assert.fail('an accepted restart needs no lookup') }),
    audit: () => [],
  };
}

test('pre-migration self-upgrade completes with the empty supervisor restart request', async t => {
  const calls = [];
  const result = await completeUpgradeFinalization(finalizationFixture(t, '0.9.6'), finalizationDeps(calls));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.completion.sessionRestart, 'done_empty');
  assert.equal(result.completion.modeTransition, 'pending_auto');
  assert.deepEqual(calls.map(({ type, reason }) => ({ type, reason })), [{ type: 'restart_all', reason: 'upgrade' }]);
});

function interruptedUpgrade(t, from) {
  const f = serviceRestartFixture(t, { names: [] });
  const root = f.env.ZYLOS_DIR, id = 'upgrade-interrupted', dir = path.join(root, '.backup/self-upgrade', id), db = path.join(root, '.backup/db', id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.mkdirSync(db, { recursive: true, mode: 0o700 });
  const manifest = { formatVersion: 2, function: 'core-self-upgrade-db', status: 'complete', id,
    databases: ['comm-bridge/c4.db', 'scheduler/scheduler.db', 'web-console/web-console.db', 'components/dashboard/dashboard.db'].map(source =>
      ({ source, status: 'missing', file: null, bytes: 0, sha256: null, userVersion: null, integrityCheck: null })) };
  maintenance.durable(path.join(db, 'manifest.json'), manifest);
  const digest = maintenance.hash(path.join(db, 'manifest.json'));
  // Finalization stopped after the cutoff closed; --resume-finalize continues from the journal alone.
  const journal = { ...f.j, transactionId: id, phase: 'recovery_required', resumePhase: 'compensation_closed', installationIntent: true,
    from, to: '1.0.0', dbBackupDir: db, snapshotManifestHash: digest, lastError: 'services did not start',
    compensationCutoff: { formatVersion: 1, closed: true, transactionId: id, snapshotManifestHash: digest, closedAt: new Date().toISOString(), writer: 'finalizer' },
    postCutoff: { items: { hooks: { state: 'done' } } } };
  maintenance.durable(path.join(dir, 'journal.json'), journal);
  const read = () => maintenance.read(path.join(dir, 'journal.json'));
  const m = { ...maintenance, discover: () => ({ candidates: [{ dir, journal: read() }], diagnostics: [] }), transaction: read, acquire: () => () => {}, marker: () => {}, stop: () => {} };
  return { root, dir, m, read };
}

test('resume-finalize submits the same supervisor restart after a pre-migration upgrade interruption', async t => {
  const from = '0.9.6';
  const f = interruptedUpgrade(t, from), calls = [];
  let finalizedFrom;
  const result = await resumeFinalize(f.root, {}, { maintenance: f.m, quiesce: () => {}, finalize: ctx => {
    finalizedFrom = ctx.from;
    return resumeUpgradeFinalization(ctx, { ...finalizationDeps(calls), publish: () => ({ ok: true }),
      protectedSuccess: ctx => f.m.update(f.dir, ctx.journal, { phase: 'upgrade_complete' }) });
  } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(finalizedFrom, from);
  assert.equal(f.read().phase, 'upgrade_complete');
  const text = formatFinalizeResult(result);
  assert.doesNotMatch(text, MANUAL_RESTART);
  assert.deepEqual(calls.map(({ type, reason }) => ({ type, reason })), [{ type: 'restart_all', reason: 'upgrade' }]);
  assert.equal(result.data.completion.sessionRestart, 'done_empty');
});
