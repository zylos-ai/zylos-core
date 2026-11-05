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

test('unconfirmed adapter stop retains startup occupancy until stop succeeds',async t=>{
 const f=routerFixture(t,{poolSize:1,readyTimeoutMs:1000});const message=f.add('b');
 f.deps.getSessionAdapter=()=>({launch:async input=>{f.put(input.sessionGroup,{runId:input.runId,ready:false});},stop:async()=>{if(f.scene.has('b'))throw Object.assign(new Error('stop unconfirmed'),{code:'STOP_UNCONFIRMED'});}});
 await start(f);f.advance(1000);await f.rounds(2);assert.equal(f.db.listSlotOccupancy()[0].state,'running');
 assert.equal(f.row(message.id).status,'running');assert.equal(f.row(message.id).retry_count,0);
 assert.ok(f.events.some(row=>row.event==='stop_unconfirmed'&&row.reason==='STOP_UNCONFIRMED'));
 assert.ok(f.calls.some(row=>row[0]==='alert'&&row[1]==='stop_unconfirmed'));
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

test('an adapter stop timeout retains occupancy and the running message until retry succeeds',async t=>{
 const f=routerFixture(t,{poolSize:1,readyTimeoutMs:1000});const message=f.add('b');let unconfirmed=true;
 f.deps.getSessionAdapter=()=>({launch:async input=>f.put(input.sessionGroup,{runId:input.runId,ready:false}),stop:async()=>{if(unconfirmed)throw Object.assign(new Error('stop timed out'),{code:'TMUX_TIMEOUT'});f.scene.delete('b');}});
 await start(f);f.advance(1000);await f.rounds(2);
 assert.equal(f.db.listSlotOccupancy().length,1);
 assert.equal(f.router.state.activations.has('b'),true);
 assert.ok(f.calls.some(row=>row[0]==='alert'&&row[1]==='stop_unconfirmed'));
 assert.equal(f.row(message.id).status,'running');assert.equal(f.row(message.id).retry_count,0);
 assert.ok(f.events.some(row=>row.event==='stop_unconfirmed'&&row.reason==='TMUX_TIMEOUT'));
 unconfirmed=false;f.db.claimConversation=()=>false;await f.rounds(2);
 assert.equal(f.db.listSlotOccupancy().length,0);
});

for (const retained of [false,true]) test(`inbound name conflict returns ${retained ? 'retained' : 'new'} occupancy`,async t=>{
 const f=routerFixture(t,{poolSize:1});if(retained)held(f);const before=f.db.listSlotOccupancy();const message=f.add('b');let conflicts=0;
 f.deps.getSessionAdapter=()=>({launch:async()=>{conflicts++;throw Object.assign(new Error('name already exists'),{code:'NAME_CONFLICT'});},stop:async()=>assert.fail('name conflict must not stop another run')});
 await start(f);assert.ok(conflicts>0);assert.deepEqual(f.db.listSlotOccupancy(),before);
 assert.equal(f.row(message.id).status,'pending');assert.equal(f.row(message.id).retry_count,0);
});

test('failed release is retried by the next round without losing its retained deadline',async t=>{
 const f=routerFixture(t,{poolSize:1});held(f);const prior=f.db.listSlotOccupancy();f.health.set('claude',{health:'down'});
 f.deps.submit=async()=>({kind:'connect_failed',sent:false});const release=f.db.releaseSlot;let attempts=0;
 f.db.releaseSlot=(...args)=>{attempts++;if(attempts===1)throw Object.assign(new Error('database busy'),{code:'DB_BUSY'});return release(...args);};
 await start(f);f.advance(5000);await f.rounds(1);
 assert.equal(attempts,1);assert.equal(f.router.state.activations.has('b'),true);assert.equal(f.db.listSlotOccupancy()[0].state,'running');
 await f.rounds(1);assert.equal(attempts,2);assert.deepEqual(f.db.listSlotOccupancy(),prior);assert.equal(f.router.state.activations.has('b'),false);
});

test('an absent running owner does not occupy the queue head ahead of a rowless group',async t=>{
 const f=routerFixture(t,{poolSize:2});f.db.takeSlot('x',{runId:'missing-x',k:2});f.add('x');f.add('y');
 await start(f);assert.deepEqual(launches(f).map(row=>row[1].sessionGroup),['y']);
 assert.equal(f.db.listSlotOccupancy().find(row=>row.sessionGroup==='x').runId,'missing-x');
});

for(const trigger of ['inbound','continuation'])test(`a full transaction rejects ${trigger} activation after eligibility`,async t=>{
 const f=routerFixture(t,{poolSize:1});if(trigger==='inbound')f.add('b');else{held(f);f.db.takeSlot('b',{runId:'later-b',k:1});f.db.recordRunEnd('b',{runId:'later-b',reason:'ttl'});}
 let takes=0;f.db.takeSlot=()=>{takes++;return {taken:false,reason:'full'};};
 await start(f);if(trigger==='continuation'){assert.equal(takes,0);f.advance(5000);await f.rounds(3);}
 assert.ok(takes>0,'transaction must actually be reached');assert.equal(launches(f).length,0);assert.equal(f.db.listSlotOccupancy().length,0);
});

for(const fence of ['b','*'])test(`a ${fence==='*'?'global':'group'} fence appearing during the preclaim identity read returns occupancy without claiming`,async t=>{
 const f=routerFixture(t,{poolSize:1});held(f);f.add('b');const prior=f.db.listSlotOccupancy();let introduced=false,takes=0,releases=0;const message=f.db.getNextPending({sessionGroups:['b']});
 const read=f.deps.readLiveIdentity;f.deps.readLiveIdentity=async group=>{const identity=await read(group);if(group==='b'&&takes>0&&!introduced){await Promise.resolve();introduced=true;if(fence==='*')f.db.setDrainFence('*');else f.db.setDrainFence('b',{reason:'ttl',runId:'old-b'});}return identity;};
 const take=f.db.takeSlot,release=f.db.releaseSlot;f.db.takeSlot=(...args)=>{takes++;return take(...args);};
 f.db.releaseSlot=(...args)=>{releases++;return release(...args);};
 await start(f);assert.equal(introduced,true);assert.equal(takes,1);assert.equal(releases,1);assert.equal(launches(f).length,0);assert.deepEqual(f.db.listSlotOccupancy(),prior);
 assert.equal(f.row(message.id).status,'pending');assert.equal(f.row(message.id).retry_count,0);
});

for(const trigger of ['inbound','continuation'])test(`unobservable session listing blocks ${trigger} from taking its retained row`,async t=>{
 const f=routerFixture(t,{poolSize:1});held(f);if(trigger==='inbound')f.add('b');const prior=f.db.listSlotOccupancy();let takes=0;
 f.deps.listGroupTmuxSessions=async()=>{throw new Error('session listing unavailable');};const take=f.db.takeSlot;f.db.takeSlot=(...args)=>{takes++;return take(...args);};
 await start(f);f.advance(5000);await f.rounds(3);assert.equal(takes,0);assert.equal(launches(f).length,0);assert.deepEqual(f.db.listSlotOccupancy(),prior);
});

test('unreadable unrelated identity does not block a freshly absent retained owner',async t=>{
 const f=routerFixture(t,{poolSize:1});held(f);f.add('b');const read=f.deps.readLiveIdentity;
 f.deps.listGroupTmuxSessions=async()=>[{sessionGroup:'x',tmuxName:f.identity('x').tmuxName},{sessionGroup:'origin',tmuxName:f.identity('origin').tmuxName}];
 f.deps.readLiveIdentity=async group=>{if(group==='x')throw new Error('unrelated identity unavailable');return read(group);};
 await start(f);assert.deepEqual(launches(f).map(row=>row[1].sessionGroup),['b']);assert.equal(f.router.availableCapacity(),0);
});
