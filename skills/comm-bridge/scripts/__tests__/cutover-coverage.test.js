import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './c4-v2-test-helpers.js';

function begin(store) {
  const { runId } = store.beginModeTransition('multi', 'single');
  store.setDrainFence('*');
  store.absorbForTransition(runId);
  return runId;
}

for (const tail of ['deleted', 'equal', 'empty']) test(`cutover skips an already covered ${tail} tail without changing coverage`, t => {
  const { db, store } = fixture(t);
  const first = store.insertConversation('out', 'dashboard', 'origin', 'retained');
  const last = store.insertConversation('out', 'dashboard', 'topic', 'already synchronized');
  store.createCheckpoint('*', last.id, 'existing memory');
  if (tail !== 'equal') db.prepare('DELETE FROM conversations WHERE id>=?').run(tail === 'empty' ? first.id : last.id);
  const runId = begin(store), frozen = store.getModeTransition();
  const before = db.prepare('SELECT * FROM checkpoints ORDER BY id').all();
  const result = store.setModeTransitionPhase(runId, 'cutover');
  assert.deepEqual(result.cutoverCoverage, { cutoff: frozen.cutoff, covered: last.id });
  assert.equal(result.phase, 'cutover');
  assert.equal(result.cutoff, tail === 'equal' ? last.id : tail === 'empty' ? 0 : first.id);
  assert.equal(store.getModeTransition().cutoverCoverage, undefined, 'diagnostic metadata is transient');
  store.setModeTransitionPhase(runId, 'cutover');
  assert.deepEqual(db.prepare('SELECT * FROM checkpoints ORDER BY id').all(), before);
  assert.equal(store.getGlobalCoverageEnd(), last.id);
  store.setModeTransitionPhase(runId, 'complete');
  assert.equal(store.getDrainFence('*'), null);
  const fresh = store.insertConversation('out', 'dashboard', 'origin', 'new unsynchronized memory');
  assert.ok(fresh.id > last.id);
  const unread = store.getGlobalUnsummarizedConversations({ upToConversationId: fresh.id });
  assert.deepEqual(unread.map(row => row.id), [fresh.id]);
});

test('covered cutover refuses any surviving conversation status in the interval and rolls back', t => {
  const { db, store } = fixture(t);
  const first = store.insertConversation('out', 'dashboard', 'origin', 'cutoff');
  const runId = begin(store);
  const late = store.insertConversation('out', 'dashboard', 'topic', 'later synchronized');
  store.createCheckpoint('*', late.id, 'memory');
  const checkpointCount = db.prepare('SELECT count(*) AS n FROM checkpoints').get().n;
  for (const status of ['delivered', 'pending', 'failed', 'switch_absorbed']) {
    db.prepare('UPDATE conversations SET status=? WHERE id=?').run(status, late.id);
    assert.throws(() => store.setModeTransitionPhase(runId, 'cutover'), {
      code: 'CUTOVER_COVERAGE_CONFLICT', cutoff: first.id, covered: late.id, persisted: [],
    });
    assert.equal(store.getModeTransition().phase, 'converting');
    assert.ok(store.getDrainFence('*'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM checkpoints').get().n, checkpointCount);
  }
});

test('covered cutover transaction failure preserves converting and emits no committed metadata', t => {
  const { db, store } = fixture(t);
  const row = store.insertConversation('out', 'dashboard', 'origin', 'synchronized');
  store.createCheckpoint('*', row.id, 'memory');
  const runId = begin(store);
  const checkpointCount = db.prepare('SELECT count(*) AS n FROM checkpoints').get().n;
  db.exec("CREATE TRIGGER reject_cutover BEFORE UPDATE ON mode_transitions WHEN NEW.phase='cutover' BEGIN SELECT RAISE(ABORT,'reject phase'); END");
  assert.throws(() => store.setModeTransitionPhase(runId, 'cutover'), { code: 'DB_WRITE_FAILED' });
  assert.equal(store.getModeTransition().phase, 'converting');
  assert.ok(store.getDrainFence('*'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM checkpoints').get().n, checkpointCount);
});
