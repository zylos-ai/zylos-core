import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture, flush } from './helpers/router-fixture.js';
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
