import { fixture as storeFixture } from './c4-v2-test-helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
function fixture(t, filename = ':memory:') {
  const { db, store } = storeFixture(t, {}, filename);
  const state = () => ({ transitions: db.prepare('SELECT * FROM mode_transitions ORDER BY rowid').all(), messages: db.prepare('SELECT * FROM conversations ORDER BY id').all(), checkpoints: db.prepare('SELECT * FROM checkpoints ORDER BY id').all(), fences: db.prepare('SELECT * FROM drain_fences ORDER BY session_group').all() });
  return { db, store, state };
}
test('begin enforces one open transition and all forbidden phase edges reject', t => {
  const { db, store, state } = fixture(t);
  assert.throws(() => store.beginModeTransition('single', 'single'), { code: 'TRANSITION_SAME_MODE' });
  const { runId } = store.beginModeTransition('single', 'multi'); const initial = state();
  assert.throws(() => store.beginModeTransition('multi', 'single'), { code: 'TRANSITION_OPEN' }); assert.deepEqual(state(), initial);
  assert.throws(() => db.prepare("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES('other','single','multi','gating',1,1)").run(), /UNIQUE/);
  for (const phase of ['converting', 'complete', 'invalid']) { assert.throws(() => store.setModeTransitionPhase(runId, phase), { code: 'PHASE_TRANSITION_INVALID' }); assert.deepEqual(state(), initial); }
  store.setDrainFence('*');
  store.setModeTransitionPhase(runId, 'cutover');
  for (const phase of ['gating', 'converting']) assert.throws(() => store.setModeTransitionPhase(runId, phase), { code: 'PHASE_TRANSITION_INVALID' });
  store.setModeTransitionPhase(runId, 'complete');
  for (const phase of ['gating', 'converting', 'cutover']) assert.throws(() => store.setModeTransitionPhase(runId, phase), { code: 'PHASE_TRANSITION_INVALID' });
});
test('cutover never writes a global checkpoint, including historical multi-source conversion rows', t => {
  const { db, store } = fixture(t);
  const message = store.insertConversation('in', 'foo', 'e', 'pending');
  const runId = randomUUID();
  db.prepare("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,cutoff,coverage_snapshot,absorbed_ids,created_at,updated_at) VALUES(?,'multi','single','converting',?,'{}',?,1,1)").run(runId, message.id, JSON.stringify([message.id]));
  db.prepare("UPDATE conversations SET status='switch_absorbed' WHERE id=?").run(message.id);
  store.setDrainFence('*');
  const before = db.prepare('SELECT * FROM checkpoints').all();
  store.setModeTransitionPhase(runId, 'cutover');
  store.setModeTransitionPhase(runId, 'cutover', { reason: 'retry' });
  assert.deepEqual(db.prepare('SELECT * FROM checkpoints').all(), before);
});
for (const obstacle of ['extra-fence', 'manual-global', 'phase-write-fails', 'none']) test(`complete and fence removal are atomic with ${obstacle}`, t => {
  const { db, store, state } = fixture(t); store.insertConversation('in', 'foo', 'e', 'pending'); const { runId } = store.beginModeTransition('single', 'multi'); store.setDrainFence('*'); store.setModeTransitionPhase(runId, 'cutover');
  if (obstacle === 'extra-fence') store.setDrainFence('foo', { reason: 'ttl', runId: 'old' });
  if (obstacle === 'manual-global') db.prepare("UPDATE drain_fences SET reason='manual_restart',run_id='other' WHERE session_group='*'").run();
  if (obstacle === 'phase-write-fails') db.exec("CREATE TRIGGER reject_complete BEFORE UPDATE ON mode_transitions WHEN NEW.phase='complete' BEGIN SELECT RAISE(ABORT,'reject complete'); END");
  const before = state();
  if (obstacle === 'none') { store.setModeTransitionPhase(runId, 'complete'); assert.equal(store.getDrainFence('*'), null); assert.equal(store.getModeTransition({ runId }).phase, 'complete'); }
  else { assert.throws(() => store.setModeTransitionPhase(runId, 'complete'), { code: obstacle === 'phase-write-fails' ? 'DB_WRITE_FAILED' : 'TRANSITION_PRECONDITION' }); assert.deepEqual(state(), before); }
});
// Snapshot every table independently; total_changes also detects writes later undone.
