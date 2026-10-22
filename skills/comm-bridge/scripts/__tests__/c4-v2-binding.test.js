import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
import { normalizeTargetBinding } from '../c4-target-binding.js';
const binding = { expectedRunId: 'run-1', tmuxTarget: { serverGeneration: '48213:1791990000', sessionId: '$3', paneId: '%7' }, expectedSessionId: 'session-1' };
function fixture(t, dependencies = {}) {
  const db = new Database(':memory:'); guardDatabase(db, owner); t.after(() => db.close());
  const s = createStore(db, { validateComponent: () => true, readConfig: () => ({ state: 'ok', config: { session_mode: 'multi' } }), ...dependencies });
  return { db, s };
}
const options = { sessionGroup: 'origin', expectedRunId: 'run-1', expectedRuntime: 'claude', expectedSessionId: 'session-1' };
const target = () => ({ runId: 'run-1', runtime: 'claude', sessionGroup: 'origin', currentSession: { runId: 'run-1', sessionId: 'session-1' }, tmuxTarget: binding.tmuxTarget });

test('private resolver validates ordered identity failures without writing controls', t => {
  const cases = [
    { target: null, code: 'TARGET_NOT_RUNNING' },
    { patch: { runId: 'run-2', runtime: 'unknown', sessionGroup: 'wrong', currentSession: null }, code: 'TARGET_MISMATCH' },
    { patch: { runtime: 'unknown', sessionGroup: 'wrong', currentSession: null }, code: 'TARGET_SNAPSHOT_UNKNOWN' },
    { patch: { runtime: 'codex', sessionGroup: 'wrong', currentSession: null }, code: 'TARGET_RUNTIME_MISMATCH' },
    { patch: { sessionGroup: 'wrong', currentSession: null }, code: 'TARGET_SCOPE_MISMATCH' },
    { patch: { currentSession: { runId: 'run-2', sessionId: 'wrong' } }, code: 'TARGET_NOT_READY' },
    { patch: { currentSession: { runId: 'run-1', sessionId: 'wrong' } }, code: 'STALE_TARGET' },
  ];
  for (const sample of cases) {
    let calls = 0;
    const { db, s } = fixture(t, { resolveTarget: input => { calls++; assert.deepEqual(input, { sessionGroup: 'origin', sessionMode: 'multi' }); return 'target' in sample ? sample.target : { ...target(), ...sample.patch }; } });
    assert.throws(() => s.buildTargetBinding(options), error => { assert.equal(error.code, sample.code); assert.deepEqual(error.persisted, []); if (sample.code === 'TARGET_MISMATCH') assert.equal(error.runId, 'run-2'); return true; });
    assert.equal(calls, 1); assert.equal(db.prepare('SELECT count(*) FROM control_queue').pluck().get(), 0);
  }
});

test('scope and transition checks happen before private resolver; caller cannot supply tmux', t => {
  let calls = 0;
  const { db, s } = fixture(t, { resolveTarget: () => { calls++; return target(); } });
  for (const [input, code] of [
    [{ ...options, tmuxTarget: binding.tmuxTarget }, 'INVALID_ARGS'],
    [{ ...options, sessionGroup: null }, 'CONTROL_TARGET_REQUIRED'],
    [{ ...options, sessionGroup: '*' }, 'SESSION_GROUP_INVALID'],
    [{ ...options, sessionGroup: 'unknown' }, 'SESSION_GROUP_NOT_FOUND'],
  ]) assert.throws(() => s.buildTargetBinding(input), { code });
  db.exec("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES('transition','single','multi','gating',0,0)");
  assert.throws(() => s.buildTargetBinding(options), { code: 'TRANSITION_OPEN' });
  assert.equal(calls, 0);
  const single = fixture(t, { readConfig: () => ({ state: 'ok', config: { session_mode: 'single' } }), resolveTarget: () => { calls++; return target(); } }).s;
  assert.throws(() => single.buildTargetBinding(options), { code: 'TARGET_SCOPE_MISMATCH' });
  assert.equal(calls, 0);
});

test('successful private snapshot builds canonical binding; insertion is separate', t => {
  const { db, s } = fixture(t, { resolveTarget: () => target() });
  const canonical = s.buildTargetBinding(options);
  assert.equal(canonical, JSON.stringify(binding));
  assert.equal(db.prepare('SELECT count(*) FROM control_queue').pluck().get(), 0);
  const row = s.insertControl('probe', { sessionGroup: 'origin', targetBinding: canonical, appendAckSuffix: false });
  assert.equal(row.target_binding, canonical);
});

test('malformed and unknown binding fields reject before superseding pending rows', t => {
  const { db, s } = fixture(t);
  const enqueue = value => s.insertControl('probe', { sessionGroup: 'origin', targetBinding: value, appendAckSuffix: false });
  const first = enqueue(binding);
  for (const bad of ['{', [], {}, { ...binding, extra: true }, { ...binding, expectedRunId: undefined }, { ...binding, expectedSessionId: '' }, { ...binding, tmuxTarget: { ...binding.tmuxTarget, extra: true } }, { ...binding, tmuxTarget: { ...binding.tmuxTarget, sessionId: '3' } }, { ...binding, tmuxTarget: { ...binding.tmuxTarget, paneId: 7 } }, { ...binding, tmuxTarget: { ...binding.tmuxTarget, serverGeneration: '' } }]) {
    assert.throws(() => enqueue(bad), { code: 'TARGET_BINDING_INVALID' });
    assert.deepEqual(db.prepare('SELECT id,status FROM control_queue').all(), [{ id: first.id, status: 'pending' }]);
  }
});

test('reordered JSON normalizes identically and supersedes; changed server generation does not', t => {
  const { db, s } = fixture(t);
  const enqueue = value => s.insertControl('probe', { sessionGroup: 'origin', targetBinding: value, appendAckSuffix: false });
  const a = enqueue(binding);
  const reordered = JSON.stringify({ expectedSessionId: 'session-1', tmuxTarget: { paneId: '%7', sessionId: '$3', serverGeneration: '48213:1791990000' }, expectedRunId: 'run-1' });
  assert.equal(normalizeTargetBinding(reordered), JSON.stringify(binding));
  const b = enqueue(reordered); assert.equal(b.superseded_count, 1); assert.equal(a.target_binding, b.target_binding);
  const c = enqueue({ ...binding, tmuxTarget: { ...binding.tmuxTarget, serverGeneration: '48213:1791990001' } });
  assert.equal(c.superseded_count, 0);
  assert.deepEqual(db.prepare('SELECT id,status FROM control_queue ORDER BY id').all(), [{ id: a.id, status: 'superseded' }, { id: b.id, status: 'pending' }, { id: c.id, status: 'pending' }]);
});
