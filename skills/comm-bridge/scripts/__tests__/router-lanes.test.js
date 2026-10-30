import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture, deferred, flush } from './helpers/router-fixture.js';
const pump = async f => { for (let i = 0; i < 4; i++) { f.router.tick(); await flush(); } };

test('one blocked delivery does not prevent another ready lane or new activation', async t => {
  for (const existing of [true, false]) await t.test(`B existing=${existing}`, async t => {
    const f = routerFixture(t); f.put('origin'); f.put('a'); if (existing) f.put('b');
    const a = f.add('a'), b = f.add('b'); const hold = deferred(); const delivered = [];
    f.deps.deliverConversation = async (row, live) => { if (row.id === a.id) await hold.promise;
      delivered.push(row.id); f.db.markDelivered(row.id, { sessionId: live.sessionId }); };
    const router = f.create(); await router.initialize(); await pump(f);
    assert.equal(f.row(a.id).status, 'running'); assert.equal(f.row(b.id).status, 'delivered');
    assert.deepEqual(delivered, [b.id]);
    hold.resolve(); await router.idle(); assert.deepEqual(delivered, [b.id, a.id]);
  });
});

test('control timeout is global even with no lane, and pool waiting preserves priority', async t => {
  const f = routerFixture(t, { poolSize: 1 }); f.put('origin'); f.put('occupied');
  const low = f.add('low', { priority: 5 }), high = f.add('high', { priority: 1 });
  const expired = f.db.insertControl('expire', { sessionGroup: 'silent', ackDeadlineAt: f.now()/1000 - 1 });
  const router = f.create(); await router.initialize(); await f.rounds(2);
  assert.equal(f.db.getControlById(expired.id).status, 'timeout');
  assert.equal(router.state.lanes.has('silent'), false);
  assert.equal(f.row(low.id).status, 'pending'); assert.equal(f.row(high.id).status, 'pending');
  f.scene.delete('occupied'); await f.rounds(5);
  assert.equal(f.calls.find(x => x[0] === 'launch')[1].sessionGroup, 'high');
  assert.equal(f.row(high.id).status, 'delivered'); assert.equal(f.row(low.id).status, 'pending');
});

test('control claim=false ends lane round without claiming business', async t => {
  const f = routerFixture(t); f.put('origin'); f.put('a'); const row = f.add('a');
  f.db.insertControl('priority control', { sessionGroup: 'a', appendAckSuffix: false });
  f.db.claimControl = () => false;
  const router = f.create(); await router.initialize(); await f.rounds(4);
  assert.equal(f.row(row.id).status, 'pending'); assert.equal(f.calls.some(x => x[0] === 'conversation'), false);
});

test('recovery control before startup prompt before triggering conversation; clear reloads identity', async t => {
  const f = routerFixture(t); f.put('origin'); const row = f.add('a');
  const launch = f.deps.getSessionAdapter;
  f.deps.getSessionAdapter = runtime => ({ ...launch(runtime), launch: async input => {
    await launch(runtime).launch(input);
    const prompt = f.db.insertControl('prompt', { sessionGroup: 'a', priority: 2, appendAckSuffix: false });
    const recovery = f.db.insertControl('recovery', { sessionGroup: 'a', priority: 0, bypassState: true, appendAckSuffix: false });
    f.current.get('a').startupControlIds = [prompt.id];
    f.calls.push(['expected', recovery.id, prompt.id]);
  } });
  const router = f.create(); await router.initialize(); await f.rounds(7);
  const expected = f.calls.find(x => x[0] === 'expected').slice(1);
  assert.deepEqual(f.calls.filter(x => x[0] === 'control').map(x => x[1]), expected);
  assert.equal(f.row(row.id).status, 'delivered');
  const prompt2 = f.db.insertControl('clear prompt', { sessionGroup: 'a', appendAckSuffix: false });
  f.put('a', { runId: f.scene.get('a').runId, sessionId: 'clear-id' });
  f.current.get('a').startupControlIds = [prompt2.id]; const later = f.add('a'); await f.rounds(4);
  assert.equal(f.row(later.id).session_id, 'clear-id');
  assert.equal(f.calls.findIndex(x => x[0] === 'control' && x[1] === prompt2.id) < f.calls.findIndex(x => x[0] === 'conversation' && x[1] === later.id), true);
});

test('startup prompt fence or health block requeues trigger without retry', async t => {
  for (const blockedBy of ['fence', 'health']) await t.test(blockedBy, async t => {
    const f = routerFixture(t); f.put('origin'); const row = f.add('a');
    const adapter = f.deps.getSessionAdapter;
    f.deps.getSessionAdapter = runtime => ({ ...adapter(runtime), launch: async input => {
      await adapter(runtime).launch(input);
      const prompt = f.db.insertControl('prompt', { sessionGroup: 'a', appendAckSuffix: false }); f.current.get('a').startupControlIds = [prompt.id];
      if (blockedBy === 'fence') f.db.setDrainFence('*');
    } });
    if (blockedBy === 'health') f.deps.deliverControl = async row => { f.sqlite.prepare("UPDATE control_queue SET status='pending' WHERE id=?").run(row.id); return { blocked: true }; };
    const router = f.create(); await router.initialize(); await f.rounds(5);
    assert.equal(f.row(row.id).status, 'pending'); assert.equal(f.row(row.id).retry_count, 0);
    assert.equal(router.state.activations.size, 0); assert.equal(router.availableCapacity(), 1);
  });
});

test('expiry commits before receipt and skips launch/registration; fresh next item proceeds', async t => {
  const f = routerFixture(t); f.put('origin', { runtime: 'codex' });
  const old = f.add('a'), fresh = f.add('a'); f.sqlite.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(f.now()/1000 - 1801, old.id);
  f.health.set('claude', { health: 'rate_limited' });
  f.deps.handleExpired = async row => { assert.equal(row.id, old.id); assert.equal(f.row(row.id).status, 'failed');
    assert.equal(f.calls.some(x => x[0] === 'submit' || x[0] === 'launch'), false); f.calls.push(['expired', row.id]); };
  const router = f.create(); await router.initialize(); await f.rounds(6);
  assert.equal(f.row(old.id).delivery_action, 'pending_expired'); assert.equal(f.row(old.id).retry_count, 0);
  assert.equal(f.row(fresh.id).status, 'delivered');
  assert.equal(f.calls.filter(x => x[0] === 'submit').length, 1);
});

test('expiry DB error stops lane before launch, while another lane continues', async t => {
  const f = routerFixture(t); f.put('origin'); f.put('b'); const a = f.add('a'), b = f.add('b');
  const expire = f.db.expirePending; f.db.expirePending = (id, max) => { if (id === a.id) throw Error('conditional write failed'); return expire(id, max); };
  const router = f.create(); await router.initialize(); await f.rounds(4);
  assert.equal(f.row(a.id).status, 'pending'); assert.equal(f.row(b.id).status, 'delivered');
  assert.equal(f.calls.some(x => x[0] === 'launch'), false);
});

test('capacity opportunity preserves head order across slow high-priority preflight', async t => {
  const f = routerFixture(t, { poolSize: 1 }); f.put('origin');
  const high = f.add('high', {priority: 0}), low = f.add('low', {priority: 1});
  const hold = deferred(); const read = f.deps.readLiveIdentity; let highReads = 0;
  f.deps.readLiveIdentity = async group => {
    // First read discovers absence; the next is activation's recheck.
    if (group === 'high' && ++highReads >= 2 && !f.scene.has(group)) await hold.promise;
    return read(group);
  };
  const router = f.create(); await router.initialize(); await pump(f);
  assert.equal(f.row(low.id).status, 'pending'); assert.equal(f.calls.some(x => x[0] === 'launch'), false);
  hold.resolve(); await router.idle(); await f.rounds(4);
  assert.equal(f.calls.find(x => x[0] === 'launch')[1].sessionGroup, 'high');
  assert.equal(f.row(high.id).status, 'delivered'); assert.equal(f.row(low.id).status, 'pending');
});

test('expired priority head is reranked against other groups before capacity allocation', async t => {
  const f = routerFixture(t, { poolSize: 1 }); f.put('origin');
  const old = f.add('a', {priority:0}); f.add('a', {priority:3}); const b = f.add('b', {priority:1});
  f.sqlite.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(f.now()/1000 - 1801, old.id);
  const router = f.create(); await router.initialize(); await f.rounds(5);
  assert.equal(f.row(old.id).status, 'failed'); assert.equal(f.row(b.id).status, 'delivered');
  assert.equal(f.calls.find(x => x[0] === 'launch')[1].sessionGroup, 'b');
});

test('rejected preflight passes opportunity to another runtime without reserving capacity', async t => {
  const f = routerFixture(t, {poolSize:1}); const a=f.add('a',{priority:0}), b=f.add('b',{priority:1});
  f.health.set('claude',{health:'unavailable'}); f.db.resolveSessionLaunchConfig=({sessionGroup})=>({runtime:sessionGroup==='b'?'codex':'claude',mode:'default'});
  const hold=deferred(); f.deps.submit=async request=>{await hold.promise;return {kind:'rejected',sent:true,reply:{...request,ok:false,code:'probe_inflight'}};};
  const router=f.create();await router.initialize();await pump(f);
  assert.equal(router.availableCapacity(),1); assert.equal(f.row(a.id).status,'pending');
  hold.resolve();await router.idle();await flush();await router.idle();await f.rounds(3);
  assert.equal(f.row(b.id).status,'delivered');assert.equal(f.row(a.id).status,'pending');
});
