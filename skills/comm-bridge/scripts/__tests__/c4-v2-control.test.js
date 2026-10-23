import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { createStore } from '../c4-v2-store.js';
const NOW = 1800000000;
const single = { now: () => NOW * 1000, readConfig: () => ({ state: 'ok', config: { session_mode: 'single' } }) };
const add = (s, sessionGroup, content = 'work', options = {}) => s.insertControl(content, { sessionGroup, appendAckSuffix: false, ...options });
const row = (db, id) => db.prepare('SELECT * FROM control_queue WHERE id=?').get(id);
const binding = run => ({ expectedRunId: run, tmuxTarget: { serverGeneration: 'gen', sessionId: '$1', paneId: '%2' } });

test('IF15 NULL scope is allowed only in single, fails closed on bad F1 and every open transition phase', t => {
  const { store: multi, db } = fixture(t);
  assert.throws(() => add(multi, null), { code: 'CONTROL_TARGET_REQUIRED' });
  assert.equal(db.prepare('SELECT count(*) n FROM control_queue').get().n, 0);
  const bad = createStore(db, { readConfig: () => { throw new Error('unreadable'); } });
  assert.throws(() => add(bad, null), { code: 'CONTROL_TARGET_REQUIRED' });
  const { store: s, db: local } = fixture(t, single);
  assert.equal(add(s, null).session_group, null);
  for (const phase of ['gating', 'converting', 'cutover']) {
    // A fresh DB represents a persisted open phase, independent of transition choreography.
    const { store: scoped, db: d } = fixture(t, single);
    scoped.beginModeTransition('single', 'multi');
    d.prepare('UPDATE mode_transitions SET phase=?').run(phase);
    assert.throws(() => add(scoped, null), { code: 'CONTROL_TARGET_REQUIRED' });
    assert.equal(d.prepare('SELECT count(*) n FROM control_queue').get().n, 0);
  }
  assert.equal(local.prepare('SELECT count(*) n FROM control_queue').get().n, 1);
});
test('DM23 supersede is scoped by content, group and normalized binding, never running', t => {
  const { store: s, db } = fixture(t, single);
  const a = add(s, 'a'), b = add(s, 'b'), machine = add(s, null);
  const current = add(s, 'a'); assert.equal(current.superseded_count, 1);
  assert.equal(row(db, a.id).status, 'superseded'); assert.equal(row(db, b.id).status, 'pending'); assert.equal(row(db, machine.id).status, 'pending');
  s.claimControl(current.id); assert.equal(add(s, 'a').superseded_count, 0); assert.equal(row(db, current.id).status, 'running');
  const bound = add(s, 'a', 'bound', { targetBinding: binding('r1') });
  const same = add(s, 'a', 'bound', { targetBinding: JSON.stringify({ tmuxTarget: { paneId: '%2', sessionId: '$1', serverGeneration: 'gen' }, expectedRunId: 'r1' }) });
  assert.equal(same.superseded_count, 1); assert.equal(row(db, bound.id).status, 'superseded');
  assert.equal(add(s, 'a', 'bound', { targetBinding: binding('r2') }).superseded_count, 0);
  const before = row(db, same.id);
  assert.throws(() => add(s, 'a', 'bound', { targetBinding: { ...binding('r1'), unexpected: true } }), { code: 'TARGET_BINDING_INVALID' });
  assert.deepEqual(row(db, same.id), before);
});
test('ack deadline required for implicit and explicit suffix; rejection cannot supersede existing pending', t => {
  const { store: s, db } = fixture(t, single);
  const existing = add(s, 'a', 'same');
  assert.throws(() => s.insertControl('same', { sessionGroup: 'a' }), { code: 'ACK_DEADLINE_REQUIRED' });
  assert.equal(row(db, existing.id).status, 'pending');
  assert.throws(() => add(s, 'a', 'work ---- ack via: node ack'), { code: 'ACK_DEADLINE_REQUIRED' });
  assert.match(s.insertControl('same', { sessionGroup: 'a', ackDeadlineAt: NOW + 30 }).content, /ack --id \d+$/);
  assert.equal(s.insertControl('machine').ack_deadline_at, null);
});
test('scope selectors, availability and two-connection CAS exclude machine/other groups and committed fences', t => {
  const { store: s, filename, dependencies, db } = fixture(t, single, true);
  const other = new Database(filename); t.after(() => other.close()); const peer = createStore(other, dependencies);
  const a = add(s, 'a'), b = add(s, 'b'), machine = add(s, null), future = add(s, 'future', 'later', { availableAt: NOW + 1 });
  assert.equal(s.getNextPendingControl(NOW).id, machine.id);
  assert.equal(s.getNextPendingControl(NOW, { sessionGroups: ['a'] }).id, a.id);
  assert.equal(s.getNextPendingControl(NOW, { sessionGroups: [] }), null);
  assert.equal(s.getNextPendingControl(NOW, { sessionGroups: ['future'] }), null);
  assert.equal(s.getNextPendingControl(NOW + 1, { sessionGroups: ['future'] }).id, future.id);
  peer.setDrainFence('a', { reason: 'auth', runId: 'r' });
  const before = row(db, a.id); assert.equal(s.claimControl(a.id), false); assert.deepEqual(row(db, a.id), before);
  assert.equal(s.getNextPendingControl(NOW, { sessionGroups: ['a', 'b'] }).id, b.id);
  assert.equal(s.claimControl(b.id), true); assert.equal(peer.claimControl(b.id), false);
  assert.equal(s.claimControl(machine.id), true);
  peer.clearDrainFence('a'); assert.equal(s.claimControl(a.id), true);
  peer.setDrainFence('*'); assert.equal(s.claimControl(future.id), false);
  assert.equal(s.getNextPendingControl(NOW + 1, { sessionGroups: ['future'] }), null);
});
test('DM24/25 three targets count and expire only pending, preserve running and terminal rows', t => {
  for (const [target, scopes] of [[{ sessionGroup: 'a' }, ['a']], [{ machine: true }, [null]], [{ allSessionGroups: true }, ['a', 'b']]]) {
    const { store: s, db } = fixture(t, single);
    const rows = [];
    for (const scope of ['a', 'b', null]) {
      rows.push(add(s, scope, 'pending'));
      const running = add(s, scope, 'running', { ackDeadlineAt: scope === null ? null : NOW + 10 }); s.claimControl(running.id); rows.push(running);
      const done = add(s, scope, 'done'); db.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(done.id); rows.push(done);
    }
    assert.deepEqual(s.countNonTerminalControls(target), { pending: scopes.length, running: scopes.length, runningWithoutDeadline: scopes.includes(null) ? 1 : 0 });
    const expected = rows.filter(r => scopes.includes(r.session_group) && r.raw_content === 'pending');
    assert.deepEqual(s.expirePendingControls(target), expected.map(r => ({ id: r.id, session_group: r.session_group, raw_content: r.raw_content })));
    for (const r of rows) {
      const actual = row(db, r.id);
      if (expected.some(e => e.id === r.id)) { assert.equal(actual.status, 'timeout'); assert.equal(actual.last_error, 'SESSION_ENDED'); }
      else assert.equal(actual.status, r.raw_content === 'done' ? 'done' : r.raw_content);
    }
  }
});
test('DM26 stale running uses strict timestamp boundary and all target forms', t => {
  for (const target of [{ sessionGroup: 'a' }, { machine: true }, { allSessionGroups: true }]) {
    const { store: s, db } = fixture(t, single); const expected = [];
    for (const scope of ['a', 'b', null]) for (const delta of [-1, 0, 1]) {
      const r = add(s, scope, `${delta}`); s.claimControl(r.id); db.prepare('UPDATE control_queue SET updated_at=? WHERE id=?').run(NOW + delta, r.id);
      if (delta < 0 && (target.machine ? scope === null : target.allSessionGroups ? scope !== null : scope === 'a')) expected.push(r.id);
    }
    assert.deepEqual(s.expireStaleRunningControls(target, { deliveredBefore: NOW }).map(r => r.id), expected);
    assert.equal(db.prepare("SELECT count(*) n FROM control_queue WHERE status='running'").get().n, 9 - expected.length);
    for (const id of expected) assert.equal(row(db, id).last_error, 'SESSION_ENDED');
  }
});
test('DM27 manual expire only active rows and target APIs reject ambiguous shapes', t => {
  const { store: s, db } = fixture(t, single);
  for (const status of ['pending', 'running', 'done', 'failed', 'timeout', 'superseded']) {
    const r = add(s, 'a', status); db.prepare('UPDATE control_queue SET status=? WHERE id=?').run(status, r.id);
    if (['pending', 'running'].includes(status)) { const result = s.expireControlById(r.id); assert.equal(result.last_error, 'MANUAL_EXPIRED'); assert.equal(result.status, 'timeout'); }
    else assert.throws(() => s.expireControlById(r.id), { code: 'CONTROL_NOT_ACTIVE' });
  }
  assert.throws(() => s.expireControlById(99999), { code: 'CONTROL_NOT_ACTIVE' });
  for (const invalid of [{}, { sessionGroup: 'a', machine: true }, { machine: false }, { allSessionGroups: false }, { sessionGroup: '*' }]) for (const method of ['countNonTerminalControls', 'expirePendingControls']) assert.throws(() => s[method](invalid));
});
test('fence validation matrix, first-write preservation and manual restart identity guards', t => {
  const { store: s } = fixture(t, single);
  for (const reason of ['ttl', 'evict']) assert.throws(() => s.setDrainFence('origin', { reason, runId: 'r' }), { code: 'FENCE_INVALID' });
  for (const [group, opts] of [['a', {}], ['a', { reason: 'manual_restart', runId: 'r' }], ['*', { reason: 'auth', runId: 'r' }]]) assert.throws(() => s.setDrainFence(group, opts), { code: 'FENCE_INVALID' });
  s.setDrainFence('a', { reason: 'ttl', runId: 'first' }); const first = s.getDrainFence('a'); s.setDrainFence('a', { reason: 'upgrade', runId: 'second' }); assert.deepEqual(s.getDrainFence('a'), first);
  s.clearDrainFence('a'); s.clearDrainFence('a');
  s.setDrainFence('origin', { reason: 'manual_restart', runId: 'old' });
  for (const args of [{}, { expectedReason: 'manual_restart', expectedRunId: 'new' }]) assert.throws(() => s.clearDrainFence('origin', args), { code: 'FENCE_MISMATCH' });
  assert.equal(s.getDrainFence('origin').runId, 'old');
  s.clearDrainFence('origin', { expectedReason: 'manual_restart', expectedRunId: 'old' }); assert.equal(s.getDrainFence('origin'), null);
  s.setDrainFence('*'); assert.throws(() => s.clearDrainFence('*'), { code: 'FENCE_INVALID' });
});
test('control insert rolls back supersede if insertion fails, preserving old command exactly', t => {
  const { store: s, db } = fixture(t, single);
  const old = add(s, 'a', 'repeat'); const before = row(db, old.id);
  db.exec("CREATE TRIGGER reject_new_control BEFORE INSERT ON control_queue BEGIN SELECT RAISE(ABORT,'insert failed'); END");
  assert.throws(() => add(s, 'a', 'repeat'), { code: 'DB_WRITE_FAILED' });
  assert.deepEqual(row(db, old.id), before); assert.equal(db.prepare('SELECT count(*) n FROM control_queue').get().n, 1);
});
test('two connections serialize NULL enqueue and begin transition in both commit orders', t => {
  for (const transitionFirst of [false, true]) {
    const { store: a, filename, dependencies, db } = fixture(t, single, true);
    const other = new Database(filename); t.after(() => other.close()); const b = createStore(other, dependencies);
    if (transitionFirst) {
      b.beginModeTransition('single', 'multi');
      assert.throws(() => add(a, null), { code: 'CONTROL_TARGET_REQUIRED' });
      assert.equal(db.prepare('SELECT count(*) n FROM control_queue').get().n, 0);
    } else {
      const accepted = add(a, null); b.beginModeTransition('single', 'multi');
      assert.equal(row(db, accepted.id).status, 'pending');
      assert.deepEqual(b.expirePendingControls({ machine: true }).map(r => r.id), [accepted.id]);
      assert.equal(row(db, accepted.id).status, 'timeout');
    }
  }
});

for (const reason of ['upgrade', 'auth', 'mode_switch', 'model_config']) {
  test(`Origin fence ${reason} accepts a run and rejects missing runs without writes`, t => {
    const { store, db } = fixture(t, single);
    const rows = () => db.prepare('SELECT * FROM drain_fences ORDER BY session_group').all();
    for (const options of [{ reason }, { reason, runId: null }, { reason, runId: '' }]) {
      assert.throws(() => store.setDrainFence('origin', options), { code: 'FENCE_INVALID' });
      assert.deepEqual(rows(), []);
    }
    store.setDrainFence('origin', { reason, runId: 'origin-run' });
    assert.deepEqual(rows(), [{ session_group: 'origin', reason, run_id: 'origin-run', created_at: NOW }]);
    assert.deepEqual(store.getDrainFence('origin'), { sessionGroup: 'origin', reason, runId: 'origin-run', createdAt: NOW });
    const before = rows();
    assert.throws(() => store.setDrainFence('origin', { reason }), { code: 'FENCE_INVALID' });
    assert.deepEqual(rows(), before, 'invalid retry preserves existing fence');
  });
}
