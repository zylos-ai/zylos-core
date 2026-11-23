import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture, deferred, flush } from './helpers/router-fixture.js';

async function pump(f, count = 4) { for (let i = 0; i < count; i++) { f.router.tick(); await flush(); } }
const calls = (f, kind) => f.calls.filter(row => row[0] === kind);

test('same runtime single-flight, independent runtime advances, U suppresses current round only', async t => {
  const f = routerFixture(t, { poolSize: 4 });
  f.health.set('claude', { health: 'unavailable' }); f.health.set('codex', { health: 'rate_limited' });
  f.add('a'); f.add('b'); f.add('c');
  const resolve = f.db.resolveSessionLaunchConfig;
  f.db.resolveSessionLaunchConfig = input => input.sessionGroup === 'c' ? { runtime: 'codex', mode: 'default' } : resolve(input);
  const hold = deferred(); const submitted = [];
  f.deps.submit = async request => { submitted.push(request); if (request.runtime === 'claude') return hold.promise;
    return { kind: 'rejected', sent: true, reply: { ...request, ok: false, code: 'probe_inflight' } }; };
  const router = f.create(); await router.initialize(); await pump(f);
  assert.equal(submitted.filter(x => x.runtime === 'claude').length, 1);
  assert.ok(submitted.some(x => x.runtime === 'codex'));
  assert.equal(calls(f,'launch').length, 0);
  hold.resolve({ kind: 'timeout', sent: true }); await router.idle();
  const old = submitted[0]; await f.rounds(1);
  const next = submitted.filter(x => x.runtime === 'claude')[1];
  assert.ok(next); assert.notEqual(next.requestId, old.requestId); assert.notEqual(next.runId, old.runId);
  assert.equal(calls(f,'launch').length, 0);
});

test('missing/unreadable health fail open, auth blocks, existing runtime avoids registration', async t => {
  for (const state of ['missing','unreadable','auth_failed','ok','scene']) {
    await t.test(state, async t => {
      const f = routerFixture(t); f.put('origin', { runtime: state === 'scene' ? 'claude' : 'codex' }); const row = f.add('a');
      f.health.set('claude', ['missing','unreadable'].includes(state) ? { [state]: true } : { health: state === 'scene' ? 'down' : state });
      const router = f.create(); await router.initialize(); await f.rounds(5);
      assert.equal(calls(f,'submit').length, 0);
      assert.equal(calls(f,'launch').length, state === 'auth_failed' ? 0 : 1);
      assert.equal(f.row(row.id).status, state === 'auth_failed' ? 'pending' : 'delivered');
    });
  }
});

// Timeout reads readiness once; adapter.stop success authorizes release.
for (const ready of [false, true]) {
  test(`timeout observes readiness and uses the adapter stop result; READY=${ready}`, async t => {
    const f = routerFixture(t, { poolSize: 1 }); f.put('origin');
    const row = f.add('a'), launch = deferred();
    const adapter = f.deps.session;
    f.deps.session = { ...adapter, launch: async input => {
      f.calls.push(['launch', input]);
      await launch.promise;
      f.put(input.sessionGroup, { ready, runId: input.runId });
    } };
    const router = f.create(); await router.initialize(); await pump(f, 2);
    f.advance(2000);
    const read = f.deps.readLiveIdentity; let reads = 0;
    f.deps.readLiveIdentity = async group => { if (group === 'a') reads++; return read(group); };
    launch.resolve(); await router.idle();
    assert.equal(reads, 1);
    assert.equal(calls(f, 'stop').length, ready ? 0 : 1);
    assert.equal(f.row(row.id).retry_count, ready ? 0 : 1);
    assert.equal(router.state.activations.has('a'), ready);
  });
}
