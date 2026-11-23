import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './c4-v2-test-helpers.js';

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

test('single Origin need counts unfenced pending input from all groups without reading configuration', t => {
  const { db, store } = fixture(t, { readConfig: () => assert.fail('Origin need must not read config.json') });
  db.exec("INSERT INTO conversations(timestamp,direction,channel,content,status,session_group) VALUES ('2026-01-01 00:00:00','in','system','a','pending','other'),('2026-01-02 00:00:00','in','system','b','pending','origin'),('2026-01-03 00:00:00','in','system','c','delivered','other')");
  assert.equal(store.getOriginNeed(100, { sessionMode: 'multi' }).inbound.count, 1);
  assert.deepEqual(store.getOriginNeed(100, { sessionMode: 'single' }).inbound, { count: 2, oldestAt: Date.parse('2026-01-01T00:00:00Z') / 1000 });
  store.setDrainFence('other', { reason: 'ttl', runId: 'run' });
  assert.equal(store.getOriginNeed(100, { sessionMode: 'single' }).inbound.count, 1);
  store.clearDrainFence('other');
  assert.equal(store.getOriginNeed(100, { sessionMode: 'single' }).inbound.count, 2);
  assert.throws(() => store.getOriginNeed(100, { sessionMode: 'invalid' }), { code: 'INVALID_ARGS' });
});
