import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './c4-v2-test-helpers.js';

// Cutover used to manufacture a global memory boundary. Native switches now
// leave all coverage and queued work unchanged, even after deleted tails.
test('cutover leaves coverage unchanged with a deleted tail', t=>{
  const {db,store}=fixture(t);
  store.insertConversation('out','dashboard','origin','retained');
  const last=store.insertConversation('out','dashboard','topic','synchronized');
  store.createCheckpoint('*',last.id,'existing memory');
  db.prepare('DELETE FROM conversations WHERE id>=?').run(last.id);
  const {runId}=store.beginModeTransition('multi','single'); store.setDrainFence('*');
  const before=Object.fromEntries(['checkpoints','conversations','origin_sync_cursors'].map(name=>[name,db.prepare(`SELECT * FROM ${name}`).all()]));
  store.setModeTransitionPhase(runId,'cutover'); store.setModeTransitionPhase(runId,'cutover');
  assert.equal(store.getModeTransition().cutoff,null);
  assert.deepEqual(Object.fromEntries(Object.keys(before).map(name=>[name,db.prepare(`SELECT * FROM ${name}`).all()])),before);
  store.setModeTransitionPhase(runId,'complete'); assert.equal(store.getDrainFence('*'),null);
  assert.equal(store.getGlobalCoverageEnd(),last.id);
});
