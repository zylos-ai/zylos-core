import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture as storeFixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { deliveryFixture } from '../skills/comm-bridge/scripts/__tests__/helpers/session-delivery-fixture.js';
import { submit } from '../cli/lib/am-sock-client.js';
import { startSupervisor } from '../skills/activity-monitor/scripts/supervisor-main.js';
import { RestartRequestStore } from '../skills/activity-monitor/scripts/restart-request-store.js';
import { supervisorDiagnosticPath } from '../cli/lib/session-group-paths.js';
import { readSessionModeStatus } from '../cli/lib/session-mode-status.js';

// Real supervisor, admission socket, SQLite and delivery ledger use private
// paths. Runtime panes, terminal I/O and dispatcher restart are fixtures.
// Run for startup migration, legacy restart cleanup, or cutover changes.
// Skip unrelated changes. The runner isolates HOME, ZYLOS_DIR, PM2_HOME and
// TMPDIR. No tmux processes are started. Cleanup closes sockets and databases.
function upgradeFixture(t, { initialMode = null, origin = null } = {}) {
  const cleanups = [];
  t.after(async () => { while (cleanups.length) await cleanups.pop()(); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-up-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  let modeKey = initialMode;
  const storage = storeFixture({ after: fn => cleanups.push(fn) }, {
    now: () => 1800000000000,
    readConfig: () => ({ state: 'ok', config: { runtime: 'claude', ...(modeKey === null ? {} : { session_mode: modeKey }) } }),
  }, path.join(root, 'c4.db'));
  const { db, store } = storage;
  const env = { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'pm2'),
    TMPDIR: root, TMUX_TMPDIR: root };
  delete env.TMUX;
  for (const key of ['ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  assert.ok(root.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
  console.info({ HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR,
    database: path.join(root, 'c4.db'), socket: path.join(root, 'activity-monitor/am.sock') });
  const requestStore = new RestartRequestStore({ file: path.join(root, 'activity-monitor', 'restart-requests.json') });
  const legacyRunId = 'legacy-baseline-run';
  const request = { requestId: 'legacy-restart', reason: 'manual_restart', acceptedAt: 1800000000000,
    runIds: [legacyRunId], mode: 'single', expectedRunId: legacyRunId };
  const seedLegacyRestart = () => {
    requestStore.write([request]);
    store.setDrainFence('*', { reason: 'manual_restart', runId: legacyRunId });
  };
  const alerts = [];
  const diagnosticFile = supervisorDiagnosticPath(env);
  const legacyWarning = /manual_restart_(orphan_fence|blocked|done)/;
  const assertNoLegacyRestartWarning = () => {
    const diagnostics = fs.existsSync(diagnosticFile) ? fs.readFileSync(diagnosticFile, 'utf8') : '';
    assert.doesNotMatch(diagnostics, legacyWarning);
    assert.equal(alerts.find(message => legacyWarning.test(message)), undefined);
  };
  let legacyPresent = initialMode === null, service, begins = 0, confirmed = false;
  const database = { ...store, getDb: () => db, beginModeTransition(...args) { begins++; return store.beginModeTransition(...args); } };
  const mode = () => ({ mode: modeKey, keyPresent: modeKey !== null });
  const identity = origin ? { ...origin, runDir: path.join(root, 'origin-run') } : { present: false };
  if (origin) fs.mkdirSync(identity.runDir);
  const observed = origin ? [identity] : [];
  const scenes = {
    observe: async () => observed,
    observeGroup: async () => identity,
    readIdentity: async () => identity,
    listRuns: async () => observed,
    readRun: async () => origin ? identity : null,
  };
  const restoreServices = async () => {
    service = await startSupervisor({ env, db: database,
      scenes, readMode: mode, readConfig: () => ({ runtime: 'claude' }), legacyPresent: () => legacyPresent,
      legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
      loopOptions: { schedule: () => 1, cancel() {} }, readSyncMarker: () => ({ held: false, stale: false }),
      writeMode: value => { modeKey = value; },
      restartDispatcherConfirmation: { advance: () => ({ confirmed, pending: false }) },
      sendAlert: async (_target, message) => { alerts.push(message); return true; }, log() {},
    });
    const started = service;
    cleanups.push(() => started.stop());
    return service;
  };
  return { ...storage, root, requestStore, request, legacyRunId, mode, seedLegacyRestart, assertNoLegacyRestartWarning, restoreServices,
    begins: () => begins, exitBaseline: () => { legacyPresent = false; }, confirmRestart: () => { confirmed = true; } };
}

test('recreated supervisor completes the transition admitted after the baseline exits', async t => {
  const f = upgradeFixture(t);
  const { store, requestStore, request, legacyRunId, root, mode, assertNoLegacyRestartWarning, restoreServices } = f;
  f.seedLegacyRestart();
  let service = await restoreServices();
  for (let i = 0; i < 3; i++) {
    await service.supervisor.loop.tick();
    assertNoLegacyRestartWarning();
  }
  assert.equal(f.begins(), 0);
  assert.deepEqual(requestStore.read(), [request]);
  assert.equal(store.getDrainFence('*')?.runId, legacyRunId);
  f.exitBaseline();
  await service.supervisor.loop.tick();
  assert.equal(f.begins(), 1);
  assert.deepEqual(requestStore.read(), []);
  assert.equal(store.getDrainFence('*'), null);
  assertNoLegacyRestartWarning();
  for (let i = 0; i < 3; i++) await service.supervisor.loop.tick();
  const first = store.getModeTransition(); assert.ok(first);
  assert.equal(first.phase, 'cutover');
  assert.equal(first.reason, 'dispatcher_restart_unconfirmed');
  const previousService = service;
  await previousService.stop();
  assert.equal(previousService.server.listening, false);
  assert.equal(store.getModeTransition().run_id, first.run_id);
  service = await restoreServices();
  assert.equal(service.server.listening, true);
  const observe = () => readSessionModeStatus({ zylosDir: root, db: store, readMode: mode, probeSupervisor: async () => true, readEvents: () => [] });
  const blocked = await observe();
  assert.equal(blocked.transition.runId, first.run_id);
  assert.equal(blocked.globalGate.present, true);
  assert.equal(blocked.blocked.reason, 'dispatcher_restart_unconfirmed');
  f.confirmRestart();
  await service.supervisor.loop.tick();
  const done = await observe();
  assert.equal(f.begins(), 1);
  assert.equal(done.sessionMode, 'multi');
  assert.equal(done.transition, null);
  assert.equal(done.globalGate.present, false);
  assert.equal(done.lastCompleted.runId, first.run_id);
  assertNoLegacyRestartWarning();
});

test('configured single discards the old global manual fence before delivering queued input to Origin', async t => {
  const origin = { sessionGroup: 'origin', sourceScope: 'origin', runId: 'native-origin-run', runtime: 'claude',
    sessionId: 'native-origin-session', ready: true, present: true, processRunning: true };
  const f = upgradeFixture(t, { initialMode: 'single', origin });
  const service = await f.restoreServices();
  const delivery = deliveryFixture(t, { storage: f, mode: 'single' });
  delivery.run(origin.runId);
  const pending = f.store.insertConversation('in', 'telegram', 'queued', 'queued before upgrade cleanup');
  f.seedLegacyRestart();
  const deliveryScope = { sessionMode: 'single' };
  assert.equal(f.store.getNextPending(deliveryScope), null, 'legacy global gate blocks selection');

  try {
    await service.supervisor.loop.tick();
    const selected = f.store.getNextPending(deliveryScope);
    assert.equal(selected?.id, pending.id, 'queued message becomes deliverable to Origin in the cleanup round');
    assert.equal(f.store.claimConversation(selected.id, deliveryScope), true);
    assert.equal((await delivery.delivery.deliverConversation(selected)).delivered, true);
    const saved = f.db.prepare('SELECT status, session_group FROM conversations WHERE id=?').get(pending.id);
    assert.deepEqual(saved, { status: 'delivered', session_group: 'origin' });
    assert.deepEqual(delivery.calls.filter(call => call[0] === 'paste'), [['paste', 'origin']]);
    assert.equal(f.store.getDrainFence('*'), null);
    assert.deepEqual(f.requestStore.read(), []);
    f.assertNoLegacyRestartWarning();

    const result = await submit({ version: 1, type: 'mode_switch', requestId: 'switch-after-cleanup', target: 'multi' },
      { socketPath: path.join(f.root, 'activity-monitor/am.sock') });
    assert.equal(result.kind, 'accepted');
    assert.equal(result.reply.result, 'accepted');
    assert.equal(f.store.getModeTransition().run_id, result.reply.runId);
  } finally {
    await delivery.delivery.stop();
  }
});
