import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture, deferred, flush } from './helpers/router-fixture.js';

const calls = (f, kind) => f.calls.filter(row => row[0] === kind);
const waits = (f, code) => f.events.filter(row => row.event === 'wait_health' && row.session_group === 'origin' && row.code === code);
const originControl = (f, options = {}) => f.db.insertControl('Role instruction', { sessionGroup: 'origin', appendAckSuffix: false, ...options });
const binding = { expectedRunId: 'ended-run', tmuxTarget: { serverGeneration: 'old-server', sessionId: '$1', paneId: '%1' } };
async function startIdle(f) {
  const router = f.create(); await router.initialize(); await f.rounds(2);
  f.advance(65000); await f.rounds(2);
  return router;
}
async function pump(f, count = 4) {
  for (let i = 0; i < count; i++) { f.router.tick(); await flush(); }
}

test('absent multi Origin without demand stays asleep across polling rounds', async t => {
  const f = routerFixture(t); const router = await startIdle(f);
  for (const elapsed of [1000, 60000, 3600000]) { f.advance(elapsed); await f.rounds(3); }
  assert.equal(calls(f, 'launch').length, 0);
  assert.equal(calls(f, 'submit').length, 0);
  assert.equal(router.state.resident.failures, 0);
  assert.equal(f.events.filter(row => row.event === 'start_always').length, 0);
});

test('a bound control cannot wake Origin; an unbound role control wakes it that round', async t => {
  const f = routerFixture(t); await startIdle(f);
  const stale = originControl(f, { targetBinding: binding });
  await f.rounds(4);
  assert.equal(calls(f, 'launch').length, 0);
  assert.equal(f.db.getControlById(stale.id).status, 'pending');
  originControl(f);
  await f.rounds(1);
  assert.equal(calls(f, 'launch').length, 1);
  assert.equal(calls(f, 'launch')[0][1].sessionGroup, 'origin');
});

test('a delayed role control begins creating demand at its Unix-second due time', async t => {
  const f = routerFixture(t); await startIdle(f);
  const due = Math.floor(f.now() / 1000) + 30;
  const row = originControl(f, { availableAt: due });
  await f.rounds(2); assert.equal(calls(f, 'launch').length, 0);
  f.advance(29999); await f.rounds(2); assert.equal(calls(f, 'launch').length, 0);
  f.advance(1); await f.rounds(1);
  assert.equal(calls(f, 'launch').length, 1);
  assert.equal(f.db.getControlById(row.id).status, 'pending');
});

test('expired inbound is settled without waking Origin and fresh inbound stays pending until launch', async t => {
  const f = routerFixture(t); await startIdle(f);
  const expired = f.add('system');
  f.sqlite.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?")
    .run(f.now() / 1000 - 86400, expired.id);
  await f.rounds(2);
  assert.equal(f.row(expired.id).session_group, 'origin');
  assert.equal(f.row(expired.id).delivery_action, 'pending_expired');
  assert.equal(f.row(expired.id).status, 'failed');
  assert.deepEqual(calls(f, 'expired').map(row => row[1]), [expired.id]);
  assert.equal(calls(f, 'launch').length, 0);
  const fresh = f.add('system');
  const adapter = f.deps.getSessionAdapter;
  f.deps.getSessionAdapter = runtime => ({ ...adapter(runtime), launch: async input => {
    assert.equal(f.row(fresh.id).status, 'pending');
    return adapter(runtime).launch(input);
  } });
  await f.rounds(1);
  assert.equal(calls(f, 'launch').length, 1);
  assert.equal(f.row(fresh.id).status, 'pending');
  await f.rounds(3);
  assert.equal(f.row(fresh.id).status, 'delivered');
});

for (const scope of ['origin', '*']) {
  test(`${scope} drain fence prevents a demanded Origin launch`, async t => {
    const f = routerFixture(t); await startIdle(f); originControl(f);
    f.db.setDrainFence(scope, scope === '*' ? {} : { reason: 'ttl', runId: 'old-run' });
    await f.rounds(4);
    assert.equal(calls(f, 'launch').length, 0);
    assert.equal(f.router.state.resident.failures, 0);
  });
}

test('authentication blocks Origin once per wait code and recovery launches next round', async t => {
  const f = routerFixture(t); await startIdle(f); originControl(f);
  f.health.set('claude', { health: 'auth_failed' });
  const absentSince = f.router.state.resident.absentSince;
  await f.rounds(4);
  assert.equal(calls(f, 'launch').length, 0);
  assert.equal(calls(f, 'submit').length, 0);
  assert.equal(waits(f, 'auth_blocked').length, 1);
  assert.equal(f.router.state.resident.failures, 0);
  assert.equal(f.router.state.resident.absentSince, absentSince);
  f.health.set('claude', { health: 'ok' });
  await f.rounds(1);
  assert.equal(calls(f, 'launch').length, 1);
  assert.equal(f.router.state.resident.waitCode, null);
});

for (const health of [{ missing: true }, { unreadable: true }, { health: 'ok' }, { health: 'unavailable' }, { health: 'recovering' }, { health: 'down' }]) {
  const label = health.health ?? Object.keys(health)[0];
  test(`Origin with ${label} runtime health launches without start admission`, async t => {
    const f = routerFixture(t); await startIdle(f); originControl(f);
    f.health.set('claude', health);
    await f.rounds(1);
    assert.equal(calls(f, 'launch').length, 1);
    assert.equal(calls(f, 'submit').length, 0);
  });
}

test('Origin admission reads its configured target runtime', async t => {
  const f = routerFixture(t); await startIdle(f); originControl(f);
  f.db.setSessionRuntimeConfig({ sessionGroup: 'origin', runtime: 'codex' });
  f.health.set('codex', { health: 'auth_failed' });
  f.health.set('claude', { health: 'ok' });
  await f.rounds(2);
  assert.equal(calls(f, 'launch').length, 0);
  assert.equal(waits(f, 'auth_blocked').length, 1);
  f.health.set('codex', { health: 'ok' });
  f.health.set('claude', { health: 'auth_failed' });
  await f.rounds(1);
  assert.equal(calls(f, 'launch').length, 1);
  assert.equal(calls(f, 'launch')[0][1].launchConfig.runtime, 'codex');
});

test('a rate-limited Origin waits once for an existing same-runtime scene without registration', async t => {
  const f = routerFixture(t); f.put('a'); await startIdle(f); originControl(f);
  f.health.set('claude', { health: 'rate_limited' });
  const absentSince = f.router.state.resident.absentSince;
  await f.rounds(4);
  assert.equal(calls(f, 'launch').length, 0);
  assert.equal(calls(f, 'submit').length, 0);
  assert.equal(waits(f, 'scene_present').length, 1);
  assert.equal(f.router.state.resident.failures, 0);
  assert.equal(f.router.state.resident.absentSince, absentSince);
  f.health.set('claude', { health: 'auth_failed' }); await f.rounds(1);
  assert.equal(waits(f, 'auth_blocked').length, 1);
  f.health.set('claude', { health: 'rate_limited' }); await f.rounds(1);
  assert.equal(waits(f, 'scene_present').length, 2);
  f.health.set('claude', { health: 'ok' }); await f.rounds(1);
  assert.equal(calls(f, 'launch').length, 1);
});

for (const result of ['registered', 'not_restricted']) {
  test(`a rate-limited Origin uses the runId admitted by ${result}`, async t => {
    const f = routerFixture(t); f.put('a', { runtime: 'codex' }); await startIdle(f); originControl(f);
    f.health.set('claude', { health: 'rate_limited' });
    f.deps.submit = async request => {
      f.calls.push(['submit', request]);
      return { kind: 'accepted', sent: true, reply: { ...request, ok: true, result, ...(result === 'registered' ? { reason: 'recovery_due' } : {}) } };
    };
    await f.rounds(1);
    assert.equal(calls(f, 'submit').length, 1);
    const request = calls(f, 'submit')[0][1];
    assert.equal(request.sessionGroup, 'origin');
    assert.equal(request.runtime, 'claude');
    assert.equal(calls(f, 'launch').length, 1);
    assert.equal(calls(f, 'launch')[0][1].runId, request.runId);
  });
}

for (const kind of ['attempt_backoff', 'connect_failed', 'no_reply']) {
  test(`a rate-limited Origin stays asleep on ${kind} without consuming launch backoff`, async t => {
    const f = routerFixture(t); await startIdle(f); originControl(f);
    f.health.set('claude', { health: 'rate_limited' });
    f.deps.submit = async request => {
      f.calls.push(['submit', request]);
      return kind === 'attempt_backoff'
        ? { kind: 'rejected', sent: true, reply: { ...request, ok: false, code: kind, notBefore: f.now() + 60000 } }
        : { kind, sent: kind === 'no_reply' };
    };
    const absentSince = f.router.state.resident.absentSince;
    await f.rounds(3);
    assert.equal(calls(f, 'launch').length, 0);
    assert.equal(f.router.state.resident.failures, 0);
    assert.equal(f.router.state.resident.absentSince, absentSince);
    assert.equal(waits(f, kind).length, 1);
    assert.equal(calls(f, 'submit').length, 3);
  });
}

test('Origin and an ordinary group share runtime single-flight and uncertain same-round suppression', async t => {
  const f = routerFixture(t); await startIdle(f);
  originControl(f); const message = f.add('a');
  f.health.set('claude', { health: 'rate_limited' });
  const hold = deferred();
  f.deps.submit = async request => { f.calls.push(['submit', request]); return hold.promise; };
  await pump(f);
  assert.equal(calls(f, 'submit').length, 1);
  const first = calls(f, 'submit')[0][1];
  assert.equal(first.sessionGroup, 'origin');
  assert.equal(calls(f, 'launch').length, 0);
  hold.resolve({ kind: 'no_reply', sent: true }); await f.router.idle(); await flush();
  assert.equal(calls(f, 'submit').length, 1);
  assert.equal(f.row(message.id).status, 'pending');
  assert.equal(f.router.state.resident.failures, 0);
  f.deps.submit = async request => {
    f.calls.push(['submit', request]);
    return { kind: 'no_reply', sent: true };
  };
  await f.rounds(1);
  assert.equal(calls(f, 'submit').length, 2);
  assert.notEqual(calls(f, 'submit')[1][1].runId, first.runId);
  assert.equal(calls(f, 'launch').length, 0);
});

test('a surviving startup prompt wakes Origin and a replacement is delivered exactly once', async t => {
  const f = routerFixture(t); await startIdle(f);
  const old = f.db.insertControl('Startup instructions', { sessionGroup: 'origin', appendAckSuffix: false });
  let replacement;
  f.deps.getSessionAdapter = runtime => ({ launch: async input => {
    f.calls.push(['launch', input]);
    replacement = f.db.insertControl('Startup instructions', { sessionGroup: 'origin', appendAckSuffix: false });
    const live = f.put('origin', { runId: input.runId, runtime, launchConfig: input.launchConfig });
    f.current.set('origin', { runId: live.runId, sessionId: live.sessionId, startupControlIds: [replacement.id], ts: f.now() });
  }, stop: async () => assert.fail('ready Origin should not be stopped') });
  await f.rounds(5);
  assert.equal(calls(f, 'launch').length, 1);
  assert.equal(f.db.getControlById(old.id).status, 'superseded');
  assert.equal(f.db.getControlById(replacement.id).status, 'done');
  assert.deepEqual(calls(f, 'control').map(row => row[1]), [replacement.id]);
});

// Real Router/Store with private memory SQLite and injected health/clock/scene.
// Run for Origin marker demand or readiness changes; skip unrelated UI work.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; no real tmux,
// runtime, network or child process. Fixture stops Router and closes the DB.
test('only an Origin restart marker wakes after authentication and cannot wake again once cleared', async t => {
  const f = routerFixture(t); await startIdle(f);
  f.health.set('claude', { health: 'auth_failed' });
  f.db.recordRunEnd('origin', { runId: 'ended-origin', reason: 'unexpected' });
  await f.rounds(3);
  assert.equal(calls(f, 'launch').length, 0);
  assert.equal(f.db.getOriginNeed().continuation.pending, true);
  f.health.set('claude', { health: 'ok' }); await f.rounds(4);
  assert.equal(calls(f, 'launch').length, 1);
  assert.equal(calls(f, 'launch')[0][1].sessionGroup, 'origin');
  assert.deepEqual(f.db.getOriginNeed().continuation, { pending: false, oldestAt: null });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM control_queue').get().n, 0);
  assert.equal(calls(f, 'conversation').length, 0);
  f.scene.delete('origin'); f.current.delete('origin');
  f.advance(65000); await f.rounds(4);
  assert.equal(calls(f, 'launch').length, 1);
});
