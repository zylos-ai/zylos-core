import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { SupervisorScenes } from '../supervisor-scenes.js';
import { startSupervisor } from '../supervisor-main.js';

async function scenario(t, operation, start = startSupervisor, corrupt = false) {
  const f = readyTmuxTarget(t, { prefix: 'p05-diag-matrix-', mode: 'multi' });
  f.tmux('new-session', '-d', '-s', 'keeper', 'sleep', '120');
  const db = createStore(f.db, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  db.setDrainFence('origin', { reason: 'upgrade', runId: 'run-1' });
  const requests = path.join(f.root, 'activity-monitor/restart-requests.json');
  fs.writeFileSync(requests, corrupt ? 'corrupt-retained' : '[]');
  const files = ['activity-monitor/supervisor-events.jsonl', 'activity-monitor/pool-metrics.jsonl', 'comm-bridge/router-events.jsonl'];
  for (const relative of files) {
    const file = path.join(f.root, relative);
    fs.writeFileSync(file, '{"v":1,"event":"fixture"}\n');
    if (operation === 'inject') fs.appendFileSync(file, 'malformed\n{"v":1,"event":"restart_done","requestId":"fake","runId":"run-1"}\n');
    if (operation === 'delete') fs.unlinkSync(file);
    if (operation === 'truncate') fs.truncateSync(file, 0);
    if (operation === 'rotate') fs.renameSync(file, file + '.1');
  }
  let busy = 1;
  const scenes = new SupervisorScenes({ env: f.env, connectionOptions: { socketPath: f.socketPath, binary: f.binary },
    readMode: () => ({ mode: 'multi' }), readActivity: () => ({ state: 'idle', idleSince: 1 }), readUsage: () => null });
  const service = await start({ env: f.env, db: { ...db, getDb: () => f.db, countRunningConversations: () => busy }, scenes,
    readMode: () => ({ mode: 'multi' }), readConfiguration: () => ({ mode: 'multi', runtime: 'claude', capacity: 2 }),
    resolveTargetRuntime: () => 'claude', machineTasks: { tick() {}, stop() {} }, legacyStatus: { tick() {}, close() {} },
    loopOptions: { schedule: () => 1, cancel() {} }, log() {} });
  t.after(() => service.stop());
  const before = { fence: db.getDrainFence('origin')?.reason, present: (await scenes.observeGroup('origin')).present,
    health: service.supervisor.health.store('claude').read().health, transition: db.getModeTransition(), requests: fs.readFileSync(requests, 'utf8') };
  assert.deepEqual(before, { fence: 'upgrade', present: true, health: 'ok', transition: null, requests: corrupt ? 'corrupt-retained' : '[]' });
  busy = 0; await service.supervisor.loop.tick();
  const after = { fence: db.getDrainFence('origin'), present: (await scenes.observeGroup('origin')).present,
    health: service.supervisor.health.store('claude').read().health, transition: db.getModeTransition(), requests: fs.readFileSync(requests, 'utf8') };
  assert.deepEqual(after, { fence: null, present: false, health: 'ok', transition: null, requests: corrupt ? 'corrupt-retained' : '[]' });
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=keeper'));
  await service.stop(); return { before, after };
}

test('IF-31 local M4 paired authority invariance under inject/delete/truncate/rotate of all diagnostic streams', { timeout: 30000 }, async t => {
  const baseline = await scenario(t, 'unchanged');
  for (const operation of ['inject', 'delete', 'truncate', 'rotate']) assert.deepEqual(await scenario(t, operation), baseline);
});
test('IF-31 fake completion and DM54 corrupt F9 preserve authoritative cleanup', { timeout: 30000 }, async t => {
  await scenario(t, 'inject'); await scenario(t, 'inject', startSupervisor, true);
});
