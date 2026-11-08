import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './c4-v2-test-helpers.js';

function setup(t) {
  const { db, store } = fixture(t, { now: () => 2000000 });
  const insert = (changes = {}) => {
    const row = { status: 'running', group: null, deadline: null, created: 1000, updated: 1000, ...changes };
    return Number(db.prepare(`INSERT INTO control_queue
      (content,raw_content,status,session_group,ack_deadline_at,created_at,updated_at)
      VALUES('exit','exit',?,?,?,?,?)`).run(row.status, row.group, row.deadline, row.created, row.updated).lastInsertRowid);
  };
  const { runId } = store.beginModeTransition('single', 'multi');
  store.setDrainFence('*');
  return { db, store, runId, insert };
}

test('legacy cleanup expires only old machine running controls without deadlines and is replay safe', t => {
  const { db, store, runId, insert } = setup(t);
  const old = insert();
  const preserved = [insert({ deadline: 9999 }), insert({ group: 'origin' }), insert({ status: 'pending' }),
    insert({ status: 'acked' }), insert({ created: 2000 }), insert({ updated: 2000 }), insert({ updated: 2001 })];
  const before = preserved.map(id => db.prepare('SELECT * FROM control_queue WHERE id=?').get(id));
  assert.deepEqual(store.expireLegacyRunningControls(runId), { count: 1, ids: [old] });
  const ended = db.prepare('SELECT status,last_error,updated_at FROM control_queue WHERE id=?').get(old);
  assert.deepEqual(ended, { status: 'timeout', last_error: 'SESSION_ENDED', updated_at: 2000 });
  for (let i = 0; i < preserved.length; i++) assert.deepEqual(db.prepare('SELECT * FROM control_queue WHERE id=?').get(preserved[i]), before[i]);
  assert.deepEqual(store.expireLegacyRunningControls(runId), { count: 0, ids: [] });
});

for (const obstacle of ['missing', 'phase', 'direction', 'missing-fence', 'manual-fence', 'extra-fence']) {
  test(`legacy cleanup rejects ${obstacle} ownership without changing controls`, t => {
    const { db, store, runId, insert } = setup(t), id = insert();
    if (obstacle === 'phase') db.prepare("UPDATE mode_transitions SET phase='converting'").run();
    if (obstacle === 'direction') db.prepare("UPDATE mode_transitions SET source_mode='multi',target_mode='single'").run();
    if (obstacle === 'missing-fence') db.prepare('DELETE FROM drain_fences').run();
    if (obstacle === 'manual-fence') db.prepare("UPDATE drain_fences SET reason='manual_restart',run_id='manual'").run();
    if (obstacle === 'extra-fence') store.setDrainFence('origin', { reason: 'ttl', runId: 'old' });
    assert.throws(() => store.expireLegacyRunningControls(obstacle === 'missing' ? 'other' : runId),
      { code: obstacle === 'missing' ? 'RUN_NOT_FOUND' : 'TRANSITION_PRECONDITION' });
    assert.equal(db.prepare('SELECT status FROM control_queue WHERE id=?').get(id).status, 'running');
  });
}

test('legacy cleanup bounds diagnostic ids and counts all expired rows', t => {
  const { store, runId, insert } = setup(t);
  for (let i = 0; i < 25; i++) insert();
  const result = store.expireLegacyRunningControls(runId);
  assert.equal(result.count, 25); assert.equal(result.ids.length, 20);
  assert.equal(store.countNonTerminalControls({ machine: true }).running, 0);
});

test('legacy cleanup rolls back every control when a write fails', t => {
  const { db, store, runId, insert } = setup(t);
  const first = insert(), second = insert();
  db.exec(`CREATE TRIGGER reject_cleanup BEFORE UPDATE ON control_queue WHEN OLD.id=${second}
    BEGIN SELECT RAISE(ABORT,'cleanup rejected'); END`);
  assert.throws(() => store.expireLegacyRunningControls(runId), { code: 'DB_WRITE_FAILED' });
  for (const id of [first, second]) assert.equal(db.prepare('SELECT status FROM control_queue WHERE id=?').get(id).status, 'running');
});
