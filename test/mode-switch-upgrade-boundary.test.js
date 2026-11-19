import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture as storeFixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { startSupervisor } from '../skills/activity-monitor/scripts/supervisor-main.js';
import { readSessionModeStatus } from '../cli/lib/session-mode-status.js';

// Run for startup migration, config publication or dispatcher confirmation.
// The real supervisor and SQLite use private paths and injected runtime/PM2
// observations. Skip for unrelated changes.
test('recreated supervisor completes the transition admitted after the baseline exits', async t => {
  const cleanups = [];
  t.after(async () => { while (cleanups.length) await cleanups.pop()(); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-up-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const { db, store } = storeFixture({ after: fn => cleanups.push(fn) }, { now: () => 1800000000000 }, path.join(root, 'c4.db'));
  const env = { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'pm2'),
    TMPDIR: root, TMUX_TMPDIR: root };
  delete env.TMUX;
  for (const key of ['ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  assert.ok(root.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
  console.info({ HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR,
    database: path.join(root, 'c4.db'), socket: path.join(root, 'activity-monitor/am.sock') });
  let legacyPresent = true, service, begins = 0, modeKey = null, confirmed = false;
  const database = { ...store, getDb: () => db, beginModeTransition(...args) { begins++; return store.beginModeTransition(...args); } };
  const mode = () => ({ mode: modeKey, keyPresent: modeKey !== null });
  const scenes = { observe: async () => [], observeGroup: async () => ({ present: false }), readIdentity: async () => ({ present: false }), listRuns: async () => [], readRun: async () => null };
  const restoreServices = async () => {
    service = await startSupervisor({ env, db: database,
      scenes, readMode: mode, readConfig: () => ({ runtime: 'claude' }), legacyPresent: () => legacyPresent,
      legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
      loopOptions: { schedule: () => 1, cancel() {} }, readSyncMarker: () => ({ held: false, stale: false }),
      writeMode: value => { modeKey = value; },
      restartDispatcherConfirmation: { advance: () => ({ confirmed, pending: false }) },
      sendAlert: () => { throw new Error('external send forbidden'); }, log() {},
    });
    const started = service;
    cleanups.push(() => started.stop());
  };
  await restoreServices();
  await service.supervisor.loop.tick(); assert.equal(begins, 0);
  legacyPresent = false;
  for (let i = 0; i < 4; i++) await service.supervisor.loop.tick();
  assert.equal(begins, 1); const first = store.getModeTransition(); assert.ok(first);
  assert.equal(first.phase, 'cutover');
  assert.equal(first.reason, 'dispatcher_restart_unconfirmed');
  const previousService = service;
  await previousService.stop();
  assert.equal(previousService.server.listening, false);
  assert.equal(store.getModeTransition().run_id, first.run_id);
  await restoreServices();
  assert.equal(service.server.listening, true);
  const observe = () => readSessionModeStatus({ zylosDir: root, db: store, readMode: mode, probeSupervisor: async () => true, readEvents: () => [] });
  const blocked = await observe();
  assert.equal(blocked.transition.runId, first.run_id);
  assert.equal(blocked.globalGate.present, true);
  assert.equal(blocked.blocked.reason, 'dispatcher_restart_unconfirmed');
  confirmed = true;
  await service.supervisor.loop.tick();
  const done = await observe();
  assert.equal(begins, 1);
  assert.equal(done.sessionMode, 'multi');
  assert.equal(done.transition, null);
  assert.equal(done.globalGate.present, false);
  assert.equal(done.lastCompleted.runId, first.run_id);
});
