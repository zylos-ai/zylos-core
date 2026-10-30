import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture as storeFixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { startSupervisor } from '../skills/activity-monitor/scripts/supervisor-main.js';
import { createModeSwitchConverter } from '../skills/activity-monitor/scripts/mode-switch-convert.js';
import { readSessionModeStatus } from '../cli/lib/session-mode-status.js';

test('real supervisor reason/events and readonly status agree through block, recovery and stopped supervisor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-switch-visible-')); const cleanup = [];
  const { db, store } = storeFixture({ after: fn => cleanup.push(fn) }, {}, path.join(root, 'c4.db'));
  let mode = 'single', failExport = true, service;
  const readMode = () => ({ mode, keyPresent: true });
  const converter = createModeSwitchConverter({ db: store, zylosDir: root });
  const status = () => readSessionModeStatus({ db: store, zylosDir: root, readMode, readPm2: async () => 'stopped' });
  try {
    service = await startSupervisor({ env: { ...process.env, HOME: root, ZYLOS_DIR: root }, db: { ...store, getDb: () => db },
      readMode, readConfig: () => ({ runtime: 'claude', session_mode: mode }), legacyPresent: () => false,
      scenes: { observe: async () => [], observeGroup: async () => ({ present: false }), readIdentity: async () => ({ present: false }), listRuns: async () => [], readRun: async () => null },
      legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} }, loopOptions: { schedule: () => 1, cancel() {} },
      readSyncMarker: () => ({ held: false, stale: false }),
      convertModeTransition: row => { if (failExport) throw Object.assign(new Error('export fixture failure'), { step: 'export', code: 'EIO' }); return converter(row); },
      writeMode: target => { mode = target; }, restartDispatcherConfirmation: { advance: () => ({ confirmed: true }) },
      sendAlert: () => { throw new Error('external notification forbidden'); }, log() {},
    });
    const reply = await service.supervisor.admission.handle({ version: 1, type: 'mode_switch', requestId: 'visible', target: 'multi' });
    assert.equal(reply.result, 'accepted');
    for (let n = 0; n < 3; n++) await service.supervisor.loop.tick();
    const blocked = await status();
    assert.equal(blocked.supervisor, 'reachable'); assert.equal(blocked.globalGate.present, true);
    assert.equal(blocked.blocked.reason, 'conversion_failed:export:EIO'); assert.ok(Number.isFinite(blocked.blocked.since));
    assert.equal(blocked.lastEvents.filter(event => event.event === 'transition_convert_failed').length, 1);
    await service.stop(); service = null;
    const stopped = await status();
    for (const key of ['transition', 'globalGate', 'blocked', 'lastEvents', 'lastCompleted']) assert.deepEqual(stopped[key], blocked[key]);
    assert.equal(stopped.supervisor, 'unreachable');
    // Resume the real coordinator after the service has stopped to exercise its
    // durable authority recovery without starting another external process.
    const { ModeSwitchCoordinator } = await import('../skills/activity-monitor/scripts/mode-switch.js');
    failExport = false;
    const owner = new ModeSwitchCoordinator({ db: store, zylosDir: root, readMode,
      convert: converter, writeMode: target => { mode = target; }, restart: { advance: () => ({ confirmed: true }) },
    });
    await owner.advance(); await owner.advance();
    const done = await status(); assert.equal(done.transition, null); assert.equal(done.blocked, null);
    assert.equal(done.lastCompleted.runId, reply.runId); assert.equal(done.globalGate.present, false); assert.equal(done.sessionMode, 'multi');
  } finally { await service?.stop(); for (const fn of cleanup.reverse()) fn(); fs.rmSync(root, { recursive: true, force: true }); }
});
