import { test, afterEach } from '@jest/globals';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture as storeFixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { startSupervisor } from '../skills/activity-monitor/scripts/supervisor-main.js';
import { readSessionModeStatus } from '../cli/lib/session-mode-status.js';
const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

test('frozen upgrade service-restoration boundary with real M4 preserves legacy delay, same D9 and blocked status after installation done', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-upgrade-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const { db, store } = storeFixture({ after: fn => cleanups.push(fn) }, { now: () => 1800000000000 }, path.join(root, 'c4.db'));
  let legacyPresent = true, service, begins = 0;
  const database = { ...store, getDb: () => db, beginModeTransition(...args) { begins++; return store.beginModeTransition(...args); } };
  const mode = () => ({ mode: null, keyPresent: false });
  const scenes = { observe: async () => [], observeGroup: async () => ({ present: false }), readIdentity: async () => ({ present: false }), listRuns: async () => [], readRun: async () => null };
  // This is the frozen P11 service boundary, not an implementation of P11 upgrade.
  const restoreServices = async state => {
    if (!state.cutoffClosed || !state.corePublished) return;
    service = await startSupervisor({ env: { ...process.env, HOME: root, ZYLOS_DIR: root }, db: database,
      scenes, readMode: mode, readConfig: () => ({ runtime: 'claude' }), legacyPresent: () => legacyPresent,
      legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
      loopOptions: { schedule: () => 1, cancel() {} }, readSyncMarker: () => ({ held: false, stale: false }),
      convertModeTransition: () => { throw Object.assign(new Error('export offline'), { step: 'export', code: 'EIO' }); },
      restartM1Confirmation: { advance: () => { throw new Error('restart must not run while conversion blocked'); } },
      sendAlert: () => { throw new Error('external send forbidden'); }, log() {},
    });
    cleanups.push(() => service.stop());
  };
  await restoreServices({ cutoffClosed: false, corePublished: true });
  await restoreServices({ cutoffClosed: true, corePublished: false });
  assert.equal(service, undefined); assert.equal(begins, 0); assert.equal(store.getModeTransition(), null);
  await restoreServices({ cutoffClosed: true, corePublished: true });
  await service.supervisor.loop.tick(); assert.equal(begins, 0);
  legacyPresent = false;
  for (let i = 0; i < 4; i++) await service.supervisor.loop.tick();
  assert.equal(begins, 1); const first = store.getModeTransition(); assert.ok(first);
  assert.equal(first.phase, 'converting'); assert.equal(first.reason, 'conversion_failed:export:EIO');
  const installation = { done: true };
  await service.supervisor.loop.tick(); assert.equal(begins, 1); assert.equal(store.getModeTransition().run_id, first.run_id);
  const status = await readSessionModeStatus({ zylosDir: root, db: store, readMode: mode, probeSupervisor: async () => true, readEvents: () => [] });
  assert.equal(installation.done, true); assert.equal(status.transition.phase, 'converting');
  assert.equal(status.globalGate.present, true); assert.equal(status.blocked.reason, 'conversion_failed:export:EIO');
  assert.equal(status.lastCompleted, null);
});
