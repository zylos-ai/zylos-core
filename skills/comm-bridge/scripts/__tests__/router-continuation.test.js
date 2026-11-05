import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionReader } from '../../../../cli/lib/session-state-reader-async.js';
import { observeSessionTarget } from '../../../../cli/lib/runtime/session-target.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture, deferred, flush } from './helpers/router-fixture.js';
import { createContinuationRestarts } from '../router/continuation.js';

const calls = (f, kind) => f.calls.filter(row => row[0] === kind);
function continuation(f, group = 'a', runId = 'old-run') {
  const row = f.add(group);
  f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(row.id);
  f.db.recordRunEnd(group, { runId, reason: 'unexpected' }); return group;
}
async function initialize(f) { await f.create().initialize(); await f.rounds(2); }
async function readyToStart(f) { f.advance(5000); await f.rounds(5); }

test('continuation-only group starts after preflight and receives only startup text', async t => {
  const f = routerFixture(t); f.put('origin');
  const id = continuation(f);
  const old = f.db.insertControl('old-run command', { sessionGroup: 'a', appendAckSuffix: false });
  const getAdapter = f.deps.getSessionAdapter;
  let prompt;
  f.deps.getSessionAdapter = runtime => ({ ...getAdapter(runtime), launch: async input => {
    f.calls.push(['launch', input]);
    f.put(input.sessionGroup, { runId: input.runId });
    prompt = f.db.insertControl('startup prompt', { sessionGroup: 'a', appendAckSuffix: false });
    f.current.get('a').startupControlIds = [prompt.id];
  } });
  await initialize(f);
  assert.equal(calls(f, 'launch').length, 0);
  await readyToStart(f);
  assert.equal(calls(f, 'launch').length, 1);
  assert.equal(f.db.getControlById(old.id).last_error, 'SESSION_ENDED');
  assert.deepEqual(calls(f, 'control').map(row => row[1]), [prompt.id]);
  assert.equal((f.db.listRunEndings([id])[0].continuationPending ? 'pending' : 'done'), 'done');
  assert.equal(calls(f, 'conversation').length, 0);
});

test('inbound activation clears its marker before the triggering message', async t => {
  const f = routerFixture(t); f.put('origin'); const id = continuation(f);
  const message = f.add('a');
  await initialize(f); await f.rounds(5);
  assert.deepEqual(f.calls.filter(row => ['control','conversation'].includes(row[0])).map(row => row.slice(0, 2)), [['conversation', message.id]]);
  assert.equal(calls(f, 'launch').length, 1);
  assert.equal(f.db.listRunEndings([id])[0].continuationPending, 0);
});

for (const blocked of ['group_fence','global_fence','auth_failed','scene']) {
  test(`continuation preflight ${blocked} does not consume capacity or start admission`, async t => {
    const f = routerFixture(t, { poolSize: 1 }); f.put('origin', { runtime: 'codex' }); continuation(f);
    if (blocked === 'group_fence') f.db.setDrainFence('a', { reason: 'ttl', runId: 'old-run' });
    if (blocked === 'global_fence') f.db.setDrainFence('*');
    if (blocked === 'auth_failed') f.health.set('claude', { health: 'auth_failed' });
    if (blocked === 'scene') f.put('a', { ready: false, createdAt: f.now() / 1000 + 60 });
    await initialize(f); await readyToStart(f);
    assert.equal(calls(f, 'launch').length, 0); assert.equal(calls(f, 'submit').length, 0);
    assert.equal(f.router.state.activations.size, 0);
    assert.equal(f.router.availableCapacity(), blocked === 'scene' ? 0 : 1);
    assert.equal(f.db.listPendingContinuations().length, 1);
  });
}

for (const health of ['rate_limited', 'unavailable', 'recovering', 'down']) {
  test(`continuation uses restricted admission for ${health} with the reserved run identity`, async t => {
    const f = routerFixture(t, { poolSize: 1 }); f.put('origin', { runtime: 'codex' }); continuation(f);
    f.health.set('claude', { health });
    const submit = f.deps.submit;
    f.deps.submit = request => {
      assert.equal(f.router.availableCapacity(), 0);
      assert.equal(f.router.state.activations.get('a').runId, request.runId);
      return submit(request);
    };
    await initialize(f); await readyToStart(f);
    assert.equal(calls(f, 'submit').length, 1); assert.equal(calls(f, 'launch').length, 1);
    assert.equal(calls(f, 'submit')[0][1].runId, calls(f, 'launch')[0][1].runId);
  });
}

for (const reply of ['not_restricted','attempt_backoff','probe_inflight','invalid_request','connect_failed','invalid_reply']) {
  test(`continuation admission ${reply} releases unsuccessful reservations without losing the marker`, async t => {
    const f = routerFixture(t, { poolSize: 1 }); f.put('origin', { runtime: 'codex' }); const id = continuation(f);
    f.health.set('claude', { health: 'down' });
    f.deps.submit = async request => {
      if (reply === 'not_restricted') return { kind: 'accepted', reply: { ...request, ok: true, result: 'not_restricted' } };
      if (reply === 'connect_failed') return { kind: 'connect_failed', sent: false };
      if (reply === 'invalid_reply') return { kind: 'accepted', reply: { ok: true } };
      return { kind: 'rejected', reply: { ...request, ok: false, code: reply, ...(reply === 'attempt_backoff' ? { notBefore: f.now() + 10000 } : {}) } };
    };
    await initialize(f); await readyToStart(f);
    const accepted = reply === 'not_restricted';
    assert.equal(calls(f, 'launch').length, accepted ? 1 : 0);
    assert.equal(f.router.state.activations.size, 0);
    assert.equal(f.router.availableCapacity(), accepted ? 0 : 1);
    assert.equal((f.db.listRunEndings([id])[0].continuationPending ? 'pending' : 'done'), accepted ? 'done' : 'pending');
  });
}

test('an existing runtime skips restricted registration and full capacity sends no request', async t => {
  const f = routerFixture(t, { poolSize: 1 }); f.put('origin'); continuation(f);
  f.health.set('claude', { health: 'down' });
  await initialize(f); await readyToStart(f);
  assert.equal(calls(f, 'submit').length, 0); assert.equal(calls(f, 'launch').length, 1);
  const g = routerFixture(t, { poolSize: 1 }); g.put('origin', { runtime: 'codex' }); g.put('occupied', { runtime: 'codex' }); continuation(g);
  g.health.set('claude', { health: 'down' }); await initialize(g); await readyToStart(g);
  assert.equal(calls(g, 'submit').length, 0); assert.equal(calls(g, 'launch').length, 0);
});

for (const order of ['older', 'newer']) {
  test(`all inbound groups precede continuation-only groups when inbound head is ${order}`, async t => {
    const f = routerFixture(t, { poolSize: 1 }); f.put('origin'); continuation(f, 'b');
    const message = f.add('c');
    f.sqlite.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(f.now() / 1000 + (order === 'older' ? -100 : 100), message.id);
    await initialize(f); await readyToStart(f);
    assert.deepEqual(calls(f, 'launch').map(row => row[1].sessionGroup), ['c']);
    assert.equal(f.db.listPendingContinuations()[0].sessionGroup, 'b');
  });
}

test('continuation-only candidates order by ending time and then session group', async t => {
  const f = routerFixture(t, { poolSize: 1 }); f.put('origin');
  continuation(f, 'a'); f.advance(1000); continuation(f, 'b');
  f.sqlite.prepare("UPDATE run_endings SET ended_at=ended_at-10 WHERE session_group='b'").run();
  await initialize(f); await readyToStart(f);
  assert.deepEqual(calls(f, 'launch').map(row => row[1].sessionGroup), ['b']);
});

test('just-ready crashes back off while a stable runtime resets pacing', async t => {
  const f = routerFixture(t); f.put('origin'); continuation(f);
  await initialize(f); await readyToStart(f);
  const first = f.scene.get('a').runId;
  f.scene.delete('a'); await f.rounds(2);
  f.db.recordRunEnd('a', { runId: first, reason: 'unexpected' });
  await f.rounds(2); f.advance(9999); await f.rounds(2);
  assert.equal(calls(f, 'launch').length, 1);
  f.advance(1); await f.rounds(5); assert.equal(calls(f, 'launch').length, 2);
  const second = f.scene.get('a').runId;
  f.advance(60000); await f.rounds(2);
  f.scene.delete('a'); await f.rounds(2);
  f.db.recordRunEnd('a', { runId: second, reason: 'unexpected' });
  await f.rounds(2); f.advance(5000); await f.rounds(5);
  assert.equal(calls(f, 'launch').length, 3);
});

test('failed launches retain continuation and alert after five, then readiness clears the count', async t => {
  const f = routerFixture(t); f.put('origin'); const id = continuation(f);
  const original = f.deps.getSessionAdapter;
  f.deps.getSessionAdapter = runtime => ({ ...original(runtime), launch: async input => { f.calls.push(['launch', input]); throw Error('cannot launch'); } });
  await initialize(f);
  for (const delay of [5000,10000,20000,40000,60000,60000]) { f.advance(delay); await f.rounds(3); }
  assert.equal(calls(f, 'launch').length, 6);
  assert.equal(calls(f, 'alert').filter(row => row[1] === 'continuation_start_failed').length, 1);
  assert.equal((f.db.listRunEndings([id])[0].continuationPending ? 'pending' : 'done'), 'pending'); assert.equal(f.router.availableCapacity(), 2);
  f.deps.getSessionAdapter = original; f.advance(60000); await f.rounds(5);
  assert.equal((f.db.listRunEndings([id])[0].continuationPending ? 'pending' : 'done'), 'done');
});

test('restart before launch and after launch preserves and clears a pending marker once', async t => {
  for (const launched of [false, true]) await t.test(String(launched), async t => {
    const f = routerFixture(t); f.put('origin'); const id = continuation(f);
    const original = f.deps.getSessionAdapter;
    if (launched) f.deps.getSessionAdapter = runtime => ({ ...original(runtime), launch: async input => { f.calls.push(['launch', input]); f.put('a', { runId: input.runId, ready: false }); } });
    await initialize(f);
    if (launched) await readyToStart(f);
    await f.router.stop();
    if (launched) f.put('a', { runId: f.scene.get('a').runId, ready: true });
    f.deps.getSessionAdapter = original;
    await initialize(f); await readyToStart(f);
    assert.deepEqual(calls(f, 'control'), []);
    assert.equal((f.db.listRunEndings([id])[0].continuationPending ? 'pending' : 'done'), 'done');
    assert.equal(calls(f, 'launch').length, 1);
  });
});

test('restart counters throttle repeated launch failure alerts for thirty minutes', () => {
  let clock = 0; const alerts = [];
  const restarts = createContinuationRestarts({ now: () => clock, deps: { alert: (...args) => alerts.push(args) }, diagnostic() {} });
  for (let i = 0; i < 6; i++) restarts.failed('a', 'run-' + i);
  assert.equal(alerts.length, 1);
  clock = 1800000; restarts.failed('a', 'later'); assert.equal(alerts.length, 2);
  restarts.ready('a'); clock += 1800000;
  for (let i = 0; i < 4; i++) restarts.failed('a', 'reset-' + i);
  assert.equal(alerts.length, 2);
});

for (const blocked of ['group_fence', 'auth_failed', 'backoff']) {
  test(`earlier ${blocked} continuation does not starve a later eligible continuation`, async t => {
    const f = routerFixture(t, { poolSize: blocked === 'backoff' ? 2 : 1 }); f.put('origin');
    continuation(f, 'a'); f.advance(1000); if (blocked !== 'backoff') continuation(f, 'b');
    const resolve = f.db.resolveSessionLaunchConfig;
    f.db.resolveSessionLaunchConfig = input => input.sessionGroup === 'a' ? { runtime: 'codex', mode: 'default' } : resolve(input);
    if (blocked === 'group_fence') f.db.setDrainFence('a', { reason: 'ttl', runId: 'old-run' });
    if (blocked === 'auth_failed') f.health.set('codex', { health: 'auth_failed' });
    await initialize(f);
    if (blocked === 'backoff') {
      f.advance(5000); await f.rounds(5);
      const runId = f.scene.get('a').runId;
      f.scene.delete('a'); f.db.recordRunEnd('a', { runId, reason: 'unexpected' });
      continuation(f, 'b');
      await f.rounds(2); f.advance(5000); await f.rounds(5);
      assert.equal(calls(f, 'launch').filter(row => row[1].sessionGroup === 'b').length, 1);
    } else { await readyToStart(f); assert.deepEqual(calls(f, 'launch').map(row => row[1].sessionGroup), ['b']); }
  });
}

test('a faster continuation preflight cannot overtake an eligible inbound candidate', async t => {
  const f = routerFixture(t, { poolSize: 1 }); f.put('origin', { runtime: 'codex' }); continuation(f, 'b'); const message = f.add('c');
  f.health.set('claude', { health: 'auth_failed' }); await initialize(f);
  const read = f.deps.readLiveIdentity, hold = deferred();
  f.deps.readLiveIdentity = async group => { if (group === 'c') await hold.promise; return read(group); };
  f.health.set('claude', { health: 'ok' }); f.advance(5000);
  f.router.tick(); await flush(); await flush();
  try { assert.equal(calls(f, 'launch').length, 0); } finally { hold.resolve(); }
  await f.router.idle(); await f.rounds(5);
  assert.deepEqual(calls(f, 'launch').map(row => row[1].sessionGroup), ['c']);
  assert.equal(f.row(message.id).status, 'delivered');
});

for (const changed of ['fence','scene','capacity','marker','inbound']) {
  test(`continuation admission rechecks ${changed} after an asynchronous reply`, async t => {
    const f = routerFixture(t, { poolSize: 1 }); f.put('origin', { runtime: 'codex' }); const id = continuation(f);
    f.health.set('claude', { health: 'down' });
    const hold = deferred(); let request;
    f.deps.submit = async input => { request = input; return hold.promise; };
    await initialize(f); f.advance(5000); f.router.tick(); await flush(); await flush();
    assert.ok(request);
    if (changed === 'fence') f.db.setDrainFence('a', { reason: 'ttl', runId: 'old-run' });
    if (changed === 'scene') f.put('a');
    if (changed === 'capacity') assert.deepEqual(f.db.takeSlot('occupied', {runId:'competitor', k:1}), {taken:false, reason:'full'});
    if (changed === 'marker') f.db.clearContinuation('a', { runId: 'another-run' });
    if (changed === 'inbound') f.add('a');
    hold.resolve({ kind: 'accepted', reply: { ...request, ok: true, result: 'not_restricted' } });
    await f.router.idle();
    assert.equal(calls(f, 'launch').length, changed === 'capacity' ? 1 : 0);
    assert.equal(f.router.state.activations.size, changed === 'capacity' ? 1 : 0);
    assert.equal((f.db.listRunEndings([id])[0].continuationPending ? 'pending' : 'done'), changed === 'marker' ? 'done' : 'pending');
  });
}

test('continuation ready timeout releases confirmed absent launch and keeps its marker', async t => {
  const f = routerFixture(t, { readyTimeoutMs: 1000 }); f.put('origin'); const id = continuation(f);
  const original = f.deps.getSessionAdapter;
  f.deps.getSessionAdapter = runtime => ({ ...original(runtime), launch: async input => { f.calls.push(['launch', input]); f.put('a', { runId: input.runId, ready: false }); } });
  await initialize(f); await readyToStart(f);
  assert.equal(f.router.state.activations.size, 1);
  f.advance(1000); await f.rounds(2);
  assert.equal(f.router.state.activations.size, 0); assert.equal(f.router.availableCapacity(), 2);
  assert.equal((f.db.listRunEndings([id])[0].continuationPending ? 'pending' : 'done'), 'pending');
  assert.equal(calls(f, 'stop').length, 1);
  assert.ok(f.events.some(event => event.event === 'activate_timeout' && event.session_group === 'a'));
});


test('transient observation failure after continuation launch does not stop the new run', async t => {
  const f = routerFixture(t); f.put('origin'); const id = continuation(f);
  const read = f.deps.readLiveIdentity;
  const adapter = f.deps.getSessionAdapter;
  let failNextRead = false;
  let failures = 0;
  f.deps.getSessionAdapter = runtime => ({ ...adapter(runtime), launch: async input => {
    f.calls.push(['launch', input]);
    f.put(input.sessionGroup, { runId: input.runId, ready: false });
    failNextRead = true;
  } });
  f.deps.readLiveIdentity = async group => {
    if (group === 'a' && failNextRead) {
      failNextRead = false; failures++;
      throw Object.assign(Error('temporary tmux read failure'), { code: 'TMUX_UNAVAILABLE' });
    }
    return read(group);
  };
  await initialize(f); await readyToStart(f);
  assert.equal(failures, 1);
  assert.equal(calls(f, 'launch').length, 1);
  assert.equal(calls(f, 'stop').length, 0);
  assert.equal(f.router.state.activations.size, 1);
  assert.equal((f.db.listRunEndings([id])[0].continuationPending ? 'pending' : 'done'), 'pending');
  const runId = f.scene.get('a').runId;
  f.put('a', { runId, ready: true }); await f.rounds(4);
  assert.equal(calls(f, 'stop').length, 0);
  assert.equal((f.db.listRunEndings([id])[0].continuationPending ? 'pending' : 'done'), 'done');
  assert.deepEqual(calls(f, 'control'), []);
});

test('origin restarts with pending continuation and delivers only the startup prompt', async t => {
  const f = routerFixture(t);
  const id = continuation(f, 'origin');
  const adapter = f.deps.getSessionAdapter;
  let prompt;
  f.deps.getSessionAdapter = runtime => ({ ...adapter(runtime), launch: async input => {
    f.calls.push(['launch', input]);
    f.put(input.sessionGroup, { runId: input.runId });
    prompt = f.db.insertControl('origin startup prompt', { sessionGroup: 'origin', priority: 2, appendAckSuffix: false });
    f.current.get('origin').startupControlIds = [prompt.id];
  } });
  await initialize(f); await readyToStart(f);
  assert.equal(calls(f, 'launch').length, 1);
  assert.equal(calls(f, 'launch')[0][1].sessionGroup, 'origin');
  assert.deepEqual(calls(f, 'control').map(row => row[1]), [prompt.id]);
  assert.equal((f.db.listRunEndings([id])[0].continuationPending ? 'pending' : 'done'), 'done');
  assert.equal(calls(f, 'conversation').length, 0);
  assert.equal(calls(f, 'submit').length, 0);
});


test('prelaunch diagnostic and logging failures converge and later inbound can be delivered', async t => {
  const f = routerFixture(t); f.put('origin'); const id = continuation(f);
  await initialize(f);
  let diagnosticFailures = 0, logFailures = 0, failedActivation;
  f.deps.diagnostic = (event, fields) => {
    f.events.push({ event, ...fields });
    if (event === 'activate_continuation' && diagnosticFailures === 0) {
      diagnosticFailures++;
      failedActivation = f.router.state.activations.get('a');
      throw Error('diagnostic unavailable');
    }
  };
  f.deps.log = () => {
    if (logFailures === 0) { logFailures++; throw Error('log unavailable'); }
  };
  await readyToStart(f);
  assert.equal(diagnosticFailures, 1); assert.equal(logFailures, 1);
  assert.equal(failedActivation.launchSettled, true);
  assert.equal(f.router.state.activations.size, 0);
  assert.equal(calls(f, 'launch').length, 0);
  assert.equal((f.db.listRunEndings([id])[0].continuationPending ? 'pending' : 'done'), 'pending');
  const message = f.add('a'); await f.rounds(5);
  assert.equal(calls(f, 'launch').length, 1);
  assert.equal(f.row(message.id).status, 'delivered');
  assert.equal((f.db.listRunEndings([id])[0].continuationPending ? 'pending' : 'done'), 'done');
  assert.equal(f.router.state.activations.size, 0);
});

// Real Router/store, injected scene/clock/transport: run for marker timing or
// readiness changes. No runtime, network, tmux or PM2 is invoked. Official runner
// isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; fixtures close SQLite and stop Router.
for (const group of ['a', 'origin']) {
  test(`ready ${group} clears its marker before a blocked or missing startup prompt`, async t => {
    const f = routerFixture(t); if (group !== 'origin') f.put('origin');
    continuation(f, group); f.put(group, { runId: 'new-run', ready: false, createdAt: f.now()/1000 + 100 });
    await initialize(f);
    assert.equal(f.db.listRunEndings([group])[0].continuationPending, 1);
    f.put(group, { runId: 'new-run', ready: true });
    const prompt = f.db.insertControl('startup', { sessionGroup: group, appendAckSuffix: false });
    f.current.get(group).startupControlIds = [prompt.id];
    f.deps.deliverControl = async () => ({ blocked: true });
    await f.rounds(2);
    assert.equal(f.db.listRunEndings([group])[0].continuationPending, 0);
    assert.equal(f.events.filter(e => e.event === 'continuation_cleared' && e.runId === 'new-run').length, 1);
    assert.equal(f.db.getControlById(prompt.id).status, 'running');
    assert.equal(calls(f, 'launch').length, 0);
  });
}

test('clearing a marker retries after an error without blocking inbound delivery', async t => {
  const f = routerFixture(t); f.put('origin'); continuation(f); f.put('a', { runId: 'new' });
  const message = f.add('a'), clear = f.db.clearContinuation;
  let attempts = 0;
  f.db.clearContinuation = () => { attempts++; throw Error('busy'); };
  await initialize(f); await f.rounds(3);
  assert.equal(f.row(message.id).status, 'delivered');
  assert.ok(attempts >= 2); assert.equal(f.db.listPendingContinuations().length, 1);
  assert.ok(f.events.some(e => e.event === 'continuation_clear_failed'));
  assert.equal(calls(f, 'conversation').filter(row => row[1] === message.id).length, 1);
  assert.equal(calls(f, 'control').length, 0);
  f.db.clearContinuation = clear;
  await f.rounds(2);
  assert.equal(f.db.listPendingContinuations().length, 0);
  assert.equal(calls(f, 'conversation').filter(row => row[1] === message.id).length, 1);
});

test('ready scene matching the ended run retains its marker', async t => {
  const f = routerFixture(t); f.put('origin'); continuation(f); f.put('a', { runId: 'old-run' });
  await initialize(f); await f.rounds(3);
  assert.equal(f.db.listRunEndings(['a'])[0].continuationPending, 1);
  assert.equal(f.events.filter(e => e.event === 'continuation_cleared').length, 0);
  assert.equal(calls(f, 'launch').length, 0);
});


test('inbound continuation clears before startup and trigger without adding a control row', async t => {
  const f = routerFixture(t); f.put('origin'); continuation(f);
  const message = f.add('a'), sequence = [], clear = f.db.clearContinuation;
  f.db.clearContinuation = (...args) => { const result = clear(...args); if (result.cleared) sequence.push('clear'); return result; };
  const adapter = f.deps.getSessionAdapter;
  f.deps.getSessionAdapter = runtime => ({ ...adapter(runtime), launch: async input => {
    f.calls.push(['launch', input]); f.put('a', { runId: input.runId });
    const prompt = f.db.insertControl('startup prompt', { sessionGroup: 'a', appendAckSuffix: false });
    f.current.get('a').startupControlIds = [prompt.id];
  } });
  const control = f.deps.deliverControl, conversation = f.deps.deliverConversation;
  f.deps.deliverControl = async (...args) => { sequence.push('startup'); return control(...args); };
  f.deps.deliverConversation = async (...args) => { sequence.push('trigger'); return conversation(...args); };
  await initialize(f); await f.rounds(5);
  assert.deepEqual(sequence, ['clear', 'startup', 'trigger']);
  assert.equal(f.row(message.id).status, 'delivered');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM control_queue').get().n, 1);
});

test('a ready marker clears with empty startup ids and a later TTL ending stays dormant', async t => {
  const f = routerFixture(t); f.put('origin'); continuation(f); f.put('a', { runId: 'new-run' });
  await initialize(f);
  assert.equal(f.db.listRunEndings(['a'])[0].continuationPending, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM control_queue').get().n, 0);
  f.scene.delete('a'); f.db.recordRunEnd('a', { runId: 'new-run', reason: 'ttl' });
  f.advance(60000); await f.rounds(5);
  assert.equal(calls(f, 'launch').length, 0);
  const incoming = f.add('a'); await f.rounds(5);
  assert.equal(calls(f, 'launch').length, 1); assert.equal(f.row(incoming.id).status, 'delivered');
});

test('equal ending timestamps order continuation candidates by session group', async t => {
  const f = routerFixture(t, { poolSize: 1 }); f.put('origin');
  continuation(f, 'b'); continuation(f, 'a');
  await initialize(f); await readyToStart(f);
  assert.deepEqual(calls(f, 'launch').map(x => x[1].sessionGroup), ['a']);
});


// Boundary: production identity reader and target readiness parser read private
// F3 files; only tmux protocol I/O is fake. Run for marker readiness changes;
// skip unrelated runtime launch. No tmux/process/network command is executed.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME and short TMPDIR; the fixture
// stops Router, closes SQLite and removes its private F3 files on teardown.
test('real identity reader retains a marker for stale F3 and clears after current F3 publication', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marker-ready-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'current-session.json');
  const f = routerFixture(t); f.put('origin'); continuation(f);
  f.put('a', { runId: 'new-run', ready: false, createdAt: f.now()/1000 });
  const readyFile = runId => ({ runId, sessionId: 'new-session', ts: f.now(), startupControlIds: [] });
  await fs.writeFile(file, JSON.stringify(readyFile('old-run')));
  let opened = 0, closed = 0;
  const reader = createSessionReader({
    open: async () => { opened++; return { bindTarget() {}, close() { closed++; }, command: async args => {
      if (args[0] === 'show-environment') return String.raw`ZYLOS_RUN_ID="new-run"; export ZYLOS_RUN_ID;
ZYLOS_MODEL_CONFIG="{\"runtime\":\"claude\"}"; export ZYLOS_MODEL_CONFIG;`;
      assert.equal(args[0], 'display-message');
      return `100:200\t$1\t%1\t${f.now()/1000}`;
    } }; },
    observe: options => observeSessionTarget({ ...options,
      readReady: async () => JSON.parse(await fs.readFile(file, 'utf8')) }),
  });
  const original = f.deps.readLiveIdentity;
  f.deps.readLiveIdentity = group => group === 'a' ? reader.readLiveIdentity(group) : original(group);
  assert.equal((await reader.readLiveIdentity('a')).ready, false);
  await initialize(f);
  assert.equal(f.db.listRunEndings(['a'])[0].continuationPending, 1);
  await fs.writeFile(file + '.next', JSON.stringify(readyFile('new-run')));
  await fs.rename(file + '.next', file);
  assert.equal((await reader.readLiveIdentity('a')).ready, true);
  f.health.set('claude', { health: 'auth_failed' });
  await f.rounds(2);
  assert.equal(f.router.state.live.get('a').ready, true);
  f.router.tick(); await f.router.idle();
  assert.equal(f.db.listRunEndings(['a'])[0].continuationPending, 0);
  assert.equal(calls(f, 'control').length, 0);
  assert.equal(calls(f, 'launch').length, 0);
  assert.equal(f.events.filter(e => e.event === 'continuation_cleared').length, 1);
  await f.router.stop();
  assert.equal(opened, closed);
});
