import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { completeUpgradeFinalization, resumeUpgradeFinalization, LEGACY_SESSION_RESTART_NOTICE } from '../self-upgrade.js';
import { requestRuntimeRestart } from '../request-runtime-restart.js';
import { resumeFinalize } from '../upgrade-resume.js';
import { outputUpgradeResult } from '../upgrade-entry.js';
import { formatSelfUpgradeCompletion, formatFinalizeResult } from '../../commands/component.js';
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
function finalizationDeps(calls, { mode = null, transition = null } = {}) {
  return {
    updateConfig() {}, ensureMemoryMigration() {}, rotateSession() {}, verifyPublicationForServices() {}, protectedSuccess() {},
    startServices: () => ({ status: 'done' }), verifyServices: () => ({ status: 'done' }),
    restartErroredServices: () => ({ status: 'done' }),
    finalizeWebConsoleRemoval: async () => ({ warnings: [] }), ensureLogRotation: () => ({ state: 'present' }),
    dashboardOwner: { verifyDashboard: () => ({ state: 'ready', errors: [] }) },
    readModeStatus: () => ({ ok: true, data: { sessionMode: mode, transition } }),
    readMode: () => { calls.push('readMode'); return { mode, keyPresent: mode !== null }; },
    readTransition: () => { calls.push('readTransition'); return transition; },
    restart: options => requestRuntimeRestart({ ...options,
      enqueueExit: async () => { calls.push('enqueueExit'); return { checkControlId: 11, exitControlId: 12 }; },
      send: async (request, options) => { calls.push(request); return { kind: 'accepted', sent: true, reply: { result: 'accepted', runCount: 2 } }; },
      lookup: async () => assert.fail('an accepted restart needs no lookup') }),
    audit: () => [],
  };
}

function captureEntryOutput(result, jsonOutput) {
  let stdout = '', stderr = '';
  outputUpgradeResult(result, { jsonOutput }, { stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  return { stdout, stderr };
}

for (const from of ['0.9.6', '0.9.3', '0.10.0-beta.1']) test(`upgrade from ${from} leaves sessions to the router and says not to restart`, async t => {
  const ctx = finalizationFixture(t, from), calls = [];
  const result = await completeUpgradeFinalization(ctx, finalizationDeps(calls, { mode: null }));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(calls, []);
  assert.equal(result.completion.sessionRestart, 'closed_by_system');
  assert.deepEqual(result.sessionRestart, { ok: true, data: { result: 'closed_by_system', message: LEGACY_SESSION_RESTART_NOTICE } });
  assert.match(LEGACY_SESSION_RESTART_NOTICE, /closed by the system/);
  assert.match(LEGACY_SESSION_RESTART_NOTICE, /restart-claude/);

  const text = formatSelfUpgradeCompletion(result);
  assert.match(text, /^Session restart: closed_by_system$/m);
  assert.ok(text.split('\n').includes(LEGACY_SESSION_RESTART_NOTICE));
  assert.doesNotMatch(text, MANUAL_RESTART);

  const human = captureEntryOutput(result, false);
  assert.ok(human.stdout.split('\n').includes(LEGACY_SESSION_RESTART_NOTICE), human.stdout);
  assert.doesNotMatch(human.stdout + human.stderr, MANUAL_RESTART);
  const json = captureEntryOutput(result, true);
  assert.equal(json.stdout, JSON.stringify(result) + '\n');
  assert.equal(JSON.parse(json.stdout).completion.sessionRestart, 'closed_by_system');
  assert.ok(json.stderr.split('\n').includes(`Session notice: ${LEGACY_SESSION_RESTART_NOTICE}`), json.stderr);
  assert.doesNotMatch(json.stdout + json.stderr, MANUAL_RESTART);
});

const routes = [
  // Native single (mode key present) restarts its Origin like multi; only the pre-migration single queues /exit.
  { name: 'single', mode: 'single', transition: null, completion: 'accepted', calls: ['readMode', 'readTransition', 'restart_all'] },
  { name: 'unset single', mode: null, transition: null, completion: 'single_exit_enqueued', calls: ['readMode', 'readTransition', 'enqueueExit'] },
  { name: 'multi', mode: 'multi', transition: null, completion: 'accepted', calls: ['readMode', 'readTransition', 'restart_all'] },
  { name: 'mode switch in progress', mode: 'single', transition: { phase: 'gating' }, completion: 'accepted', calls: ['readMode', 'readTransition', 'restart_all'] },
];
for (const from of ['1.0.0', '1.0.0-beta.11']) for (const route of routes) test(`upgrade from ${from} in ${route.name} mode keeps its restart request`, async t => {
  const ctx = finalizationFixture(t, from), calls = [];
  const result = await completeUpgradeFinalization(ctx, finalizationDeps(calls, route));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(calls.map(call => typeof call === 'string' ? call : call.type), route.calls);
  for (const request of calls.filter(call => typeof call !== 'string')) assert.equal(request.reason, 'upgrade');
  assert.equal(result.completion.sessionRestart, route.completion);
  const text = formatSelfUpgradeCompletion(result);
  assert.match(text, new RegExp(`^Session restart: ${route.completion}$`, 'm'));
  assert.equal(text.includes(LEGACY_SESSION_RESTART_NOTICE), false);
  for (const jsonOutput of [false, true]) {
    const output = captureEntryOutput(result, jsonOutput);
    assert.equal((output.stdout + output.stderr).includes(LEGACY_SESSION_RESTART_NOTICE), false);
  }
});

// A source version that cannot be read is not evidence of a 0.x machine: skipping the
// request there would leave a 1.x session running old code with no restart notice.
for (const from of [undefined, null, '', 'old', 'v0.9.6', '0.9']) test(`unreadable source version ${JSON.stringify(from)} keeps the restart request`, async t => {
  const ctx = finalizationFixture(t, from), calls = [];
  const result = await completeUpgradeFinalization(ctx, finalizationDeps(calls));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(calls, ['readMode', 'readTransition', 'enqueueExit']);
  assert.equal(result.completion.sessionRestart, 'single_exit_enqueued');
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

for (const from of ['0.9.6', '1.0.0-beta.11']) test(`resume-finalize of an interrupted upgrade from ${from} follows the source version in the journal`, async t => {
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
  if (from.startsWith('0.')) {
    assert.deepEqual(calls, []);
    assert.equal(result.data.completion.sessionRestart, 'closed_by_system');
    assert.equal(result.data.sessionRestart.data.message, LEGACY_SESSION_RESTART_NOTICE);
    assert.ok(text.split('\n').includes(LEGACY_SESSION_RESTART_NOTICE), text);
  } else {
    assert.deepEqual(calls, ['readMode', 'readTransition', 'enqueueExit']);
    assert.equal(result.data.completion.sessionRestart, 'single_exit_enqueued');
    assert.equal(text.includes(LEGACY_SESSION_RESTART_NOTICE), false);
  }
});
