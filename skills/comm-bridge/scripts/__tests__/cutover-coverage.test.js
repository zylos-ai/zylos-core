import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './c4-v2-test-helpers.js';

// Cutover used to manufacture a global memory boundary. Native switches now
// leave all coverage and queued work unchanged, even after deleted tails.
for (const tail of ['deleted','equal','empty','live-above-cutoff']) test(`cutover leaves coverage unchanged with ${tail} tail`, t=>{
  const {db,store}=fixture(t);
  const first=store.insertConversation('out','dashboard','origin','retained');
  const last=store.insertConversation('out','dashboard','topic','synchronized');
  store.createCheckpoint('*',last.id,'existing memory');
  if(tail==='deleted'||tail==='empty') db.prepare('DELETE FROM conversations WHERE id>=?').run(tail==='empty'?first.id:last.id);
  const {runId}=store.beginModeTransition('multi','single'); store.setDrainFence('*');
  if(tail==='live-above-cutoff') store.insertConversation('in','dashboard','topic','pending');
  const before=Object.fromEntries(['checkpoints','conversations','origin_sync_cursors'].map(name=>[name,db.prepare(`SELECT * FROM ${name}`).all()]));
  store.setModeTransitionPhase(runId,'cutover'); store.setModeTransitionPhase(runId,'cutover');
  assert.equal(store.getModeTransition().cutoff,null);
  assert.deepEqual(Object.fromEntries(Object.keys(before).map(name=>[name,db.prepare(`SELECT * FROM ${name}`).all()])),before);
  store.setModeTransitionPhase(runId,'complete'); assert.equal(store.getDrainFence('*'),null);
  assert.equal(store.getGlobalCoverageEnd(),last.id);
});
test('failed cutover phase write leaves gating and the transition fence intact',t=>{
  const {db,store}=fixture(t);const {runId}=store.beginModeTransition('multi','single');store.setDrainFence('*');
  const before=db.prepare('SELECT * FROM checkpoints').all();
  db.exec("CREATE TRIGGER reject_cutover BEFORE UPDATE ON mode_transitions WHEN NEW.phase='cutover' BEGIN SELECT RAISE(ABORT,'reject phase'); END");
  assert.throws(()=>store.setModeTransitionPhase(runId,'cutover'),{code:'DB_WRITE_FAILED'});
  assert.equal(store.getModeTransition().phase,'gating');assert.ok(store.getDrainFence('*'));
  assert.deepEqual(db.prepare('SELECT * FROM checkpoints').all(),before);
});
