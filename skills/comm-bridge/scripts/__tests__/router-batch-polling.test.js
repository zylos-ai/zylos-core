import test from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture } from './helpers/router-fixture.js';

// Boundary: listing failure retains known delivery identities but grants no new
// capacity. Real router/SQLite; tmux and delivery transports are injected. Run
// after scene error handling changes; unrelated UI may skip. The official runner
// isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and the fixture closes its DB/router.
test('a failed session listing preserves cached delivery and blocks new activation', async t => {
  const f = routerFixture(t); f.put('origin'); f.put('a');
  const router = f.create(); await router.initialize(); await router.idle();
  const cached = router.state.live.get('a');
  let batches = 0;
  f.deps.listGroupTmuxSessions = async () => { throw new Error('listing unavailable'); };
  f.deps.readLiveIdentities = async () => { batches++; throw new Error('batch must not run after listing failure'); };
  const existing = f.add('a'), unseen = f.add('new-group');
  await f.rounds(3);
  assert.equal(router.state.live.get('a'), cached);
  assert.equal(router.state.sceneObservable, false);
  assert.equal(router.availableCapacity(), 0);
  assert.equal(batches, 0);
  assert.equal(f.row(existing.id).status, 'delivered');
  assert.equal(f.row(unseen.id).status, 'pending');
  assert.equal(f.calls.filter(row => row[0] === 'launch').length, 0);
  assert.ok(f.events.some(row => row.event === 'scene_unobservable'));
});
