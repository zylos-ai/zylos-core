import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture, deferred, flush } from './helpers/router-fixture.js';
import { resolveSessionPoolSize } from '../../../../cli/lib/session-pool-config.js';

test('T02 pool size: environment then file then fixed hardware, minimum one', () => {
  const hardware = { cpuCount: 4, totalMemoryBytes: 8 * 1024 ** 3 };
  assert.equal(resolveSessionPoolSize({ ...hardware, env: {}, config: {} }), 6);
  assert.equal(resolveSessionPoolSize({ ...hardware, env: { ZYLOS_SESSION_POOL_SIZE: '25' }, config: { session_pool_size: 3 } }), 25);
  for (const value of ['0', '-1', '1.5', 'bogus', true, null]) {
    assert.equal(resolveSessionPoolSize({ ...hardware, env: { ZYLOS_SESSION_POOL_SIZE: value }, config: { session_pool_size: 3 } }), 3);
    assert.equal(resolveSessionPoolSize({ ...hardware, env: {}, config: { session_pool_size: value } }), 6);
  }
  assert.equal(resolveSessionPoolSize({ cpuCount: 1, totalMemoryBytes: 1024 ** 3, env: {}, config: {} }), 1);
});

test('T01 strict mode is read once, CONFIG_UNREADABLE stays inert even after repair', async t => {
  const f = routerFixture(t); let broken = true;
  f.deps.readSessionMode = () => { f.calls.push(['mode']); if (broken) throw Object.assign(new Error('broken'), { code: 'CONFIG_UNREADABLE' }); return { mode: 'multi' }; };
  const router = f.create(); await router.initialize(); broken = false;
  await router.initialize(); await f.rounds(4);
  assert.equal(router.state.inert, true);
  assert.equal(f.calls.filter(x => x[0] === 'mode').length, 1);
  assert.equal(f.calls.filter(x => x[0] === 'recover').length, 0);
  assert.equal(f.calls.filter(x => x[0] === 'alert').length, 1);
});

test('T01 orphan recovery once before selection; strict age/retry classifications', async t => {
  const f = routerFixture(t); f.put('origin');
  const ages = [1799, 1800, 1801, 20];
  const rows = ages.map((age,i) => { const row = f.add(); f.db.claimConversation(row.id);
    f.sqlite.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch'),retry_count=? WHERE id=?")
      .run(f.now() / 1000 - age, i === 3 ? 1 : 0, row.id);
    return row; });
  const router = f.create(); await router.initialize();
  assert.equal(f.calls.filter(x => x[0] === 'recover').length, 1);
  assert.deepEqual(rows.map(row => [f.row(row.id).status, f.row(row.id).retry_count]), [['pending',1],['pending',1],['failed',0],['failed',2]]);
  await router.initialize(); await f.rounds(3);
  assert.equal(f.calls.filter(x => x[0] === 'recover').length, 1);
  assert.ok(f.events.some(x => x.event === 'orphan_recovery_summary' && x.oldestId === rows[0].id));
});

test('T01 failed recovery never selects or launches and never re-runs recovery', async t => {
  const f = routerFixture(t); let recoveries = 0;
  f.db.recoverOrphanRunning = () => { recoveries++; throw Error('DB unavailable'); };
  const router = f.create(); await assert.rejects(router.initialize(), /DB unavailable/);
  await assert.rejects(router.initialize(), /DB unavailable/); router.tick();
  assert.equal(recoveries, 1); assert.equal(router.state.ready, false);
  assert.equal(f.calls.some(x => x[0] === 'launch'), false);
});

test('T01 initial unobservable scene cannot become empty capacity', async t => {
  const f = routerFixture(t); f.add(); f.put('origin');
  f.deps.listGroupTmuxSessions = async () => { throw Error('tmux timeout'); };
  const router = f.create(); await router.initialize(); await f.rounds(3);
  assert.equal(router.availableCapacity(), 0);
  assert.equal(f.calls.some(x => x[0] === 'launch'), false);
});

test('T01 unowned startup waits from tmux creation; boundary READY avoids stop', async t => {
  const f = routerFixture(t); f.put('origin'); f.put('a', { ready: false });
  const router = f.create(); await router.initialize(); await f.rounds(2);
  assert.equal(f.calls.some(x => x[0] === 'stop'), false);
  f.advance(1000); f.put('a', { ready: true }); await f.rounds(2);
  assert.equal(f.calls.some(x => x[0] === 'stop'), false);
  f.put('b', { ready: false, createdAt: f.now() / 1000 - 2 }); await f.rounds(3);
  assert.ok(f.calls.some(x => x[0] === 'stop' && x[1].tmuxName.endsWith('-b')));
});

test('T03 resident retry is seconds not rounds, excludes K, never start_attempt', async t => {
  const f = routerFixture(t, { poolSize: 1 }); f.put('a'); f.health.set('claude', { health: 'auth_failed' });
  const router = f.create(); await router.initialize(); await f.rounds(2);
  f.advance(3000); await f.rounds(1); assert.equal(f.calls.some(x => x[0] === 'launch'), false);
  f.advance(3000); await f.rounds(3);
  assert.equal(f.calls.filter(x => x[0] === 'launch').length, 1);
  assert.equal(f.calls.find(x => x[0] === 'launch')[1].sessionGroup, 'origin');
  assert.equal(f.calls.some(x => x[0] === 'submit'), false);
  assert.equal(router.availableCapacity(), 0);
  f.advance(60000); await f.rounds(2); assert.equal(router.state.resident.failures, 0);
});

test('T03 single uses null semantic scope and origin target; global fence prevents launch', async t => {
  const f = routerFixture(t, { mode: 'single' }); f.deps.readSessionMode = () => ({ mode: null, keyPresent: false });
  f.db.setDrainFence('*'); const router = f.create(); await router.initialize(); await f.rounds(2);
  f.advance(9000); await f.rounds(2); assert.equal(f.calls.some(x => x[0] === 'launch'), false);
  // Read failure also holds the resident lane; no fallback launch.
  f.db.getDrainFence = () => { throw Error('busy'); }; await f.rounds(2);
  assert.equal(f.calls.some(x => x[0] === 'launch'), false);
  f.db.getDrainFence = () => null; await f.rounds(3);
  assert.equal(f.calls.find(x => x[0] === 'launch')[1].sessionGroup, null);
  assert.ok(f.calls.some(x => x[0] === 'prepare'));
});

test('T01 unowned timeout observation failure alerts without stopping or freeing capacity', async t => {
  const f = routerFixture(t, { poolSize: 1 }); f.put('origin'); f.put('a', { ready: false });
  const b = f.add('b'); const router = f.create(); await router.initialize(); await f.rounds(2);
  const read = f.deps.readLiveIdentity;
  f.deps.readLiveIdentity = async group => {
    if (group === 'a') throw Object.assign(Error('unobservable'), { code: 'TMUX_UNAVAILABLE' });
    return read(group);
  };
  f.advance(1000); await router.state.lanes.get('a').kick();
  assert.equal(f.calls.some(x => x[0] === 'stop'), false);
  assert.equal(router.availableCapacity(), 0); assert.equal(f.row(b.id).status, 'pending');
  assert.ok(router.state.live.get('a').present);
  assert.ok(f.events.some(x => x.event === 'stop_unconfirmed' && x.session_group === 'a' && x.reason === 'TMUX_UNAVAILABLE'));
  assert.ok(f.calls.some(x => x[0] === 'alert' && x[1] === 'stop_unconfirmed' && x[2].sessionGroup === 'a'));
  f.deps.readLiveIdentity = read; await router.state.lanes.get('a').kick();
  assert.equal(f.calls.filter(x => x[0] === 'stop').length, 1);
  assert.equal(f.scene.has('a'), false);
});

// P04 T07 / DM F12/F14: rotation is independent of daily control cleanup.
test('T07 diagnostics maintenance runs every minute independently and remains single-flight', async t => {
  const f = routerFixture(t); f.put('origin');
  const hold = deferred(); let starts = 0;
  f.deps.maintainDiagnostics = async () => { starts++; if (starts === 2) await hold.promise; };
  const router = f.create(); await router.initialize(); await f.rounds();
  assert.equal(starts, 1);
  f.advance(59999); await f.rounds(); assert.equal(starts, 1);
  try {
    f.advance(1); router.tick(); await flush(); assert.equal(starts, 2);
    f.advance(60000); router.tick(); await flush(); assert.equal(starts, 2);
    assert.equal(f.calls.filter(x => x[0] === 'cleanup').length, 1);
  } finally { hold.resolve(); await router.idle(); }
  await f.rounds(); assert.equal(starts, 3);
  assert.equal(f.calls.filter(x => x[0] === 'cleanup').length, 1);
});

// P04 T01 / M1 8.3: missing identity does not wait for the READY deadline.
test('T01 missing runId stops immediately with null binding and alerts; known run waits', async t => {
  const f = routerFixture(t); f.put('origin');
  const missing = f.put('missing', { runId: null, ready: false });
  f.put('starting', { ready: false });
  const router = f.create(); await router.initialize(); await f.rounds(2);
  assert.deepEqual(f.calls.filter(x => x[0] === 'stop').map(x => x[1]), [{ tmuxName: missing.tmuxName, expectedRunId: null }]);
  assert.ok(f.events.some(x => x.event === 'tmux_runid_missing' && x.session_group === 'missing'));
  assert.ok(f.calls.some(x => x[0] === 'alert' && x[1] === 'tmux_runid_missing' && x[2].sessionGroup === 'missing'));
  assert.equal(f.scene.has('missing'), false); assert.equal(f.scene.has('starting'), true);
});

// P04 T02 / M1 2.8: count the incompatible pending scope, without consuming it.
test('T02 mode mismatch counts and alerts once per interval in both modes', async t => {
  for (const mode of ['single', 'multi']) await t.test(mode, async t => {
    const f = routerFixture(t, { mode }); f.put(mode === 'single' ? null : 'origin');
    const controls = ['one','two','running'].map(text => f.db.insertControl(text, { sessionGroup: 'other', appendAckSuffix: false }));
    // Simulate persisted machine controls left by a prior single-mode process.
    if (mode === 'multi') f.sqlite.prepare('UPDATE control_queue SET session_group=NULL').run();
    f.db.claimControl(controls[2].id);
    const router = f.create(); await router.initialize(); await f.rounds(3);
    const events = () => f.events.filter(x => x.event === 'mode_mismatch');
    const alerts = () => f.calls.filter(x => x[0] === 'alert' && x[1] === 'mode_mismatch');
    assert.deepEqual(events(), [{ event: 'mode_mismatch', count: 2, mode }]);
    assert.equal(alerts().length, 1); assert.equal(alerts()[0][2].pending, 2); assert.equal(alerts()[0][2].running, 1);
    assert.deepEqual(controls.map(row => f.db.getControlById(row.id).status), ['pending','pending','running']);
    f.advance(60000); await f.rounds(); assert.equal(events().length, 2); assert.equal(alerts().length, 2);
    for (const row of controls) f.db.expireControlById(row.id);
    f.advance(60000); await f.rounds(); assert.equal(events().length, 2); assert.equal(alerts().length, 2);
  });
});

// P04 T01: a READY identity without startup controls is adopted once and reported.
test('T01 startup prompt missing is reported once per adopted identity, not with a prompt', async t => {
  const f = routerFixture(t); f.put('origin'); f.put('a'); f.put('with-prompt');
  const prompt = f.db.insertControl('startup', { sessionGroup: 'with-prompt', appendAckSuffix: false });
  f.current.get('with-prompt').startupControlIds = [prompt.id];
  const router = f.create(); await router.initialize(); await f.rounds(4);
  const missing = () => f.events.filter(x => x.event === 'startup_prompt_missing');
  assert.equal(missing().filter(x => x.session_group === 'a').length, 1);
  assert.equal(missing().some(x => x.session_group === 'with-prompt'), false);
  f.put('a', { sessionId: 'after-clear' }); await f.rounds(3);
  assert.equal(missing().filter(x => x.session_group === 'a').length, 2);
  assert.equal(missing().find(x => x.session_id === 'after-clear').session_group, 'a');
});

// IF-70: the two independent age limits are visible exactly once at startup.
test('IF70 pending and recovery age limits print once despite reinitialize and ticks', async t => {
  const f = routerFixture(t); f.put('origin');
  f.options.pendingMaxAgeSeconds = 123; f.options.recoverMaxAgeSeconds = 456;
  const router = f.create(); await router.initialize(); await router.initialize(); await f.rounds(4);
  assert.deepEqual(f.calls.filter(x => x[0] === 'log').map(x => x[1]),
    ['C4_PENDING_MAX_AGE_SECONDS=123', 'C4_RECOVER_MAX_AGE_SECONDS=456']);
});
