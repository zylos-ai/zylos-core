import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { guardDatabase } from '../skills/comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../skills/comm-bridge/scripts/c4-schema.js';
import { createStore } from '../skills/comm-bridge/scripts/c4-v2-store.js';
import { ModeSwitchCoordinator } from '../skills/activity-monitor/scripts/mode-switch.js';
import { SupervisorLifecycle } from '../skills/activity-monitor/scripts/supervisor-lifecycle.js';
import { deliveryFixture } from '../skills/comm-bridge/scripts/__tests__/helpers/session-delivery-fixture.js';

// Acceptance boundary: actual coordinator and schema-guarded private file SQLite.
// Scene observation, lifecycle stop, dispatcher confirmation, and config writing
// are injected. These cases do not prove real tmux/session or PM2 behavior.
// Run through the official isolated Node runner, under a separate Unix user.
// Every fixture owns its config, memory tree, and DB; teardown closes the DB and
// removes only that temporary tree. These coordinator-only fixtures start no
// services, external sends, or child work; the process case declares its boundary.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mode-'));
  const db = new Database(path.join(root, 'c4.db'));
  t.after(() => { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ runtime: 'claude', session_mode: 'multi', retained: 'config' }) + '\n');
  const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
  let clock = 1800000000000;
  guardDatabase(db, schema);
  const store = createStore(db, { now: () => clock, readConfig: () => ({ state: 'ok', config: readConfig() }), validateComponent: () => true, validateModel: () => true });
  const memory = path.join(root, 'memory', 'session-groups', 'origin'); fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(path.join(memory, 'state.md'), '# Origin\nretained state\n');
  fs.writeFileSync(path.join(memory, 'inbox.md'), '# Inbox\nretained fact\n');
  const scenes = [{ sessionGroup: 'origin', runId: 'origin-current', present: true, ready: true }];
  const reclaimed = [], events = [], writes = [], restarts = [];
  const owner = () => new ModeSwitchCoordinator({ db: store, now: () => clock,
    readMode: () => ({ mode: readConfig().session_mode, keyPresent: true }), readConfiguration: readConfig,
    readRequests: () => [], legacyPresent: () => false, globalMemoryPending: () => false,
    observe: () => scenes.map(scene => ({ ...scene })),
    lifecycle: { stopForModeSwitch: () => {}, advanceReclaim: fence => { reclaimed.push({ ...fence }); } },
    writeMode: target => { writes.push(target); fs.writeFileSync(configFile, JSON.stringify({ ...readConfig(), session_mode: target }) + '\n'); },
    restart: { advance: request => { restarts.push(request); return { confirmed: true }; } },
    diagnostic: event => events.push(event),
  });
  const rows = table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const tree = (directory = path.join(root, 'memory'), prefix = '') => fs.readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name), relative = path.join(prefix, name);
    return fs.statSync(file).isDirectory() ? tree(file, relative) : [[relative, fs.readFileSync(file).toString('base64')]];
  });
  const payload = () => JSON.stringify({ controls: rows('control_queue'), conversations: rows('conversations'), checkpoints: rows('checkpoints'), cursors: rows('origin_sync_cursors'), config: fs.readFileSync(configFile).toString('base64'), memory: tree() });
  const begin = async (coordinator, target = 'single') => {
    const result = await coordinator.handle({ version: 1, type: 'mode_switch', requestId: `switch-${target}`, target });
    assert.equal(result.result, 'accepted'); return result.runId;
  };
  // SQL establishes persisted fixture facts; transitions under test use product APIs.
  db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group) VALUES('in','fixture','ordinary','external pending','pending','ordinary'),('in','fixture','origin','origin running','running','origin')").run();
  db.prepare("INSERT INTO control_queue(raw_content,content,status,created_at,updated_at,session_group,target_binding) VALUES('origin role','origin role','pending',1,1,'origin',NULL),('origin pinned','origin pinned','pending',1,1,'origin',?),('origin running','origin running','running',1,1,'origin',NULL),('ordinary pending','ordinary pending','pending',1,1,'ordinary',NULL)")
    .run(JSON.stringify({ runId: 'origin-current', runtime: 'claude', sessionId: 'origin-session' }));
  db.prepare("INSERT INTO checkpoints(summary,start_conversation_id,end_conversation_id,session_group,no_content) VALUES('retained',1,1,'origin',0)").run();
  db.prepare("INSERT INTO origin_sync_cursors(session_group,synced_id,checkpoint_id,updated_at) VALUES('origin',1,1,1)").run();
  const completeOriginInput = () => {
    const input = db.prepare("SELECT id FROM conversations WHERE session_group='origin' AND status='running'").get();
    assert.ok(input); assert.equal(store.markDelivered(input.id, { sessionId: 'origin-session' }), true);
  };
  return { root, db, store, scenes, reclaimed, events, writes, restarts, owner, rows, tree, payload, begin, completeOriginInput, tick: seconds => { clock += seconds * 1000; }, readConfig };
}

// Run gating without cutover dependencies; skip only unrelated
// runtime transport work. Origin identity is observed, not a real tmux session.
test('native gating preserves Origin while fencing only ordinary scenes', async t => {
  const f = fixture(t), coordinator = f.owner();
  f.scenes.push({ sessionGroup: 'ordinary', runId: 'ordinary-current', present: true, ready: true });
  const before = f.payload(); const origin = { ...f.scenes[0] };
  await f.begin(coordinator); await coordinator.advance();
  assert.equal(f.store.getModeTransition().phase, 'gating');
  assert.equal(f.store.getModeTransition().reason, null, 'Origin running control without deadline must not block native gating');
  assert.equal(f.store.getDrainFence('origin'), null);
  assert.equal(f.store.getDrainFence('ordinary').reason, 'mode_switch');
  assert.deepEqual(f.reclaimed.map(fence => fence.sessionGroup), ['ordinary']);
  assert.deepEqual(f.scenes[0], origin); assert.equal(f.payload(), before);
  assert.equal(f.rows('run_endings').length, 0); assert.deepEqual(f.writes, []); assert.deepEqual(f.restarts, []);
});
test('native roundtrip cutover preserves Origin controls markers messages checkpoints cursors and memory', async t => {
  const f = fixture(t); f.completeOriginInput();
  assert.equal(typeof f.store.clearContinuationsExceptOrigin, 'function', 'requires upstream dependency 3');
  f.store.recordRunEnd('origin', { runId: 'origin-previous', reason: 'upgrade' });
  f.store.recordRunEnd('ordinary', { runId: 'ordinary-previous', reason: 'upgrade' });
  f.db.prepare("INSERT INTO control_queue(raw_content,content,status,created_at,updated_at) VALUES('machine pending','machine pending','pending',1,1)").run();
  const originControls = JSON.stringify(f.rows('control_queue').filter(row => row.session_group === 'origin'));
  const originEnding = JSON.stringify(f.store.listRunEndings(['origin']));
  const frozen = () => JSON.stringify({ conversations: f.rows('conversations'), checkpoints: f.rows('checkpoints'), cursors: f.rows('origin_sync_cursors'), memory: f.tree() });
  const before = frozen(), originScene = { ...f.scenes[0] };
  for (const target of ['single', 'multi']) {
    const coordinator = f.owner(), runId = await f.begin(coordinator, target);
    const beforeCutover = JSON.stringify({ controls: f.rows('control_queue'), endings: f.rows('run_endings') });
    await coordinator.advance(); assert.equal(f.store.getModeTransition().phase, 'cutover');
    assert.equal(JSON.stringify({ controls: f.rows('control_queue'), endings: f.rows('run_endings') }), beforeCutover,
      'durable cutover phase must precede execution-control invalidation');
    await coordinator.advance();
    assert.equal(f.store.getModeTransition(), null); assert.equal(f.readConfig().session_mode, target);
    const completed = f.store.getModeTransition({ runId }); assert.equal(completed.phase, 'complete'); assert.equal(completed.cutoff, null);
    assert.equal(JSON.stringify(f.rows('control_queue').filter(row => row.session_group === 'origin')), originControls);
    assert.equal(JSON.stringify(f.store.listRunEndings(['origin'])), originEnding);
    assert.equal(f.store.listRunEndings(['ordinary'])[0].continuationPending, 0);
    for (const control of f.rows('control_queue').filter(row => row.session_group !== 'origin')) {
      assert.equal(control.status, 'timeout'); assert.equal(control.last_error, 'SESSION_ENDED');
    }
    assert.equal(frozen(), before); assert.deepEqual(f.scenes[0], originScene); assert.equal(f.store.getDrainFence('origin'), null);
    assert.equal(f.store.getDrainFence('*'), null); assert.equal(f.events.some(event => event.event === 'absorb'), false);
  }
  assert.deepEqual(f.writes, ['single','multi']); assert.equal(f.restarts.length, 2); assert.deepEqual(f.reclaimed, []);
});
test('native historical nonempty cutoff cutover resumes forward without conversion', async t => {
  const f = fixture(t); f.completeOriginInput();
  assert.equal(typeof f.store.clearContinuationsExceptOrigin, 'function', 'requires upstream dependency 3');
  const runId = await f.begin(f.owner());
  f.db.prepare("UPDATE mode_transitions SET phase='cutover',cutoff=7 WHERE run_id=?").run(runId);
  f.store.setDrainFence('*'); const memory = f.tree();
  await f.owner().advance();
  assert.equal(f.store.getModeTransition(), null); assert.equal(f.readConfig().session_mode, 'single');
  assert.equal(f.store.getModeTransition({ runId }).phase, 'complete'); assert.equal(f.store.getModeTransition({ runId }).cutoff, 7);
  assert.deepEqual(f.tree(), memory); assert.equal(f.restarts.length, 1); assert.equal(f.store.getDrainFence('*'), null);
});

// Run after upstream native cutover storage APIs are available. Actual C4 writes
// must distinguish recipient inbound internal rows from sender/outbound history;
// no storage substitute is provided. This case does not send an external message.
test('native cutover to single voids only ordinary recipient internal input', async t => {
  const f = fixture(t); f.completeOriginInput();
  assert.equal(typeof f.store.clearContinuationsExceptOrigin, 'function', 'requires native cutover storage APIs');
  assert.equal(typeof f.store.voidInternalForSingle, 'function', 'requires native cutover storage APIs');
  const insert = f.db.prepare('INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group) VALUES(?,?,?,?,?,?)');
  const recipient = Number(insert.run('in','internal','recipient','ordinary recipient','pending','ordinary').lastInsertRowid);
  const origin = Number(insert.run('in','internal','origin','origin recipient','pending','origin').lastInsertRowid);
  const sender = Number(insert.run('out','internal','sender','sender history','pending','ordinary').lastInsertRowid);
  const before = f.rows('conversations'), coordinator = f.owner(), runId = await f.begin(coordinator);
  await coordinator.advance(); assert.equal(f.store.getModeTransition().phase, 'cutover');
  await coordinator.advance();
  assert.equal(f.store.getModeTransition(), null); assert.equal(f.readConfig().session_mode, 'single');
  assert.equal(f.store.getModeTransition({ runId }).phase, 'complete');
  const after = f.rows('conversations');
  assert.deepEqual(after.filter(row => row.id !== recipient), before.filter(row => row.id !== recipient));
  const voided = after.find(row => row.id === recipient);
  assert.equal(voided.status, 'failed'); assert.equal(voided.delivery_action, 'switch_voided');
  assert.equal(after.find(row => row.id === origin).status, 'pending');
  assert.equal(after.find(row => row.id === sender).status, 'pending');
  assert.equal(after.find(row => row.content === 'external pending').status, 'pending');
});


// Conversation drainage uses the real store's global count and markDelivered;
// only Origin controls/deadline lists are excluded from native control gating.
// This reaches cutover phase without invoking upstream cutover cleanup APIs.
test('native gating waits for sole Origin running input while retaining its scene and running control', async t => {
  const f = fixture(t), coordinator = f.owner();
  const controls = JSON.stringify(f.rows('control_queue').filter(row => row.session_group === 'origin'));
  const scene = { ...f.scenes[0] }, runId = await f.begin(coordinator);
  assert.equal(f.store.countGlobalRunningConversations(), 1);
  await coordinator.advance();
  assert.equal(f.store.getModeTransition().phase, 'gating');
  assert.equal(f.store.getModeTransition().reason, null);
  assert.equal(f.store.getDrainFence('origin'), null); assert.deepEqual(f.reclaimed, []);
  f.completeOriginInput(); assert.equal(f.store.countGlobalRunningConversations(), 0);
  await coordinator.advance();
  assert.equal(f.store.getModeTransition().run_id, runId); assert.equal(f.store.getModeTransition().phase, 'cutover');
  assert.deepEqual(f.scenes[0], scene);
  assert.equal(JSON.stringify(f.rows('control_queue').filter(row => row.session_group === 'origin')), controls);
  assert.equal(f.store.getDrainFence('origin'), null); assert.deepEqual(f.writes, []); assert.deepEqual(f.restarts, []);
});

// Acceptance boundary: real native coordinator, C4 selection/claim/conditional
// delivery recording, and SessionDelivery share this case's private file DB.
// Run for cutover/delivery group ownership changes with the upstream storage and
// scoped-delivery APIs present. Terminal paste/Enter I/O is a bounded fixture;
// this proves no real dispatcher restart, runtime transport, or reattachment.
// The official runner and separate user isolate all paths; fixture teardown
// stops delivery work before its owned DB/files are removed.
test('native roundtrip delivers queued input to Origin in single and retains unclaimed group input for multi', async t => {
  const f = fixture(t); f.completeOriginInput();
  const first = f.db.prepare("SELECT * FROM conversations WHERE content='external pending'").get();
  const second = f.store.insertConversation('in', 'fixture', 'waiting-room', 'unclaimed group input', { groupName: 'waiting' });
  assert.notEqual(first.session_group, 'origin'); assert.notEqual(second.session_group, 'origin');
  assert.equal(f.store.getNextPending().id, first.id);
  assert.equal(f.store.getNextPending({ sessionGroups: [second.session_group] }).id, second.id);
  const secondBefore = JSON.stringify(f.db.prepare('SELECT * FROM conversations WHERE id=?').get(second.id));
  const memory = JSON.stringify(f.tree());
  const coverage = JSON.stringify({ checkpoints: f.rows('checkpoints'), cursors: f.rows('origin_sync_cursors') });
  const single = f.owner(), singleRunId = await f.begin(single, 'single');
  await single.advance(); await single.advance();
  assert.equal(f.store.getModeTransition(), null); assert.equal(f.readConfig().session_mode, 'single');
  assert.equal(f.store.getModeTransition({ runId: singleRunId }).cutoff, null);
  const selected = f.store.getNextPending(); assert.equal(selected.id, first.id);
  assert.equal(f.db.prepare('SELECT session_group FROM conversations WHERE id=?').get(first.id).session_group, first.session_group);
  const delivery = deliveryFixture(t, { storage: { db: f.db, store: f.store }, mode: 'single' });
  try {
    assert.equal(delivery.db, f.db, 'delivery must share the transition ledger');
    assert.equal(f.store.claimConversation(selected.id), true);
    assert.equal(f.db.prepare('SELECT session_group FROM conversations WHERE id=?').get(first.id).session_group, first.session_group);
    assert.equal((await delivery.delivery.deliverConversation(selected)).delivered, true);
    const saved = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(first.id);
    assert.equal(saved.status, 'delivered'); assert.equal(saved.session_group, 'origin');
    assert.equal(saved.content, first.content);
    assert.deepEqual(delivery.calls.filter(call => call[0] === 'paste'), [['paste', 'origin']]);
    assert.ok(delivery.calls.filter(call => call[0] === 'keys').every(call => call[1] === 'origin'));
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM conversations WHERE id=?').get(second.id)), secondBefore);
    const multi = f.owner(), multiRunId = await f.begin(multi, 'multi');
    await multi.advance(); await multi.advance();
    assert.equal(f.store.getModeTransition(), null); assert.equal(f.readConfig().session_mode, 'multi');
    assert.equal(f.store.getModeTransition({ runId: multiRunId }).cutoff, null);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM conversations WHERE id=?').get(second.id)), secondBefore);
    const resumed = f.store.getNextPending({ sessionGroups: [second.session_group] });
    assert.equal(resumed.id, second.id); assert.equal(resumed.session_group, second.session_group);
    assert.equal(resumed.status, 'pending');
    assert.equal(JSON.stringify(f.tree()), memory);
    assert.equal(JSON.stringify({ checkpoints: f.rows('checkpoints'), cursors: f.rows('origin_sync_cursors') }), coverage);
    assert.equal(f.events.some(event => event.event === 'absorb'), false);
  } finally {
    await delivery.delivery.stop();
  }
});


// Run for gating and reclaim changes. C4 and lifecycle are real, with the
// official runner isolating HOME, ZYLOS_DIR, PM2_HOME and short TMPDIR. Runtime
// observations and stops are injected and use no tmux socket or other service.
test('gating stops busy groups after inbound delivery settles and preserves existing reclaim ownership', async t => {
  const f = fixture(t), coordinator = f.owner();
  f.completeOriginInput();
  const active = f.scenes[0];
  for (const group of ['fixture:fresh', 'fixture:reclaiming']) {
    f.scenes.push({ sessionGroup: group, runId: group, present: true, ready: true,
      processRunning: true, state: 'busy', activeSubagents: ['child'], currentSessionTs: 1 });
  }
  const stopped = [];
  coordinator.lifecycle = new SupervisorLifecycle({
    db: f.store,
    observeGroup: group => f.scenes.find(scene => scene.sessionGroup === group) ?? { present: false },
    readSyncMarker: () => assert.fail('mode-switch gating must not read Sync markers'),
    stop: scene => {
      stopped.push(scene.sessionGroup);
      f.scenes.splice(f.scenes.findIndex(item => item.sessionGroup === scene.sessionGroup), 1);
    },
  }, { now: () => 1800000000000 });
  const row = f.store.insertConversation('in', 'fixture', 'reclaiming', 'in flight', { groupName: 'reclaiming' });
  assert.equal(f.store.claimConversation(row.id), true);
  const control = f.store.insertControl('finish current work', {
    sessionGroup: 'fixture:reclaiming', ackDeadlineAt: 1800000300,
  });
  assert.equal(f.store.claimControl(control.id), true);
  const readControl = f.db.prepare('SELECT status, last_error FROM control_queue WHERE id=?');
  f.store.setDrainFence('fixture:reclaiming', { reason: 'ttl', runId: 'fixture:reclaiming' });
  const memory = f.tree();
  await f.begin(coordinator);
  await coordinator.advance();
  assert.deepEqual(stopped, ['fixture:fresh']);
  assert.equal(f.store.getModeTransition().phase, 'gating');
  assert.equal(f.store.getDrainFence('fixture:reclaiming').reason, 'ttl');
  assert.equal(readControl.get(control.id).status, 'running');
  assert.equal(f.store.markDelivered(row.id, { sessionId: 'delivery' }), true);
  await coordinator.advance();
  assert.deepEqual(stopped, ['fixture:fresh', 'fixture:reclaiming']);
  const expired = readControl.get(control.id);
  assert.equal(expired.status, 'timeout');
  assert.equal(expired.last_error, 'SESSION_ENDED');
  assert.equal(f.store.getModeTransition().phase, 'cutover');
  assert.deepEqual(f.store.listRunEndings(['fixture:fresh', 'fixture:reclaiming']).map(row => [row.reason, row.continuationPending]), [['mode_switch', 0], ['ttl', 0]]);
  await coordinator.advance();
  const back = f.owner();
  await f.begin(back, 'multi');
  await back.advance(); await back.advance();
  assert.equal(f.store.getModeTransition(), null);
  assert.deepEqual(f.scenes, [active]);
  assert.deepEqual(f.tree(), memory);
});
