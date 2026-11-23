import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { createStore } from '../c4-v2-store.js';
const NOW = 1800000000;
const single = { now: () => NOW * 1000, readConfig: () => ({ state: 'ok', config: {} }) };
const add = (s, sessionGroup, content = 'work', options = {}) => s.insertControl(content, { sessionGroup, appendAckSuffix: false, ...options });
const row = (db, id) => db.prepare('SELECT * FROM control_queue WHERE id=?').get(id);
const binding = run => ({ expectedRunId: run, tmuxTarget: { serverGeneration: 'gen', sessionId: '$1', paneId: '%2' } });

test('NULL scope is allowed only before migration, fails closed on bad and every open transition phase', t => {
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
test('supersede is scoped by content, group and normalized binding, never running', t => {
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
test('three targets count and expire only pending, preserve running and terminal rows', t => {
  for (const [target, scopes] of [[{ sessionGroup: 'a' }, ['a']], [{ machine: true }, [null]], [{ allSessionGroups: true }, ['a', 'b']]]) {
    const { store: s, db } = fixture(t, single);
    const rows = [];
    for (const scope of ['a', 'b', null]) {
      rows.push(add(s, scope, 'pending'));
      const running = add(s, scope, 'running', { ackDeadlineAt: scope === null ? null : NOW + 10 }); s.claimControl(running.id); rows.push(running);
      const done = add(s, scope, 'done'); db.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(done.id); rows.push(done);
    }
    assert.deepEqual(s.countNonTerminalControls(target), { pending: scopes.length, running: scopes.length });
    const expected = rows.filter(r => scopes.includes(r.session_group) && r.raw_content === 'pending');
    assert.deepEqual(s.expirePendingControls(target), expected.map(r => ({ id: r.id, session_group: r.session_group, raw_content: r.raw_content })));
    for (const r of rows) {
      const actual = row(db, r.id);
      if (expected.some(e => e.id === r.id)) { assert.equal(actual.status, 'timeout'); assert.equal(actual.last_error, 'SESSION_ENDED'); }
      else assert.equal(actual.status, r.raw_content === 'done' ? 'done' : r.raw_content);
    }
  }
});
test('stale targeted running control ends without retry or another claim', t => {
  let now = NOW;
  const { store: s, db, filename } = fixture(t, { ...single, now: () => now * 1000 }, true);
  const observer = new Database(filename, { readonly: true }); t.after(() => observer.close());
  const selected = add(s, 'a', 'selected', { targetBinding: binding('old-run') });
  const other = add(s, 'b', 'other', { targetBinding: binding('other-run') });
  assert.equal(s.claimControl(selected.id), true); assert.equal(s.claimControl(other.id), true);
  db.prepare('UPDATE control_queue SET retry_count=2,last_error=? WHERE id=?').run('previous', selected.id);
  const before = row(observer, selected.id), otherBefore = row(observer, other.id);
  now++;
  const expected = { ...before, status: 'timeout', last_error: 'STALE_TARGET', updated_at: now };
  assert.deepEqual(s.failStaleTargetControl(selected.id), expected);
  assert.deepEqual(row(observer, selected.id), expected);
  assert.deepEqual(row(observer, other.id), otherBefore, 'only the requested id changes');
  assert.equal(s.getNextPendingControl(now, { sessionGroups: ['a'] }), null);
  assert.equal(s.claimControl(selected.id), false);
  assert.equal(s.failStaleTargetControl(selected.id), null);
  assert.deepEqual(row(observer, selected.id), expected, 'terminal retries do not change timestamp or retry_count');
});
test('control insert rolls back supersede if insertion fails, preserving old command exactly', t => {
  const { store: s, db } = fixture(t, single);
  const old = add(s, 'a', 'repeat'); const before = row(db, old.id);
  db.exec("CREATE TRIGGER reject_new_control BEFORE INSERT ON control_queue BEGIN SELECT RAISE(ABORT,'insert failed'); END");
  assert.throws(() => add(s, 'a', 'repeat'), { code: 'DB_WRITE_FAILED' });
  assert.deepEqual(row(db, old.id), before); assert.equal(db.prepare('SELECT count(*) n FROM control_queue').get().n, 1);
});
