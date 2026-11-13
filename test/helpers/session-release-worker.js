import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { startSupervisor } from '../../skills/activity-monitor/scripts/supervisor-main.js';
import { SupervisorScenes } from '../../skills/activity-monitor/scripts/supervisor-scenes.js';
import * as coreDb from '../../skills/comm-bridge/scripts/c4-db.js';
import { createStore } from '../../skills/comm-bridge/scripts/c4-v2-store.js';
import { requestRelease } from '../../skills/activity-monitor/scripts/supervisor-request.js';
import { tmuxNameForGroup, supervisorDiagnosticPath } from '../../cli/lib/session-group-paths.js';
import { PRE_RECLAIM_SYNC_PROMPT } from '../../skills/zylos-memory/scripts/sync-prompts.js';
import { PRE_RECLAIM_CHECK_PROMPT } from '../../skills/activity-monitor/scripts/reclaim-prompts.js';
const Database = createRequire(new URL('../../skills/comm-bridge/package.json', import.meta.url))('better-sqlite3');
const [socketPath, binary, group, scenario] = process.argv.slice(2);
const root = process.env.ZYLOS_DIR;
const database = new Database(path.join(root, 'comm-bridge/c4.db'));
const db = createStore(database, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }), validateComponent: () => true });
let service;
try {
  let state = 'busy', children = [], now = Date.now();
  const busySince = now - 10000;
  const scenes = new SupervisorScenes({ env: process.env, connectionOptions: { socketPath, binary },
    readMode: () => ({ mode: 'multi' }), readActivity: () => ({ state, busySince: state === 'busy' ? busySince : null, idleSince: now - 10000, activeSubagents: children }), readUsage: () => null });
  const inbound = content => group === 'origin' ? db.insertConversation('in', 'system', null, content)
    : db.insertConversation('in', 'telegram', 'test-chat', content, { groupName: 'release' });
  if (group !== 'origin') {
    // Retain the fixture's executable and tmux identity guards when moving Origin.
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
  const start = () => startSupervisor({ env: process.env, db: { ...coreDb, ...db, getDb: () => database }, scenes, now: () => now,
    readMode: () => ({ mode: 'multi' }), readConfiguration: () => ({ mode: 'multi', runtime: 'claude', capacity: 2 }),
    resolveTargetRuntime: () => 'claude', readSyncMarker: () => ({ held: false, stale: false }),
    machineTasks: { tick() {}, stop() {} }, legacyStatus: { tick() {}, close() {} },
    sendAlert: () => assert.fail('External sends forbidden'), log: event => { if (logs.length < 64) logs.push(event); },
    loopOptions: { schedule: () => 1, cancel() {} } });
  const request = () => requestRelease({ env: { ...process.env, ZYLOS_SESSION_GROUP: group, ZYLOS_RUN_ID: 'run-1' } });
  const tick = () => service.supervisor.loop.tick();
  const controls = () => database.prepare('SELECT * FROM control_queue ORDER BY id').all();
  const stillRunning = async () => {
    assert.equal((await scenes.observeGroup(group)).present, true, JSON.stringify(logs));
    assert.equal(db.getDrainFence(group), null);
    assert.equal(db.listRunEndings([group]).length, 0);
  };
  const notify = fields => new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(root, 'activity-monitor/am.sock'));
    let response = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('Delivery notification timeout')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ version: 2, type: 'notify_delivered', requestId: `delivery-${scenario}`,
      sessionGroup: group, runId: 'run-1', runtime: 'claude', pastedAt: ++now, ...fields }) + '\n'));
    socket.on('data', chunk => { response += chunk; if (response.length > 4096) socket.destroy(new Error('Oversized notification reply')); });
    socket.once('end', () => { socket.destroy(); try { resolve(JSON.parse(response)); } catch (error) { reject(error); } });
  });
  service = await start();
  if (scenario === 'sync') db.insertConversation('out', 'telegram', 'test-chat', 'new completed result', { groupName: 'release' });
  if (scenario === 'child') children = [{ agentId: 'working-child', lastActivityAt: now }];
  if (scenario.endsWith('-before-intent')) {
    // The real socket hint has already been processed when the requester
    // registers intent later in the same busy turn.
    if (scenario.startsWith('conversation')) {
      const row = inbound('work pasted during the requesting turn');
      assert.equal(db.claimConversation(row.id), true);
      assert.equal(db.markDelivered(row.id, { sessionId: 'session-1' }), true);
      assert.equal((await notify({ conversationId: row.id, channel: row.channel })).type, 'ack');
    } else {
      const row = db.insertControl('work pasted during the requesting turn', { sessionGroup: group, appendAckSuffix: false });
      assert.equal(db.claimControl(row.id), true);
      assert.equal((await notify({ controlId: row.id })).type, 'ack');
      assert.equal(coreDb.ackControl(row.id).status, 'done');
    }
    assert.equal((await request()).ok, true);
    state = 'idle';
    for (let n = 0; n < 3; n++) await tick();
    await stillRunning();
    const diagnostics = fs.readFileSync(supervisorDiagnosticPath(process.env), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(diagnostics.some(row => row.event === 'reclaim_cancelled' && row.reason === 'new_work' && row.run_id === 'run-1'));
    process.send({ ok: true, group, scenario });
  } else {
  const result = await request();
  assert.equal(result.ok, true, JSON.stringify({ result, logs }));
  assert.equal(result.data.result, 'accepted');
  assert.equal((await request()).data.result, 'already_accepted');
  await tick(); await stillRunning();
  assert.equal(controls().length, 0, 'busy requester is accepted without preparing Sync or fencing');

  if (scenario === 'restart') {
    await service.stop(); service = null;
    state = 'idle'; service = await start();
    for (let n = 0; n < 3; n++) await tick();
    await stillRunning();
    assert.equal(controls().length, 0, 'recreated supervisor does not restore voluntary intent');
    process.send({ ok: true, group, scenario });
  } else if (['conversation', 'control'].includes(scenario)) {
    let fields;
    if (scenario === 'conversation') {
      const row = inbound('newly delivered work');
      assert.equal(db.claimConversation(row.id), true);
      assert.equal(db.markDelivered(row.id, { sessionId: 'session-1' }), true);
      fields = { conversationId: row.id, channel: row.channel };
    } else {
      const row = db.insertControl('newly delivered control', { sessionGroup: group, appendAckSuffix: false });
      assert.equal(db.claimControl(row.id), true);
      fields = { controlId: row.id };
    }
    assert.equal((await notify(fields)).type, 'ack');
    if (scenario === 'control') assert.equal(coreDb.ackControl(fields.controlId).status, 'done');
    state = 'idle';
    for (let n = 0; n < 3; n++) await tick();
    await stillRunning();
    const diagnostics = fs.readFileSync(supervisorDiagnosticPath(process.env), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(diagnostics.some(row => row.event === 'reclaim_cancelled' && row.reason === 'new_work' && row.run_id === 'run-1'));
    process.send({ ok: true, group, scenario });
  } else {
    state = 'idle';
    if (scenario === 'child') {
      await tick(); await tick(); await stillRunning();
      assert.equal(controls().length, 0, 'active child postpones the accepted request');
      children = [];
    }
    if (scenario === 'sync') {
      await tick();
      await stillRunning();
      const pending = controls();
      assert.equal(pending.length, 1); assert.equal(pending[0].raw_content, PRE_RECLAIM_SYNC_PROMPT);
      assert.equal(pending[0].session_group, group); assert.equal(pending[0].require_idle, 1);
      assert.ok(JSON.stringify(JSON.parse(pending[0].target_binding)).includes('run-1'));
      assert.equal(db.claimControl(pending[0].id), true);
      assert.equal((await notify({ controlId: pending[0].id })).type, 'ack');
      assert.equal(coreDb.ackControl(pending[0].id).status, 'done');
      state = 'busy'; await tick(); await stillRunning();
      state = 'idle';
    }
    for (let n = 0; n < 5 && !db.listRunEndings([group]).length; n++) await tick();
    assert.equal((await scenes.observeGroup(group)).present, false, JSON.stringify(logs));
    const ending = db.listRunEndings([group]);
    assert.equal(ending.length, 1); assert.equal(ending[0].reason, 'release');
    assert.equal(ending[0].runId, 'run-1'); assert.equal(ending[0].continuationPending, 0);
    assert.deepEqual(db.listPendingContinuations(), []); assert.deepEqual(db.listSlotOccupancy(), []);
    assert.equal(db.getDrainFence(group), null);
    assert.equal(controls().some(row => row.raw_content === PRE_RECLAIM_CHECK_PROMPT), false);
    assert.equal(controls().length, scenario === 'sync' ? 1 : 0);
    // Cold demand reaches actual C4 routing/slot admission; model launch is out of scope.
    const row = inbound('new inbound');
    assert.equal(row.session_group, group);
    assert.ok(db.listPendingSessionGroups().some(item => item.sessionGroup === group));
    if (group !== 'origin') assert.equal(db.takeSlot(group, { runId: 'run-2', k: 1 }).taken, true);
    process.send({ ok: true, group, scenario, ending: ending[0] });
  }
  }
} finally {
  await service?.stop(); coreDb.close(); database.close();
}
process.disconnect();
