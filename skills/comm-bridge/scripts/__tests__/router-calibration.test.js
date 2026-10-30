import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture } from './helpers/router-fixture.js';
import { createActivationManager } from '../router/activation.js';

test('U prevents a later candidate of the same runtime submitting in the same round', async t => {
  const f = routerFixture(t); const a = f.add('a'), b = f.add('b');
  f.health.set('claude', { health: 'unavailable' }); const submitted = [];
  f.deps.submit = async request => { submitted.push(request); return { kind: 'timeout', sent: true }; };
  const router = f.create();
  const manager = createActivationManager({ deps: f.deps, options: f.options, state: router.state,
    now: f.now, diagnostic: f.deps.diagnostic });
  router.state.mode = 'multi'; router.state.round = 1;
  // Call the production activation manager after the first U has settled;
  // scheduler opportunity bookkeeping must not stand in for runtime admission.
  await manager.begin('a', a); await manager.begin('b', b);
  assert.equal(submitted.length, 1);
  assert.equal(f.row(a.id).status, 'pending'); assert.equal(f.row(b.id).status, 'pending');
  router.state.round++;
  await manager.begin('b', b);
  assert.equal(submitted.length, 2);
  assert.notEqual(submitted[0].requestId, submitted[1].requestId);
  assert.notEqual(submitted[0].runId, submitted[1].runId);
  assert.equal(f.calls.some(x => x[0] === 'launch'), false);
});

test('resident polling rounds without elapsed time cannot consume seconds of backoff', async t => {
  const f = routerFixture(t); const router = f.create(); await router.initialize();
  await f.rounds(20);
  assert.equal(f.calls.some(x => x[0] === 'launch'), false);
  f.advance(5000); await f.rounds(3);
  assert.equal(f.calls.filter(x => x[0] === 'launch').length, 1);
});
