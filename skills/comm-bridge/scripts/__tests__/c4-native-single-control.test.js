import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './c4-v2-test-helpers.js';

const native = { readConfig: () => ({ state: 'ok', config: { session_mode: 'single', runtime: 'claude' } }) };
const binding = { expectedRunId: 'old', tmuxTarget: { serverGeneration: 'gen', sessionId: '$1', paneId: '%1' } };
const control = (store, group, content, bound = false) => store.insertControl(content, {
  sessionGroup: group, appendAckSuffix: false, targetBinding: bound ? binding : null,
});

test('native single resolves Origin overrides and retains other group launch choices; legacy uses baseline', t => {
  for (const config of [{ session_mode: 'single' }, {}, null]) {
    const { store, db } = fixture(t, { readConfig: () => config === null ? { state: 'missing' } : { state: 'ok', config } });
    db.exec("INSERT INTO group_runtime_overrides VALUES('origin','codex'),('other','agy'); INSERT INTO group_model_overrides VALUES('origin','codex','model','high')");
    assert.equal(store.readBaseline().keyPresent, config !== null && Object.hasOwn(config, 'session_mode'));
    assert.deepEqual(store.resolveSessionLaunchConfig({ sessionGroup: null, sessionMode: 'single' }),
      { runtime: 'claude', mode: 'default' });
    assert.deepEqual(store.resolveSessionLaunchConfig({ sessionGroup: 'origin', sessionMode: 'single' }), config?.session_mode ?
      { runtime: 'codex', mode: 'override', model: 'model', effort: 'high' } : { runtime: 'claude', mode: 'default' });
    if (config?.session_mode) {
      assert.deepEqual(store.resolveSessionLaunchConfig({ sessionGroup: 'other', sessionMode: 'single' }), { runtime: 'agy', mode: 'default' });
      db.exec("DELETE FROM group_runtime_overrides WHERE session_group='origin'");
      assert.deepEqual(store.resolveSessionLaunchConfig({ sessionGroup: 'origin', sessionMode: 'single' }), { runtime: 'claude', mode: 'default' });
    }
  }
});

test('native single rejects malformed launch groups while null keeps the baseline runtime', t => {
  const { store } = fixture(t, { readConfig: () => ({ state: 'ok', config: { session_mode: 'single', runtime: 'agy' } }) });
  assert.deepEqual(store.resolveSessionLaunchConfig({ sessionGroup: null, sessionMode: 'single' }), { runtime: 'agy', mode: 'default' });
  for (const sessionGroup of [undefined, '', 0]) {
    assert.throws(() => store.resolveSessionLaunchConfig({ sessionGroup, sessionMode: 'single' }), { code: 'SESSION_GROUP_INVALID' });
  }
  assert.throws(() => store.resolveSessionLaunchConfig({ sessionGroup: null, sessionMode: 'multi' }), { code: 'SESSION_GROUP_INVALID' });
});

test('native single rejects NULL controls and records Origin endings; legacy alone accepts NULL', t => {
  const { store, db } = fixture(t, native);
  assert.throws(() => store.insertControl('machine'), { code: 'CONTROL_TARGET_REQUIRED' });
  control(store, 'origin', 'role');
  store.setDrainFence('origin', { reason: 'ttl', runId: 'run' });
  assert.deepEqual(store.recordRunEnd('origin', { runId: 'run', reason: 'ttl', clearFence: true }), { recorded: true });
  assert.equal(store.getDrainFence('origin'), null);
  assert.deepEqual(store.recordRunEnd('origin', { runId: 'next', reason: 'unexpected' }), { recorded: true });
  assert.equal(db.prepare("SELECT continuation_pending FROM run_endings WHERE session_group='origin'").get().continuation_pending, 1);
  const legacy = fixture(t, { readConfig: () => ({ state: 'missing' }) }).store;
  assert.equal(legacy.insertControl('machine').session_group, null);
  assert.throws(() => legacy.recordRunEnd('origin', { runId: 'run', reason: 'ttl' }), { code: 'INVALID_ARGS' });
});

test('native single clears a previous Origin continuation and rejects inactive scopes without writes', t => {
  const { store, db } = fixture(t, native);
  store.recordRunEnd('origin', { runId: 'old', reason: 'unexpected' });
  assert.deepEqual(store.clearContinuation('origin', { runId: 'old' }), { cleared: false });
  assert.deepEqual(store.clearContinuation('origin', { runId: 'new' }), { cleared: true });
  assert.deepEqual(store.clearContinuation('origin', { runId: 'next' }), { cleared: false });
  const before = db.prepare('SELECT * FROM run_endings').all();
  assert.throws(() => store.recordRunEnd('other', { runId: 'old', reason: 'unexpected' }), { code: 'INVALID_ARGS' });
  assert.throws(() => store.clearContinuation('other', { runId: 'new' }), { code: 'INVALID_ARGS' });
  assert.deepEqual(db.prepare('SELECT * FROM run_endings').all(), before);
  const legacy = fixture(t, { readConfig: () => ({ state: 'missing' }) }).store;
  assert.throws(() => legacy.clearContinuation('origin', { runId: 'new' }), { code: 'INVALID_ARGS' });
});

test('cutover clears other continuations while preserving Origin', t => {
  const { store, db } = fixture(t);
  for (const group of ['origin', 'a', 'b']) store.recordRunEnd(group, { runId: 'old', reason: 'unexpected' });
  assert.deepEqual(store.clearContinuationsExceptOrigin(), { cleared: 2 });
  assert.deepEqual(db.prepare('SELECT session_group,continuation_pending FROM run_endings ORDER BY session_group').all(), [
    { session_group: 'a', continuation_pending: 0 }, { session_group: 'b', continuation_pending: 0 }, { session_group: 'origin', continuation_pending: 1 },
  ]);
  assert.deepEqual(store.clearContinuationsExceptOrigin(), { cleared: 0 });
});

test('internal cleanup rejects absent or ineligible transitions without changing messages', t => {
  const { store, db } = fixture(t);
  db.exec("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('in','internal','queued','pending','other')");
  const { runId } = store.beginModeTransition('multi', 'single');
  const before = db.prepare('SELECT * FROM conversations').all();
  for (const id of [undefined, null, '', 'absent', runId]) assert.throws(() => store.voidInternalForSingle(id), { code: 'TRANSITION_PRECONDITION' });
  db.prepare("UPDATE mode_transitions SET phase='cutover',source_mode='single',target_mode='multi' WHERE run_id=?").run(runId);
  assert.throws(() => store.voidInternalForSingle(runId), { code: 'TRANSITION_PRECONDITION' });
  assert.deepEqual(db.prepare('SELECT * FROM conversations').all(), before);
});

test('native single cutover voids only other pending internal input and handles later arrivals', t => {
  const { store, db } = fixture(t);
  const { runId } = store.beginModeTransition('multi', 'single');
  store.setDrainFence('*');
  store.setModeTransitionPhase(runId, 'cutover');
  const insert = db.prepare('INSERT INTO conversations(direction,channel,content,status,session_group) VALUES(?,?,?,?,?)');
  const rows = [
    ['in', 'internal', 'pending', 'a'],
    ['in', 'internal', 'pending', 'b'],
    ['in', 'internal', 'pending', 'origin'],
    ['in', 'telegram', 'pending', 'a'],
    ['out', 'internal', 'pending', 'a'],
    ...['running', 'delivered', 'failed', 'switch_absorbed'].map(status => ['in', 'internal', status, 'a']),
  ].map(([direction, channel, status, group], index) => {
    const id = Number(insert.run(direction, channel, `message-${index}`, status, group).lastInsertRowid);
    return db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  });
  const voided = rows.slice(0, 2).map(row => row.id);
  assert.deepEqual(store.voidInternalForSingle(runId).map(row => row.id).sort((a, b) => a - b), voided);
  for (const row of rows) {
    assert.deepEqual(db.prepare('SELECT * FROM conversations WHERE id=?').get(row.id), voided.includes(row.id)
      ? { ...row, status: 'failed', delivery_action: 'switch_voided' } : row);
  }
  assert.deepEqual(store.voidInternalForSingle(runId), []);
  const later = Number(insert.run('in', 'internal', 'later', 'pending', 'c').lastInsertRowid);
  assert.deepEqual(store.voidInternalForSingle(runId), [{ id: later }]);
  assert.deepEqual(db.prepare('SELECT status,delivery_action FROM conversations WHERE id=?').get(later),
    { status: 'failed', delivery_action: 'switch_voided' });
  assert.deepEqual(store.voidInternalForSingle(runId), []);
});

for (const keepOrigin of [true, undefined]) {
  test(`pending expiry preserves ${keepOrigin ? 'all' : 'no'} Origin controls and isolates machine/running`, t => {
    const { store, db } = fixture(t, native);
    const role = control(store, 'origin', 'role');
    const bound = control(store, 'origin', 'bound', true);
    const other = control(store, 'other', 'other');
    const running = control(store, 'other', 'running');
    db.prepare("UPDATE control_queue SET status='running' WHERE id=?").run(running.id);
    db.exec("INSERT INTO control_queue(raw_content,content,status,created_at,updated_at) VALUES('machine','machine','pending',0,0)");
    const expired = store.expirePendingControls({ allSessionGroups: true, ...(keepOrigin ? { keepOrigin } : {}) });
    assert.deepEqual(expired.map(row => row.id).sort(), (keepOrigin ? [other.id] : [role.id, bound.id, other.id]).sort());
    assert.equal(store.countNonTerminalControls({ machine: true }).pending, 1);
    assert.equal(store.countNonTerminalControls({ allSessionGroups: true }).running, 1);
    assert.equal(store.expirePendingControls({ machine: true }).length, 1);
  });
}

test('preservation options reject malformed values and remain exclusive to pending expiry', t => {
  const { store } = fixture(t, native);
  for (const input of [null, [], { allSessionGroups: true, keepOrigin: 'all' }, { allSessionGroups: true, keepOrigin: undefined }, { machine: true, keepOrigin: 'all' }, { sessionGroup: 'origin', keepOrigin: 'role' }, { allSessionGroups: true, keepOrigin: 'all', extra: true }]) {
    assert.throws(() => store.expirePendingControls(input), { code: 'INVALID_ARGS' });
  }
  const input = { allSessionGroups: true, keepOrigin: true };
  for (const method of ['countNonTerminalControls', 'listRunningControlsWithoutDeadline']) assert.throws(() => store[method](input), { code: 'INVALID_ARGS' });
  assert.throws(() => store.expireStaleRunningControls(input, { deliveredBefore: 100 }), { code: 'INVALID_ARGS' });
});

test('single Origin need counts unfenced pending input from all groups without reading configuration', t => {
  const { db, store } = fixture(t, { readConfig: () => assert.fail('Origin need must not read F1') });
  db.exec("INSERT INTO conversations(timestamp,direction,channel,content,status,session_group) VALUES ('2026-01-01 00:00:00','in','system','a','pending','other'),('2026-01-02 00:00:00','in','system','b','pending','origin'),('2026-01-03 00:00:00','in','system','c','delivered','other')");
  assert.equal(store.getOriginNeed(100, { sessionMode: 'multi' }).inbound.count, 1);
  assert.deepEqual(store.getOriginNeed(100, { sessionMode: 'single' }).inbound, { count: 2, oldestAt: Date.parse('2026-01-01T00:00:00Z') / 1000 });
  store.setDrainFence('other', { reason: 'ttl', runId: 'run' });
  assert.equal(store.getOriginNeed(100, { sessionMode: 'single' }).inbound.count, 1);
  store.clearDrainFence('other');
  assert.equal(store.getOriginNeed(100, { sessionMode: 'single' }).inbound.count, 2);
  assert.throws(() => store.getOriginNeed(100, { sessionMode: 'invalid' }), { code: 'INVALID_ARGS' });
});

test('native binding requires Origin scope and matching environment; legacy requires NULL scope', async t => {
  let environment = 'origin', calls = 0;
  const target = () => ({ runId: 'old', runtime: 'claude', sessionGroup: environment, currentSession: { runId: 'old' }, tmuxTarget: binding.tmuxTarget });
  const { store } = fixture(t, { ...native, resolveTarget: input => { calls++; assert.deepEqual(input, { sessionMode: 'single', sessionGroup: 'origin' }); return target(); } });
  assert.equal(await store.buildTargetBinding({ sessionGroup: 'origin', expectedRunId: 'old' }), JSON.stringify(binding));
  for (const sessionGroup of [null, 'other']) await assert.rejects(() => store.buildTargetBinding({ sessionGroup, expectedRunId: 'old' }), { code: 'TARGET_SCOPE_MISMATCH' });
  assert.equal(calls, 1);
  for (environment of [null, undefined, 'other']) await assert.rejects(() => store.buildTargetBinding({ sessionGroup: 'origin', expectedRunId: 'old' }), { code: 'TARGET_SCOPE_MISMATCH' });
  environment = null;
  const legacy = fixture(t, { readConfig: () => ({ state: 'missing' }), resolveTarget: () => target() }).store;
  assert.equal(await legacy.buildTargetBinding({ expectedRunId: 'old' }), JSON.stringify(binding));
  await assert.rejects(() => legacy.buildTargetBinding({ sessionGroup: 'origin', expectedRunId: 'old' }), { code: 'TARGET_SCOPE_MISMATCH' });
  environment = 'origin';
  await assert.rejects(() => legacy.buildTargetBinding({ expectedRunId: 'old' }), { code: 'TARGET_SCOPE_MISMATCH' });
});
