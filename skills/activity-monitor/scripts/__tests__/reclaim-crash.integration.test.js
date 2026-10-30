import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { fixture, launch } from './fixtures/manual-restart-harness.js';

async function waiting(t, variant = '') {
  const f = fixture(t), db = createStore(f.db, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  f.db.exec("INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group) VALUES('in','fixture','origin','inflight','running','origin')");
  db.setDrainFence('origin', { reason: 'upgrade', runId: 'run-1' });
  const first = launch(t, f, 'waiting');
  assert.deepEqual(await first.next(), { barrier: 'waiting_inflight', count: 1 });
  await first.kill();
  assert.equal(db.getDrainFence('origin').runId, 'run-1');
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=zylos-group-origin'));
  const second = launch(t, f, variant), initial = await second.next();
  assert.equal(initial.ready, true); assert.equal(initial.running, 1);
  assert.equal(initial.fences.length, 1, 'inflight restart must preserve D8'); assert.equal(initial.fences[0].reason, 'upgrade');
  assert.equal(initial.scene.present, true); assert.deepEqual(initial.stopped, []);
  f.db.exec("UPDATE conversations SET status='delivered' WHERE content='inflight'");
  const final = await second.command('tick');
  assert.equal(final.running, 0); assert.deepEqual(final.fences, []); assert.equal(final.scene.present, false);
  assert.equal(final.stopped.length, 1); assert.equal(final.stopped[0].runId, 'run-1');
  assert.equal(f.db.prepare("SELECT status FROM conversations WHERE content='inflight'").pluck().get(), 'delivered');
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper')); await second.stop();
}
test('[a] SIGKILL real supervisor while waiting for actual SQLite inflight delivery resumes same row and withdraws gate only after accounting', { timeout: 25000 }, async t => waiting(t));
test('clearing on supervisor restart fails the retained-wait assertion', { timeout: 25000 }, async t => assert.rejects(waiting(t, 'clear-all'), { code: 'ERR_ASSERTION', message: /inflight restart must preserve D8/ }));

async function manualRetained(t, variant = '') {
  const f = fixture(t), db = createStore(f.db, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  db.setDrainFence('origin', { reason: 'manual_restart', runId: 'run-1' });
  const before = db.getDrainFence('origin');
  const first = launch(t, f); assert.equal((await first.next()).ready, true); await first.kill();
  const second = launch(t, f, variant), initial = await second.next(); assert.equal(initial.ready, true);
  assert.deepEqual(db.getDrainFence('origin'), before, 'manual fence must survive restart');
  for (let n = 0; n < 2; n++) {
    const state = await second.command('tick');
    assert.deepEqual(db.getDrainFence('origin'), before, 'manual fence must survive restart'); assert.deepEqual(state.stopped, []); assert.equal(state.scene.present, true);
  }
  await second.stop();
}
test('SIGKILL real supervisor retains manual_restart row and never lets generic reclaim clear or stop it', { timeout: 25000 }, async t => manualRetained(t));
test('generic reclaim clearing a manual row is detected after actual supervisor restart', { timeout: 25000 }, async t => assert.rejects(manualRetained(t, 'clear-manual'), { code: 'ERR_ASSERTION', message: /manual fence must survive restart/ }));
