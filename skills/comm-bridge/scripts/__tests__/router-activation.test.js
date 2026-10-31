import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture, deferred, flush } from './helpers/router-fixture.js';
import { validStartAttemptReply } from '../router/activation.js';

async function pump(f, count = 4) { for (let i = 0; i < count; i++) { f.router.tick(); await flush(); } }
const calls = (f, kind) => f.calls.filter(row => row[0] === kind);

test('restricted admission precedes claim and preserves one launchConfig/runId', async t => {
  const f = routerFixture(t); f.put('origin', { runtime: 'codex' }); const row = f.add('a');
  f.health.set('claude', { health: 'unavailable' });
  const submit = f.deps.submit;
  f.deps.submit = request => { assert.equal(f.row(row.id).status, 'pending'); assert.equal(f.router.availableCapacity(), 2); return submit(request); };
  const router = f.create(); await router.initialize(); await f.rounds(5);
  assert.equal(calls(f,'submit').length, 1); assert.equal(calls(f,'launch').length, 1);
  assert.equal(calls(f,'launch')[0][1].runId, calls(f,'submit')[0][1].runId);
  assert.equal(f.row(row.id).status, 'delivered'); assert.equal(f.row(row.id).session_id, 'session-a');
});

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

test('admission reply is discarded if candidate, capacity or scene changed', async t => {
  for (const change of ['fence','capacity','scene','candidate']) {
    await t.test(change, async t => {
      const f = routerFixture(t, { poolSize: 1 }); f.put('origin', { runtime: 'codex' }); const row = f.add('a');
      f.health.set('claude', { health: 'recovering' }); const hold = deferred(); let request;
      f.deps.submit = async value => { request = value; return hold.promise; };
      const router = f.create(); await router.initialize(); await pump(f, 2); assert.ok(request);
      if (change === 'fence') f.db.setDrainFence('a', { reason: 'ttl', runId: 'other' });
      if (change === 'capacity') { f.put('b'); await pump(f, 2); }
      if (change === 'scene') f.put('a');
      if (change === 'candidate') f.db.claimConversation(row.id);
      hold.resolve({ kind: 'accepted', sent: true, reply: { ...request, ok: true, result: 'not_restricted' } });
      await router.idle(); assert.equal(calls(f,'launch').length, 0);
      assert.equal(f.row(row.id).status, change === 'candidate' ? 'running' : 'pending');
    });
  }
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

test('late launch and unconfirmed stop retain running row and capacity', async t => {
  const f = routerFixture(t, { poolSize: 1 }); f.put('origin'); const a = f.add('a'), b = f.add('b');
  const hold = deferred(); let stopConfirmed = false;
  f.deps.getSessionAdapter = () => ({ launch: async input => { f.calls.push(['launch', input]); await hold.promise;
    f.put(input.sessionGroup, { ready: false, runId: input.runId }); },
    stop: async input => { f.calls.push(['stop', input]); if (!stopConfirmed) throw Object.assign(Error('unknown'), { code: 'STOP_UNCONFIRMED' }); f.scene.delete('a'); } });
  const router = f.create(); await router.initialize(); await pump(f, 2);
  assert.equal(f.row(a.id).status, 'running'); assert.equal(f.row(b.id).status, 'pending');
  f.advance(2000); await pump(f, 2);
  assert.equal(calls(f,'stop').length, 0); assert.equal(router.availableCapacity(), 0);
  hold.resolve(); await router.idle();
  assert.equal(f.row(a.id).status, 'running'); assert.equal(router.availableCapacity(), 0);
  stopConfirmed = true; await f.rounds(1);
  assert.equal(f.row(a.id).status, 'pending'); assert.equal(f.row(a.id).retry_count, 1);
});

test('NAME_CONFLICT requeues without retry and startup control invalidation precedes launch', async t => {
  const f = routerFixture(t); f.put('origin'); const row = f.add('a');
  const control = f.db.insertControl('old', { sessionGroup: 'a', appendAckSuffix: false });
  f.deps.getSessionAdapter = () => ({ launch: async () => {
    assert.equal(f.db.getControlById(control.id).last_error, 'SESSION_ENDED');
    throw Object.assign(Error('exists'), { code: 'NAME_CONFLICT' }); }, stop: async () => assert.fail('no stop on name conflict') });
  const router = f.create(); await router.initialize(); await f.rounds(2);
  assert.equal(f.row(row.id).status, 'pending'); assert.equal(f.row(row.id).retry_count, 0);
  assert.ok(f.events.some(x => x.event === 'launch_name_conflict'));
});

test('branch validation rejects missing, forbidden, wrong units and mismatched identity', () => {
  const request = { version: 1, type: 'start_attempt', requestId: 'sa-test' };
  const valid = { ...request, ok: true, result: 'registered', reason: 'recovery_due' };
  assert.ok(validStartAttemptReply({ ...valid, future: true }, request));
  for (const patch of [{ version: 2 }, { type: 'wrong' }, { requestId: 'old' }, { ok: 1 }, { result: 'new' },
    { reason: 'other' }, { code: 'bad' }, { notBefore: 1800000000000 }]) {
    assert.equal(validStartAttemptReply({ ...valid, ...patch }, request), false, JSON.stringify(patch));
  }
  assert.equal(validStartAttemptReply({ ...request, ok: false, code: 'attempt_backoff', notBefore: 1800000000 }, request), false);
  assert.equal(validStartAttemptReply({ ...request, ok: false, code: 'probe_inflight', notBefore: 1800000000000 }, request), false);
  const { reason, ...missingReason } = valid;
  assert.equal(validStartAttemptReply(missingReason, request), false);
  assert.equal(validStartAttemptReply({ ...request, ok: true, result: 'not_restricted', reason }, request), false);
  for (const extra of [{ attemptAt: 1800000000000 }, { attemptAt: null }, { attemptCount: '1' }]) {
    assert.ok(validStartAttemptReply({ ...valid, ...extra }, request));
    assert.ok(validStartAttemptReply({ ...request, ok: true, result: 'not_restricted', ...extra }, request));
    assert.ok(validStartAttemptReply({ ...request, ok: false, code: 'probe_inflight', ...extra }, request));
  }
});

test('timeout observation failures alert and retain the running row and reservation', async t => {
  const f = routerFixture(t, { poolSize: 1 }); f.put('origin');
  const a = f.add('a'), b = f.add('b');
  const adapter = f.deps.getSessionAdapter;
  f.deps.getSessionAdapter = runtime => ({ ...adapter(runtime), launch: async input => {
    f.calls.push(['launch', input]); f.put(input.sessionGroup, { ready: false, runId: input.runId });
  } });
  const router = f.create(); await router.initialize(); await f.rounds(2);
  assert.equal(f.row(a.id).status, 'running');
  const activation = router.state.activations.get('a');
  const read = f.deps.readLiveIdentity; let reads = 0;
  f.deps.readLiveIdentity = async group => {
    if (group === 'a' && ++reads === 1) throw Object.assign(Error('unobservable'), { code: 'TMUX_UNAVAILABLE' });
    return read(group);
  };
  f.advance(1000); await router.state.lanes.get('a').kick();
  assert.equal(reads, 1);
  assert.equal(calls(f, 'stop').length, 0);
  assert.equal(f.row(a.id).status, 'running'); assert.equal(f.row(a.id).retry_count, 0);
  assert.equal(f.row(b.id).status, 'pending');
  assert.equal(router.state.activations.get('a'), activation); assert.equal(router.availableCapacity(), 0);
  assert.ok(f.events.some(x => x.event === 'stop_unconfirmed' && x.session_group === 'a' && x.reason === 'TMUX_UNAVAILABLE'));
  assert.ok(calls(f, 'alert').some(x => x[1] === 'stop_unconfirmed' && x[2].runId === activation.runId));
  f.deps.readLiveIdentity = read;
  await router.state.lanes.get('a').kick();
  assert.equal(calls(f, 'stop').length, 1);
  assert.equal(f.row(a.id).status, 'pending'); assert.equal(f.row(a.id).retry_count, 1);
  assert.equal(router.state.activations.has('a'), false);
});

// / the one fresh post-launch read decides timeout convergence.
for (const ready of [false, true]) {
  test(`timeout takes one fresh observation; READY=${ready}`, async t => {
    const f = routerFixture(t, { poolSize: 1 }); f.put('origin');
    const row = f.add('a'), launch = deferred();
    const adapter = f.deps.getSessionAdapter;
    f.deps.getSessionAdapter = runtime => ({ ...adapter(runtime), launch: async input => {
      f.calls.push(['launch', input]);
      await launch.promise;
      f.put(input.sessionGroup, { ready, runId: input.runId });
    } });
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
