import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture } from './helpers/router-fixture.js';

// Integration boundary: real Router and C4 store, injected scene/runtime I/O and
// clock. Run for occupancy admission/release/order changes; skip unrelated UI.
// Official runner supplies private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; fixture
// uses a private SQLite file and no tmux, PM2, network or real runtime. The router
// is stopped by t.after and SQLite/temp files belong to the fixture lifecycle.
const launches = f => f.calls.filter(row => row[0] === 'launch');
function held(f, group = 'b') {
  f.db.takeSlot(group, { runId: 'old-' + group, k: 20 });
  f.db.recordRunEnd(group, { runId: 'old-' + group, reason: 'upgrade' });
}
async function start(f) { f.put('origin', { runtime: 'codex' }); await f.create().initialize(); await f.rounds(3); }

 test('held continuation takes its own row while a waiting inbound group has no free slot', async t => {
  const f = routerFixture(t, { poolSize: 2 }); f.put('a'); held(f); f.add('c');
  await start(f); f.advance(5000); await f.rounds(6);
  assert.deepEqual(launches(f).map(row => row[1].sessionGroup), ['b']);
  assert.equal(f.db.listSlotOccupancy().length, 2);
 });

for (const delta of [119000,120000]) test(`retained slot expiration at ${delta / 1000} seconds respects inbound priority`, async t => {
 const f=routerFixture(t,{poolSize:1});held(f);f.health.set('claude',{health:'auth_failed'});f.add('c');
 // Route c to the healthy runtime without changing production configuration.
 const resolve=f.db.resolveSessionLaunchConfig;f.db.resolveSessionLaunchConfig=options=>({...resolve(options),runtime:options.sessionGroup==='c'?'codex':'claude'});
 await start(f);f.advance(delta);await f.rounds(6);
 assert.deepEqual(launches(f).map(row=>row[1].sessionGroup),delta===119000?[]:['c']);
});

test('running occupancy blocks both its absent owner and a new inbound group until reconciliation',async t=>{
 const f=routerFixture(t,{poolSize:1});f.db.takeSlot('b',{runId:'old-b',k:1});f.add('b');f.add('c');
 await start(f);await f.rounds(4);assert.equal(launches(f).length,0);
 await f.router.stop();await f.create().initialize();await f.rounds(3);assert.equal(launches(f).length,0);
 f.db.recordRunEnd('b',{runId:'old-b',reason:'unexpected'});await f.rounds(6);
 assert.deepEqual(launches(f).map(row=>row[1].sessionGroup),['b']);assert.equal(f.db.listSlotOccupancy().length,1);
});

for(const kind of ['connect_failed','rejected','name_conflict','launch_failure'])test(`failed continuation ${kind} restores the original held row`,async t=>{
 const f=routerFixture(t,{poolSize:1});held(f);const before=f.db.listSlotOccupancy()[0];
 if(kind==='connect_failed'||kind==='rejected'){
  f.health.set('claude',{health:'down'});f.deps.submit=async request=>kind==='connect_failed'?{kind:'connect_failed',sent:false}:{kind:'rejected',reply:{...request,ok:false,code:'probe_inflight'}};
 }else f.deps.getSessionAdapter=()=>({launch:async()=>{throw Object.assign(new Error(kind),{code:kind==='name_conflict'?'NAME_CONFLICT':'LAUNCH_FAILED'});},stop:async()=>{}});
 await start(f);f.advance(5000);await f.rounds(4);assert.deepEqual(f.db.listSlotOccupancy(),[before]);assert.equal(f.db.listPendingContinuations().length,1);
});

test('full occupancy prevents restricted start registration',async t=>{
 const f=routerFixture(t,{poolSize:1});f.db.takeSlot('a',{runId:'absent-a',k:1});f.add('b');f.health.set('claude',{health:'down'});
 await start(f);await f.rounds(4);assert.equal(f.calls.filter(row=>row[0]==='submit').length,0);assert.equal(launches(f).length,0);
});

test('inbound plus continuation inherits one held row and Origin never owns a slot',async t=>{
 const f=routerFixture(t,{poolSize:1});held(f);f.add('b');await start(f);await f.rounds(6);
 assert.equal(launches(f).length,1);assert.deepEqual(f.db.listSlotOccupancy().map(row=>[row.sessionGroup,row.state]),[['b','running']]);
});

test('a failed occupancy refresh after take returns the newly taken row',async t=>{
 const f=routerFixture(t,{poolSize:1});f.add('a');const take=f.db.takeSlot,list=f.db.listSlotOccupancy;let fail=false;
 f.db.takeSlot=(...args)=>{const result=take(...args);if(result.taken)fail=true;return result;};
 f.db.listSlotOccupancy=()=>{if(fail){fail=false;throw new Error('one read failure');}return list();};
 await start(f);assert.equal(launches(f).length,0);assert.equal(f.db.listSlotOccupancy().length,0);
});

test('failed inbound claim restores a retained row without launching',async t=>{
 const f=routerFixture(t,{poolSize:1});held(f);const prior=f.db.listSlotOccupancy()[0];f.add('b');f.db.claimConversation=()=>false;
 await start(f);assert.deepEqual(f.db.listSlotOccupancy(),[prior]);assert.equal(launches(f).length,0);
});

test('unconfirmed termination retains startup occupancy until absence is observed',async t=>{
 const f=routerFixture(t,{poolSize:1,readyTimeoutMs:1000});f.add('b');
 f.deps.getSessionAdapter=()=>({launch:async input=>{f.put(input.sessionGroup,{runId:input.runId,ready:false});},stop:async()=>{}});
 await start(f);f.advance(1000);await f.rounds(2);assert.equal(f.db.listSlotOccupancy()[0].state,'running');
 f.scene.delete('b');f.db.claimConversation=()=>false;await f.rounds(3);assert.equal(f.db.listSlotOccupancy().length,0);
});

test('Router restart preserves the retained slot and gives it to its owner',async t=>{
 const f=routerFixture(t,{poolSize:1});held(f);f.add('c');await start(f);await f.router.stop();
 await f.create().initialize();await f.rounds(2);assert.equal(launches(f).length,0);f.advance(5000);await f.rounds(6);
 assert.deepEqual(launches(f).map(row=>row[1].sessionGroup),['b']);assert.equal(f.db.listSlotOccupancy().length,1);
});

test('five failed continuation launches restore held state until its original expiry',async t=>{
 const f=routerFixture(t,{poolSize:1});held(f);const original=f.db.listSlotOccupancy()[0];let attempts=0;
 f.deps.getSessionAdapter=()=>({launch:async()=>{attempts++;throw new Error('launch rejected');},stop:async()=>{}});
 await start(f);
 for(const delay of [5000,10000,20000,40000]){
  f.advance(delay);await f.rounds(4);assert.deepEqual(f.db.listSlotOccupancy(),[original]);
 }
 f.advance(60000);await f.rounds(4);
 assert.equal(attempts,5);assert.equal(f.db.listSlotOccupancy().length,0);
 assert.equal(f.calls.filter(row=>row[0]==='alert'&&row[1]==='continuation_start_failed').length,1);
 assert.equal(f.db.listPendingContinuations().length,1);
});

for(const reason of ['ttl','evict'])test(`${reason} removes reservation while inherited continuation yields to inbound`,async t=>{
 const f=routerFixture(t,{poolSize:1});held(f);
 // A new ending identity represents a later run reclaimed before delivery.
 f.db.takeSlot('b',{runId:'later-b',k:1});f.db.recordRunEnd('b',{runId:'later-b',reason});
 assert.equal(f.db.listSlotOccupancy().length,0);assert.equal(f.db.listPendingContinuations().length,1);
 f.add('c');await start(f);f.advance(5000);await f.rounds(6);
 assert.deepEqual(launches(f).map(row=>row[1].sessionGroup),['c']);
});

test('authentication recovery gives expired reservation to inbound while retaining the later owner',async t=>{
 const f=routerFixture(t,{poolSize:2});held(f,'a');
 f.db.takeSlot('b',{runId:'old-b',k:2});f.health.set('claude',{health:'auth_failed'});f.add('c');await start(f);
 f.advance(200000);f.db.recordRunEnd('b',{runId:'old-b',reason:'auth'});await f.rounds(2);
 assert.deepEqual(f.db.listSlotOccupancy().map(row=>row.sessionGroup),['b']);
 f.health.set('claude',{health:'ok'});await f.rounds(6);f.advance(5000);await f.rounds(6);
 assert.deepEqual(new Set(launches(f).map(row=>row[1].sessionGroup)),new Set(['b','c']));
 assert.equal(f.db.listSlotOccupancy().length,2);assert.equal(f.db.listPendingContinuations().some(row=>row.sessionGroup==='a'),true);
});

test('unknown post-stop observation retains occupancy until target absence is confirmed',async t=>{
 const f=routerFixture(t,{poolSize:1,readyTimeoutMs:1000});f.add('b');let stopped=false,unknown=true;
 const read=f.deps.readLiveIdentity;
 f.deps.readLiveIdentity=async group=>group==='b'&&stopped&&unknown?{present:null}:read(group);
 f.deps.getSessionAdapter=()=>({launch:async input=>f.put(input.sessionGroup,{runId:input.runId,ready:false}),stop:async()=>{stopped=true;f.scene.delete('b');}});
 await start(f);f.advance(1000);await f.rounds(2);
 assert.equal(f.db.listSlotOccupancy().length,1);
 assert.equal(f.router.state.activations.has('b'),true);
 assert.ok(f.calls.some(row=>row[0]==='alert'&&row[1]==='stop_unconfirmed'));
 unknown=false;f.db.claimConversation=()=>false;await f.rounds(2);
 assert.equal(f.db.listSlotOccupancy().length,0);
});
