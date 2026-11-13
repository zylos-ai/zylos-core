import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startSupervisor } from '../../skills/activity-monitor/scripts/supervisor-main.js';
import { SupervisorScenes } from '../../skills/activity-monitor/scripts/supervisor-scenes.js';
import * as coreDb from '../../skills/comm-bridge/scripts/c4-db.js';
import { createStore } from '../../skills/comm-bridge/scripts/c4-v2-store.js';
import { requestRelease } from '../../skills/activity-monitor/scripts/supervisor-request.js';
import { tmuxNameForGroup } from '../../cli/lib/session-group-paths.js';
import { PRE_RECLAIM_SYNC_PROMPT } from '../../skills/zylos-memory/scripts/sync-prompts.js';
import { PRE_RECLAIM_CHECK_PROMPT } from '../../skills/activity-monitor/scripts/reclaim-prompts.js';
const Database = createRequire(new URL('../../skills/comm-bridge/package.json', import.meta.url))('better-sqlite3');
const [socketPath, binary, group, sync] = process.argv.slice(2);
const root = process.env.ZYLOS_DIR;
const database = new Database(path.join(root, 'comm-bridge/c4.db'));
const db = createStore(database, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }), validateComponent: () => true });
let service;
try {
  let state = 'idle';
  const scenes = new SupervisorScenes({ env: process.env, connectionOptions: { socketPath, binary },
    readMode: () => ({ mode: 'multi' }), readActivity: () => ({ state, idleSince: 1 }), readUsage: () => null });
  if (group !== 'origin') {
    // The fixture creates Origin first; rename that exact private target and move
    // its F3 record, retaining the real executable and tmux F2 identity checks.
    const { execFileSync } = await import('node:child_process');
    const tmux = (...args) => execFileSync(binary, ['-S', socketPath, ...args]);
    tmux('rename-session', '-t', '=zylos-group-origin', tmuxNameForGroup(group));
    tmux('set-environment', '-t', tmuxNameForGroup(group), 'ZYLOS_SESSION_GROUP', group);
    fs.renameSync(path.join(root, 'activity-monitor/session-groups/origin'), path.join(root, 'activity-monitor/session-groups', group));
    db.insertConversation('out', 'telegram', 'test-chat', 'completed result', { groupName: 'release' });
    db.createCheckpoint(group, db.getDeliveredFrontier(group), 'already recorded');
    assert.equal(db.adoptSlot(group, { runId: 'run-1' }).adopted, true);
  }
  const initial = await scenes.observeGroup(group);
  assert.equal(initial.ready, true); assert.equal(initial.processRunning, true);
  const logs = [];
  service = await startSupervisor({ env: process.env, db: { ...coreDb, ...db, getDb: () => database }, scenes,
    readMode: () => ({ mode: 'multi' }), readConfiguration: () => ({ mode: 'multi', runtime: 'claude', capacity: 2 }),
    resolveTargetRuntime: () => 'claude', readSyncMarker: () => ({ held: false, stale: false }),
    machineTasks: { tick() {}, stop() {} }, legacyStatus: { tick() {}, close() {} },
    sendAlert: () => assert.fail('External sends forbidden'), log: event => { if(logs.length<64)logs.push(event); },
    loopOptions: { schedule: () => 1, cancel() {} } });
  if (group === 'origin') {
    // Known draft boundary: a normal pre_tool marks this run busy, so invoking
    // this CLI from that very turn is rejected. No own-tool bypass is modeled.
    state = 'busy';
    const busy = await requestRelease({ env: { ...process.env, ZYLOS_SESSION_GROUP: group, ZYLOS_RUN_ID: 'run-1' } });
    assert.equal(busy.ok, false); assert.equal(busy.error.code, 'not_idle');
    assert.equal(db.getDrainFence(group), null);
    assert.equal((await scenes.observeGroup(group)).present, true);
    state = 'idle';
  }
  if (sync === 'sync') db.insertConversation('out', 'telegram', 'test-chat', 'new completed result', { groupName: 'release' });
  const result = await requestRelease({ env: { ...process.env, ZYLOS_SESSION_GROUP: group, ZYLOS_RUN_ID: 'run-1' } });
  assert.equal(result.ok, true, JSON.stringify({ result, logs }));
  const controls = () => database.prepare('SELECT * FROM control_queue ORDER BY id').all();
  if (sync === 'sync') {
    assert.equal(db.getDrainFence(group), null, 'Sync delivery remains unfenced');
    const pending = controls();
    assert.equal(pending.length, 1); assert.equal(pending[0].raw_content, PRE_RECLAIM_SYNC_PROMPT);
    assert.equal(pending[0].session_group, group); assert.equal(pending[0].require_idle, 1);
    const binding = JSON.parse(pending[0].target_binding);
    assert.ok(JSON.stringify(binding).includes('run-1'), 'Sync is bound to the requesting run');
    await service.supervisor.loop.tick();
    assert.equal((await scenes.observeGroup(group)).present, true, 'pending Sync prevents release');
    assert.equal(db.claimControl(pending[0].id), true);
    assert.equal(coreDb.ackControl(pending[0].id).status, 'done');
  } else {
    assert.equal(db.getDrainFence(group)?.reason, 'release');
  }
  for (let n = 0; n < 5 && !db.listRunEndings([group]).length; n++) await service.supervisor.loop.tick();
  assert.equal((await scenes.observeGroup(group)).present, false, JSON.stringify(logs));
  const ending = db.listRunEndings([group]);
  assert.equal(ending.length, 1); assert.equal(ending[0].reason, 'release');
  assert.equal(ending[0].runId, 'run-1'); assert.equal(ending[0].continuationPending, 0);
  assert.deepEqual(db.listPendingContinuations(), []); assert.deepEqual(db.listSlotOccupancy(), []);
  assert.equal(db.getDrainFence(group), null);
  assert.equal(controls().some(row => row.raw_content === PRE_RECLAIM_CHECK_PROMPT), false);
  assert.equal(controls().length, sync === 'sync' ? 1 : 0, 'no extra control or implicit continuation');
  // Cold demand boundary: actual C4 address/group routing sees the new message
  // after release. Authenticated model launch and paste are outside this test.
  const inbound = group === 'origin' ? db.insertConversation('in', 'system', null, 'new inbound')
    : db.insertConversation('in', 'telegram', 'test-chat', 'new inbound', { groupName: 'release' });
  assert.equal(inbound.session_group, group);
  assert.ok(db.listPendingSessionGroups().some(row => row.sessionGroup === group));
  if (group !== 'origin') assert.equal(db.takeSlot(group, { runId: 'run-2', k: 1 }).taken, true);
  process.send({ ok: true, group, sync: sync === 'sync', ending: ending[0] });
} finally {
  await service?.stop(); coreDb.close(); database.close();
}
process.disconnect();
