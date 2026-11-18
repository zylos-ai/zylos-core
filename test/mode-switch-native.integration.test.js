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

// Acceptance boundary: actual coordinator and schema-guarded private file SQLite.
// Scene observation, lifecycle stop, dispatcher confirmation, and config writing
// are injected. These cases do not prove real tmux/session or PM2 behavior.
// Run through the official isolated Node runner, under a separate Unix user.
// Every fixture owns its config, memory tree, and DB; teardown closes the DB and
// removes only that temporary tree. No services, external sends, or child work.
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
    lifecycle: { advanceReclaim: fence => { reclaimed.push({ ...fence }); } },
    convert: () => assert.fail('native switch must never invoke conversion'),
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
    assert.equal(result.result, 'accepted'); assert.equal(store.getModeTransition().kind, 'switch'); return result.runId;
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

// Run gating and cancellation without cutover dependencies; skip only unrelated
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
test('native cancel accepted immediately before first gating tick leaves payload bytewise unchanged', async t => {
  const f = fixture(t), coordinator = f.owner(), before = f.payload();
  const runId = await f.begin(coordinator);
  assert.equal(f.store.getDrainFence('*'), null);
  assert.deepEqual(await coordinator.cancel({ runId }), { ok: true, result: 'cancelled', runId });
  assert.equal(f.store.getModeTransition(), null); assert.equal(f.store.getModeTransition({ runId }).phase, 'cancelled');
  assert.equal(f.store.getDrainFence('*'), null); assert.equal(f.payload(), before);
  await coordinator.advance(); assert.equal(f.payload(), before); assert.deepEqual(f.restarts, []);
});
test('native gating cancel restores recorded continuation rules and lets in-flight group fences finish', async t => {
  const f = fixture(t), coordinator = f.owner();
  f.store.recordRunEnd('before', { runId: 'before', reason: 'ttl' });
  const runId = await f.begin(coordinator);
  f.store.setDrainFence('*'); f.store.setDrainFence('still-draining', { reason: 'mode_switch', runId: 'late' });
  for (const [group, reason] of [['stopped','mode_switch'],['origin','upgrade'],['crashed','unexpected'],['ttl','ttl'],['auth','auth'],['model','model_config'],['manual','manual_restart']]) {
    f.store.recordRunEnd(group, { runId: group, reason });
    assert.equal(f.store.listRunEndings([group])[0].continuationPending, 0);
  }
  const before = f.payload();
  assert.equal((await coordinator.cancel({ runId })).result, 'cancelled');
  assert.equal(f.payload(), before); assert.equal(f.store.getDrainFence('*'), null);
  assert.equal(f.store.getDrainFence('still-draining').runId, 'late');
  for (const group of ['stopped','origin','crashed','auth','model','manual']) assert.equal(f.store.listRunEndings([group])[0].continuationPending, 1, group);
  for (const group of ['before','ttl']) assert.equal(f.store.listRunEndings([group])[0].continuationPending, 0, group);
  assert.equal(f.store.listRunEndings(['unrecorded-crash']).length, 0);
  f.tick(1); f.store.recordRunEnd('still-draining', { runId: 'late', reason: 'mode_switch', clearFence: true });
  assert.equal(f.store.listRunEndings(['still-draining'])[0].continuationPending, 1); assert.equal(f.store.getDrainFence('still-draining'), null);
});
test('native gating survives coordinator restart and can cancel from durable authority', async t => {
  const f = fixture(t), coordinator = f.owner();
  f.scenes.push({ sessionGroup: 'ordinary', runId: 'ordinary-current', present: true, ready: true });
  const runId = await f.begin(coordinator); await coordinator.advance();
  const before = f.payload(), restored = f.owner();
  assert.equal((await restored.cancel({ runId })).result, 'cancelled');
  assert.equal(f.store.getModeTransition(), null); assert.equal(f.payload(), before);
  assert.equal(f.store.getDrainFence('origin'), null); assert.deepEqual(f.writes, []);
});
test('native historical converting switch fails closed after coordinator restart', async t => {
  const f = fixture(t), runId = await f.begin(f.owner());
  f.db.prepare("UPDATE mode_transitions SET phase='converting',cutoff=7 WHERE run_id=?").run(runId);
  f.store.setDrainFence('*'); const before = f.payload();
  await f.owner().advance();
  const row = f.store.getModeTransition();
  assert.equal(row.phase, 'converting'); assert.equal(row.reason, 'mode_conflict:converting:multi');
  assert.equal((await f.owner().cancel({ runId })).code, 'not_cancellable');
  assert.equal(f.payload(), before); assert.ok(f.store.getDrainFence('*')); assert.deepEqual(f.writes, []); assert.deepEqual(f.restarts, []);
});

// Cutover acceptance requires upstream dependency 3's actual keepOrigin and
// clearContinuationsExceptOrigin APIs. No substitute storage implementation and
// no automatic skip: run these once dependency 3 is present; until then select
// the gating/cancel/converting cases explicitly by --test-name-pattern.
test('native roundtrip cutover preserves Origin controls markers messages checkpoints cursors and memory', async t => {
  const f = fixture(t); f.completeOriginInput();
  assert.equal(typeof f.store.clearContinuationsExceptOrigin, 'function', 'requires upstream dependency 3');
  f.store.recordRunEnd('origin', { runId: 'origin-previous', reason: 'upgrade' });
  f.store.recordRunEnd('ordinary', { runId: 'ordinary-previous', reason: 'upgrade' });
  const originControls = JSON.stringify(f.rows('control_queue').filter(row => row.session_group === 'origin'));
  const originEnding = JSON.stringify(f.store.listRunEndings(['origin']));
  const frozen = () => JSON.stringify({ conversations: f.rows('conversations'), checkpoints: f.rows('checkpoints'), cursors: f.rows('origin_sync_cursors'), memory: f.tree() });
  const before = frozen(), originScene = { ...f.scenes[0] };
  for (const target of ['single', 'multi']) {
    const coordinator = f.owner(), runId = await f.begin(coordinator, target);
    await coordinator.advance(); assert.equal(f.store.getModeTransition().phase, 'cutover');
    assert.equal((await coordinator.cancel({ runId })).code, 'not_cancellable');
    await coordinator.advance();
    assert.equal(f.store.getModeTransition(), null); assert.equal(f.readConfig().session_mode, target);
    const completed = f.store.getModeTransition({ runId }); assert.equal(completed.phase, 'complete'); assert.equal(completed.cutoff, null);
    assert.equal(JSON.stringify(f.rows('control_queue').filter(row => row.session_group === 'origin')), originControls);
    assert.equal(JSON.stringify(f.store.listRunEndings(['origin'])), originEnding);
    assert.equal(f.store.listRunEndings(['ordinary'])[0].continuationPending, 0);
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
