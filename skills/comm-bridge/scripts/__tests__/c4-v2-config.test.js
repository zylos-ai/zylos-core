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
