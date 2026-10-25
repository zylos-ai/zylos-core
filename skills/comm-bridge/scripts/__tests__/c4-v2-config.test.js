import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { createStore } from '../c4-v2-store.js';
const group = 'chat';
const pair = (runtime, model, effort) => ({ sessionGroup: group, runtime, model, effort });

function peerFixture(t, dependencies = {}) {
  const f = fixture(t, dependencies, true);
  const peerDb = new Database(f.filename);
  t.after(() => peerDb.close());
  const peer = createStore(peerDb, f.dependencies);
  f.store.insertConversation('in', group, 'e', 'seed');
  return { ...f, peerDb, peer };
}

// Hook the real D10 statement after SQLite has completed it. The peer commits
// while the first WAL connection's read transaction remains open.
function afterRuntimeRead(t, db, callback) {
  const prepare = db.prepare.bind(db); let fired = false;
  db.prepare = sql => {
    const statement = prepare(sql);
    if (/^SELECT runtime FROM group_runtime_overrides/.test(sql)) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const result = get(...args);
        if (!fired) { fired = true; callback(); }
        return result;
      };
    }
    return statement;
  };
  t.after(() => { db.prepare = prepare; });
  return () => fired;
}

test('IF46/DM33 F1 is read once and D10/D11 retain one WAL snapshot across a peer commit', t => {
  let reads = 0;
  const f = peerFixture(t, { readConfig: () => ({ state: 'ok', config: { runtime: ++reads === 1 ? 'claude' : 'codex', session_mode: 'multi' } }) });
  f.store.setSessionModelConfig(pair('claude', 'old-model', 'low'));
  f.store.setSessionModelConfig(pair('codex', 'codex-model', 'high'));
  const fired = afterRuntimeRead(t, f.db, () => {
    assert.equal(f.db.inTransaction, true);
    f.peer.setSessionRuntimeConfig({ sessionGroup: group, runtime: 'codex' });
    f.peer.setSessionModelConfig(pair('claude', 'new-model', 'high'));
    assert.equal(f.peer.getSessionRuntimeConfig({ sessionGroup: group }).runtime, 'codex');
  });
  assert.deepEqual(f.store.resolveSessionLaunchConfig({ sessionGroup: group, sessionMode: 'multi' }), { runtime: 'claude', mode: 'override', model: 'old-model', effort: 'low' });
  assert.equal(fired(), true); assert.equal(reads, 1); assert.equal(f.db.inTransaction, false);
  assert.deepEqual(f.store.resolveSessionLaunchConfig({ sessionGroup: group, sessionMode: 'multi' }), { runtime: 'codex', mode: 'override', model: 'codex-model', effort: 'high' });
  assert.equal(reads, 2);
});
test('snapshot oracle detects known-bad independent D10/D11 reads across the same peer commit', t => {
  const f = peerFixture(t);
  f.store.setSessionModelConfig(pair('claude', 'old-model', 'low'));
  afterRuntimeRead(t, f.db, () => {
    assert.equal(f.db.inTransaction, false);
    f.peer.setSessionRuntimeConfig({ sessionGroup: group, runtime: 'codex' });
    f.peer.setSessionModelConfig(pair('claude', 'new-model', 'high'));
  });
  // Deliberate local mutant of the read algorithm; production code is untouched.
  const selected = f.db.prepare('SELECT runtime FROM group_runtime_overrides WHERE session_group=?').get(group)?.runtime ?? 'claude';
  const mixed = f.db.prepare('SELECT model,effort FROM group_model_overrides WHERE session_group=? AND runtime=?').get(group, selected);
  assert.deepEqual(mixed, { model: 'new-model', effort: 'high' });
  assert.notDeepEqual({ runtime: selected, ...mixed }, { runtime: 'claude', model: 'old-model', effort: 'low' });
});
test('complete model pair is invisible until commit and changes as one pair to another connection', t => {
  const f = peerFixture(t);
  f.store.setSessionModelConfig(pair('claude', 'old', 'low'));
  const exec = f.db.exec.bind(f.db); let observed = false;
  f.db.exec = sql => {
    if (sql === 'COMMIT' && !observed) {
      observed = true;
      assert.deepEqual(f.peer.getSessionModelConfig({ sessionGroup: group, runtime: 'claude' }), { runtime: 'claude', mode: 'override', model: 'old', effort: 'low' });
    }
    return exec(sql);
  };
  t.after(() => { f.db.exec = exec; });
  assert.deepEqual(f.store.setSessionModelConfig(pair('claude', 'new', 'high')), { changed: true, desired: { runtime: 'claude', mode: 'override', model: 'new', effort: 'high' } });
  assert.equal(observed, true);
  assert.deepEqual(f.peer.getSessionModelConfig({ sessionGroup: group, runtime: 'claude' }), { runtime: 'claude', mode: 'override', model: 'new', effort: 'high' });
});
test('failed paired UPSERT preserves old pair and committed values survive reopening', t => {
  const f = peerFixture(t);
  f.store.setSessionModelConfig(pair('claude', 'old', 'low'));
  f.db.exec("CREATE TRIGGER reject_pair BEFORE UPDATE ON group_model_overrides BEGIN SELECT RAISE(ABORT,'rejected pair'); END");
  assert.throws(() => f.store.setSessionModelConfig(pair('claude', 'new', 'high')), { code: 'CONFIG_STORE_FAILED', persisted: [] });
  const db2 = new Database(f.filename); t.after(() => db2.close());
  assert.deepEqual(createStore(db2, f.dependencies).getSessionModelConfig({ sessionGroup: group, runtime: 'claude' }), { runtime: 'claude', mode: 'override', model: 'old', effort: 'low' });
});
test('runtime reset preserves all runtime model rows; same-value and repeated reset are idempotent', t => {
  const { store: s } = peerFixture(t);
  for (const runtime of ['claude', 'codex']) s.setSessionModelConfig(pair(runtime, `${runtime}-model`, 'high'));
  assert.throws(() => s.setSessionRuntimeConfig({ sessionGroup: 'foo:absent', runtime: 'codex' }), { code: 'SESSION_GROUP_NOT_FOUND' });
  assert.equal(s.setSessionRuntimeConfig({ sessionGroup: group, runtime: 'codex' }).changed, true);
  assert.equal(s.setSessionRuntimeConfig({ sessionGroup: group, runtime: 'codex' }).changed, false);
  assert.equal(s.resetSessionRuntimeConfig({ sessionGroup: group }).changed, true);
  assert.equal(s.resetSessionRuntimeConfig({ sessionGroup: group }).changed, false);
  for (const runtime of ['claude', 'codex']) assert.equal(s.getSessionModelConfig({ sessionGroup: group, runtime }).model, `${runtime}-model`);
  assert.equal(s.resetSessionModelConfig({ sessionGroup: group, runtime: 'codex' }).changed, true);
  assert.equal(s.resetSessionModelConfig({ sessionGroup: group, runtime: 'codex' }).changed, false);
  assert.equal(s.getSessionModelConfig({ sessionGroup: group, runtime: 'claude' }).mode, 'override');
});
test('adapter-declared rejection maps MODEL_CONFIG_INVALID and malformed pairs never invoke adapter or modify rows', t => {
  let calls = 0, reject = false;
  const { store: s } = peerFixture(t, { validateModel: () => { calls++; return reject ? { valid: false, message: 'effort is unsupported for this model' } : true; } });
  s.setSessionModelConfig(pair('claude', 'old', 'low')); reject = true;
  for (const [model, effort] of [['', 'low'], [' ', 'low'], ['new', null], [undefined, 'high']]) assert.throws(() => s.setSessionModelConfig(pair('claude', model, effort)), { code: 'MODEL_PAIR_REQUIRED' });
  assert.equal(calls, 1);
  assert.throws(() => s.setSessionModelConfig(pair('claude', 'new', 'unsupported')), { code: 'MODEL_CONFIG_INVALID', message: 'effort is unsupported for this model' });
  assert.deepEqual(s.getSessionModelConfig({ sessionGroup: group, runtime: 'claude' }), { runtime: 'claude', mode: 'override', model: 'old', effort: 'low' });
});
test('single uses one F1 read and ignores stored runtime/model overrides; unreadable F1 never defaults', t => {
  let reads = 0;
  const { store: s, db } = peerFixture(t, { readConfig: () => { reads++; return { state: 'ok', config: { runtime: 'claude' } }; } });
  s.setSessionRuntimeConfig({ sessionGroup: group, runtime: 'codex' }); s.setSessionModelConfig(pair('codex', 'm', 'high'));
  assert.deepEqual(s.resolveSessionLaunchConfig({ sessionMode: 'single' }), { runtime: 'claude', mode: 'default' }); assert.equal(reads, 1);
  for (const result of [{ state: 'error', error: new Error('bad') }, ...[null, [], { runtime: 'unknown' }, { session_mode: 'broken' }].map(config => ({ state: 'ok', config }))]) {
    const bad = createStore(db, { readConfig: () => result });
    assert.throws(() => bad.resolveSessionLaunchConfig({ sessionMode: 'single' }), { code: 'CONFIG_UNREADABLE' });
  }
});
