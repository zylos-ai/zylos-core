import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './c4-v2-test-helpers.js';
import { normalizeTargetBinding } from '../c4-target-binding.js';
const binding = { expectedRunId: 'run-1', tmuxTarget: { serverGeneration: '48213:1791990000', sessionId: '$3', paneId: '%7' }, expectedSessionId: 'session-1' };
const options = { sessionGroup: 'origin', expectedRunId: 'run-1', expectedRuntime: 'claude', expectedSessionId: 'session-1' };
const target = () => ({ runId: 'run-1', runtime: 'claude', sessionGroup: 'origin', currentSession: { runId: 'run-1', sessionId: 'session-1' }, tmuxTarget: binding.tmuxTarget });

test('successful private snapshot builds canonical binding; insertion is separate', async t => {
  let calls = 0;
  const { db, store: s } = fixture(t, { resolveTarget: async () => {
    calls++;
    assert.equal(db.inTransaction, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(db.inTransaction, false);
    return target();
  } });
  const canonical = await s.buildTargetBinding(options);
  assert.equal(calls, 1);
  assert.equal(canonical, JSON.stringify(binding));
  assert.equal(db.prepare('SELECT count(*) FROM control_queue').pluck().get(), 0);
  const row = s.insertControl('probe', { sessionGroup: 'origin', targetBinding: canonical, appendAckSuffix: false });
  assert.equal(row.target_binding, canonical);
});

test('reordered JSON normalizes identically and supersedes; changed server generation does not', t => {
  const { db, store: s } = fixture(t);
  const enqueue = value => s.insertControl('probe', { sessionGroup: 'origin', targetBinding: value, appendAckSuffix: false });
  const a = enqueue(binding);
  const reordered = JSON.stringify({ expectedSessionId: 'session-1', tmuxTarget: { paneId: '%7', sessionId: '$3', serverGeneration: '48213:1791990000' }, expectedRunId: 'run-1' });
  assert.equal(normalizeTargetBinding(reordered), JSON.stringify(binding));
  const b = enqueue(reordered); assert.equal(b.superseded_count, 1); assert.equal(a.target_binding, b.target_binding);
  const c = enqueue({ ...binding, tmuxTarget: { ...binding.tmuxTarget, serverGeneration: '48213:1791990001' } });
  assert.equal(c.superseded_count, 0);
  assert.deepEqual(db.prepare('SELECT id,status FROM control_queue ORDER BY id').all(), [{ id: a.id, status: 'superseded' }, { id: b.id, status: 'pending' }, { id: c.id, status: 'pending' }]);
});
