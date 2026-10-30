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

test('real supervisor service recreation preserves legacy delay, same and blocked status', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-switch-upgrade-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const { db, store } = storeFixture({ after: fn => cleanups.push(fn) }, { now: () => 1800000000000 }, path.join(root, 'c4.db'));
  let legacyPresent = true, service, begins = 0;
  const database = { ...store, getDb: () => db, beginModeTransition(...args) { begins++; return store.beginModeTransition(...args); } };
  const mode = () => ({ mode: null, keyPresent: false });
  const scenes = { observe: async () => [], observeGroup: async () => ({ present: false }), readIdentity: async () => ({ present: false }), listRuns: async () => [], readRun: async () => null };
  // owns cutoff/publication and installation completion checks.
  const restoreServices = async () => {
    service = await startSupervisor({ env: { ...process.env, HOME: root, ZYLOS_DIR: root }, db: database,
      scenes, readMode: mode, readConfig: () => ({ runtime: 'claude' }), legacyPresent: () => legacyPresent,
      legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
      loopOptions: { schedule: () => 1, cancel() {} }, readSyncMarker: () => ({ held: false, stale: false }),
      convertModeTransition: () => { throw Object.assign(new Error('export offline'), { step: 'export', code: 'EIO' }); },
      restartDispatcherConfirmation: { advance: () => { throw new Error('restart must not run while conversion blocked'); } },
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
  assert.equal(first.phase, 'converting'); assert.equal(first.reason, 'conversion_failed:export:EIO');
  const previousService = service;
  await previousService.stop();
  assert.equal(previousService.server.listening, false);
  assert.equal(store.getModeTransition().run_id, first.run_id);
  await restoreServices();
  assert.notEqual(service.supervisor, previousService.supervisor);
  assert.equal(service.server.listening, true);
  await service.supervisor.loop.tick();
  assert.equal(begins, 1);
  assert.equal(store.getModeTransition().run_id, first.run_id);
  assert.equal(store.getModeTransition().cutoff, first.cutoff);
  assert.deepEqual(store.getModeTransition().absorbed_ids, first.absorbed_ids);
  const status = await readSessionModeStatus({ zylosDir: root, db: store, readMode: mode, probeSupervisor: async () => true, readEvents: () => [] });
  assert.equal(status.transition.phase, 'converting');
  assert.equal(status.globalGate.present, true); assert.equal(status.blocked.reason, 'conversion_failed:export:EIO');
  assert.equal(status.lastCompleted, null);
});
