import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeHealthCoordinator, aggregateRuntimeDemand, classifyRecoveryResult } from '../runtime-health.js';
import { HealthStore } from '../health-store.js';
import { MessageRouter } from '../message-router.js';
import { SupervisorHealthObserver } from '../supervisor-health-observer.js';

function registered(reply) {
  assert.equal(reply.result, 'registered');
  assert.equal(Object.hasOwn(reply, 'attemptCount'), false);
  assert.equal(Object.hasOwn(reply, 'attemptAt'), false);
}
function scheduling(state) {
  const s = state.scheduling;
  return [s.restartFailureCount, s.lastRecoveryAt, s.lastDownCheckAt];
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'runtime-health-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  let clock = 1792000000000, scenes = [], probe = false, cache = null;
  const options = {zylosDir:root,now:()=>clock,readMode:()=> 'multi',resolveTargetRuntime:()=> 'claude',
    listScenes:()=>scenes,probeInFlight:()=>probe,readNegativeCache:()=>cache,clearNegativeCache:()=>{cache=null;}};
  const health = new RuntimeHealthCoordinator(options);
  const state = health.store('claude').read(); state.health = 'unavailable'; state.reason='runtime_unavailable'; health.store('claude').write(state);
  return {root,health,options,now:()=>clock,advance:ms=>clock+=ms,setScene:v=>scenes=v,setProbe:v=>probe=v,setCache:v=>cache=v,
    request:(extra={})=>({version:1,type:'start_attempt',requestId:`sa-${clock}-123456789abc`,runtime:'claude',sessionGroup:'telegram:one',runId:randomUUID(),...extra}),
    read:()=>health.store('claude').read(),set:(patch,budget={})=>{const s=health.store('claude').read();Object.assign(s,patch);Object.assign(s.scheduling,budget);health.store('claude').write(s);}};
}

// IF-62 A/B: all ordered decisions and response field relationships.
test('start registration validates request and evaluates restrictions in order',async t=>{
  const f=fixture(t);
  for(const change of [{version:2},{requestId:'bad'},{runtime:'BAD'},{runId:'bad'},{sessionGroup:'origin'},{sessionGroup:'*'},{sessionGroup:null}]) assert.equal((await f.health.registerStartAttempt(f.request(change))).code,'invalid_request');
  f.set({health:'ok'});f.setScene([{runtime:'claude'}]);f.setProbe(true);
  assert.equal((await f.health.registerStartAttempt(f.request())).result,'not_restricted');
  f.set({health:'auth_failed'});assert.equal((await f.health.registerStartAttempt(f.request())).code,'auth_blocked');
  f.set({health:'rate_limited',reason:'rate_limit_unclassified'},{cooldownUntil:f.now()/1000+500});
  assert.equal((await f.health.registerStartAttempt(f.request())).code,'scene_present');
  f.setScene([]);assert.deepEqual((await f.health.registerStartAttempt(f.request())).code,'probe_inflight');
  assert.equal(Object.hasOwn(await f.health.registerStartAttempt(f.request()),'notBefore'),false);
  f.setProbe(false);assert.equal((await f.health.registerStartAttempt(f.request())).notBefore,f.now()+500000);
  f.set({}, {cooldownUntil:0});f.setCache({version:2,runtime:'claude',health:'rate_limited',reason:'rate_limit_unclassified',expiresAt:f.now()+30000});
  assert.equal((await f.health.registerStartAttempt(f.request())).code,'probe_cache');
  f.setCache(null);const answer=await f.health.registerStartAttempt(f.request());
  registered(answer);assert.deepEqual(scheduling(f.read()),[1,f.now()/1000,0]);
  assert.equal(Object.hasOwn(answer,'code'),false);assert.equal(Object.hasOwn(answer,'notBefore'),false);
  assert.equal((await f.health.registerStartAttempt(f.request())).code,'attempt_backoff');
});

test('IF-62/DM-68 concurrent same-runtime requests commit exactly one attempt and reopen preserves backoff',async t=>{
  const f=fixture(t), first=f.request(), second=f.request({sessionGroup:'lark:two'});
  const replies=await Promise.all([f.health.registerStartAttempt(first),f.health.registerStartAttempt(second)]);
  assert.equal(replies.filter(r=>r.result==='registered').length,1);assert.equal(f.read().scheduling.restartFailureCount,1);
  const restarted=new RuntimeHealthCoordinator(f.options);
  assert.equal((await restarted.registerStartAttempt(f.request())).code,'attempt_backoff');
  f.advance(60000);registered(await restarted.registerStartAttempt(f.request()));
  assert.deepEqual(scheduling(f.read()),[2,f.now()/1000,0]);
  assert.equal((await restarted.registerStartAttempt(f.request())).notBefore,f.now()+300000);
});

test('IF-62 publication failure does not install association or claim registration',async t=>{
  const f=fixture(t), before=fs.readFileSync(f.health.store('claude').file,'utf8');
  f.health.store('claude').write=()=>{throw new Error('write failed');};
  assert.equal((await f.health.registerStartAttempt(f.request())).code,'health_write_failed');
  assert.equal(f.health.associations.has('claude'),false);
  assert.equal(fs.readFileSync(f.health.store('claude').file,'utf8'),before);
});

test('DM-69/70 exact run association is consumed once, stale and unrelated runs cannot consume it',async t=>{
  const f=fixture(t), request=f.request();await f.health.registerStartAttempt(request);
  const result=runId=>({runtime:'claude',runId,current:{runtime:'claude',runId},terminal:'timeout'});
  const stale=await f.health.applyProbeResult({...result(request.runId),current:{runtime:'claude',runId:randomUUID()}});
  assert.equal(stale.classification,'stale');assert.equal(f.read().scheduling.restartFailureCount,1);
  await f.health.applyProbeResult(result(randomUUID()));assert.equal(f.read().scheduling.restartFailureCount,2);assert.ok(f.health.associations.has('claude'));
  f.advance(1000);await f.health.applyProbeResult(result(request.runId));assert.equal(f.read().scheduling.restartFailureCount,2);assert.equal(f.read().scheduling.lastRecoveryAt,f.now()/1000);assert.equal(f.health.associations.has('claude'),false);
  await f.health.applyProbeResult(result(request.runId));assert.equal(f.read().scheduling.restartFailureCount,3);
});

test('DM-71 restart loses only association and conservatively counts the later failure once',async t=>{
  const f=fixture(t), request=f.request();await f.health.registerStartAttempt(request);
  const restarted=new RuntimeHealthCoordinator(f.options);
  await restarted.applyProbeResult({runtime:'claude',runId:request.runId,current:{runtime:'claude',runId:request.runId},terminal:'timeout'});
  assert.equal(f.read().scheduling.restartFailureCount,2);
  assert.equal((await restarted.registerStartAttempt(f.request())).notBefore,f.now()+300000);
});

test('DM-72 down registration leaves count unchanged; user acceleration is single-use including same second',async t=>{
  const f=fixture(t);f.set({health:'down'},{restartFailureCount:8,lastDownCheckAt:f.now()/1000-20});
  assert.equal((await f.health.registerStartAttempt(f.request())).code,'down_retry_interval');
  assert.equal(await f.health.notifyUserMessage('claude'),true);
  const reply=await f.health.registerStartAttempt(f.request());registered(reply);assert.equal(reply.reason,'user_message');assert.deepEqual(scheduling(f.read()),[8,0,f.now()/1000]);
  assert.equal((await f.health.registerStartAttempt(f.request())).code,'down_retry_interval');
  assert.equal(await f.health.notifyUserMessage('claude'),false);
});

test('DM-45/72 cooldown restore retains budget, rate-limit acceleration clears cooldown but not count',async t=>{
  const f=fixture(t);f.set({health:'rate_limited'},{restartFailureCount:3,lastRecoveryAt:f.now()/1000-500,cooldownUntil:f.now()/1000-1});
  await f.health.restore('claude');assert.equal(f.read().health,'rate_limited');assert.equal(f.read().scheduling.restartFailureCount,3);assert.equal(f.read().scheduling.cooldownUntil,0);
  assert.equal((await f.health.registerStartAttempt(f.request())).code,'attempt_backoff');
  await f.health.notifyUserMessage('claude');registered(await f.health.registerStartAttempt(f.request()));
  assert.deepEqual(scheduling(f.read()),[4,f.now()/1000,0]);
});

test('IB-35 done outranks screen, rate limit outranks simultaneous authentication and keeps budgets',async t=>{
  const f=fixture(t), runId=randomUUID(), input={runtime:'claude',runId,current:{runtime:'claude',runId},terminal:'timeout',matches:{rateLimit:{detected:true,cooldownUntil:f.now()/1000+100},authFailure:{detected:true}}};
  assert.equal(classifyRecoveryResult(input),'rate_limited');await f.health.applyProbeResult(input);
  assert.equal(f.read().health,'rate_limited');assert.equal(f.read().rateLimitActive,true);
  await f.health.applyProbeResult({...input,terminal:'done'});assert.equal(f.read().health,'ok');assert.equal(f.read().rateLimitActive,false);assert.equal(f.read().reason,'');
});

test('DM-63 auth success captures old targets and cannot clear independent limit before all stops and fences',async t=>{
  const f=fixture(t);f.set({health:'rate_limited'},{cooldownUntil:f.now()/1000+100,restartFailureCount:3});
  const runId=randomUUID(), scene={runtime:'claude',runId,sessionGroup:'lark:a'};
  await f.health.applyProbeResult({runtime:'claude',runId,current:scene,terminal:'timeout',matches:{authFailure:{detected:true}}});
  assert.equal(f.read().health,'auth_failed');assert.equal(f.read().rateLimitActive,true);
  await f.health.beginAuthRecovery('claude',{status:'success'},[scene]);
  assert.equal(await f.health.completeAuthRecovery('claude',{isGone:()=>false}),false);
  assert.equal(await f.health.completeAuthRecovery('claude',{isGone:()=>true,hasAuthFence:()=>true}),false);
  assert.equal(f.read().health,'auth_failed');
  assert.equal(await f.health.completeAuthRecovery('claude',{isGone:()=>true}),true);
  assert.equal(f.read().health,'rate_limited');assert.equal(f.read().scheduling.cooldownUntil,f.now()/1000+100);assert.equal(f.read().scheduling.restartFailureCount,3);
});

test('#16a demand aggregates runtime sets, excludes fences and never converts query errors to no demand',async()=>{
  const options={mode:'multi',pendingGroups:['telegram:a','lark:b','telegram:a','lark:c'].map(sessionGroup=>({sessionGroup})),fences:[{sessionGroup:'lark:c'}],resolveTargetRuntime:()=> 'claude'};
  const demand=await aggregateRuntimeDemand(options);assert.equal(demand.size,1);assert.deepEqual([...demand.get('claude')],['telegram:a','lark:b']);
  assert.equal((await aggregateRuntimeDemand({...options,fences:[{sessionGroup:'*'}]})).size,0);
  await assert.rejects(aggregateRuntimeDemand({...options,resolveTargetRuntime:()=>{throw new Error('DB_BUSY');}}),/DB_BUSY/);
});

// T08 health hook groups and reason-roundtrip acceptance, real file publish/reopen.
test('groups retain independent markers, frozen replies and raw group spelling across restart',t=>{
  const f=fixture(t), now=f.now(), identity={runtime:'claude',session_id:'session',claude_pid:12};
  const store=new HealthStore({zylosDir:f.root,now:f.now,freezeNotice:({event,sessionGroup})=>({event_id:event.event_id,conversation_id:sessionGroup,channel:'test',endpoint:sessionGroup,health:'rate_limited',reason:'rate_limit_five_hour',notice:{eligible:true},created_at:event.received_at,status:'pending',...identity})});
  const event=received_at=>({schema_version:1,event_id:randomUUID(),source:'hook',runtime:'claude',...identity,prompt_id:'prompt',event:'stop_failure',error:'rate_limit',received_at});
  store.consume(event(now),{identity,sessionGroup:'test:with_under'});store.consume(event(now-1),{identity,sessionGroup:'test:second'});
  const first=store.read('test:with_under'), second=store.read('test:second');assert.equal(first.last_processed.received_at,now);assert.equal(second.last_processed.received_at,now-1);
  store.transition('ok','authentication_failed',{identity,kind:'recovery'});
  const reopened=new HealthStore({zylosDir:f.root,now:f.now});assert.equal(reopened.read().reason,'');assert.equal(reopened.read('test:with_under').pending_notice.reason,'rate_limit_five_hour');assert.equal(reopened.read('test:second').pending_notice.conversation_id,'test:second');
  const raw=JSON.parse(fs.readFileSync(store.file));assert.ok(Object.hasOwn(raw.hook.groups,'test:with_under'));assert.equal(raw.pendingNotice,undefined);
});

test('old singleton migration atomically keeps budget and claims sending as uncertain once',t=>{
  const f=fixture(t), store=f.health.store('claude');f.set({health:'auth_failed',rateLimitActive:true},{restartFailureCount:4,lastRecoveryAt:123});
  const raw=JSON.parse(fs.readFileSync(store.file));delete raw.hook.groups;
  raw.hook.lastProcessedAt=123456;raw.hook.lastProcessedEventId='old';raw.hook.pendingAttempt={sessionId:'old',pid:12,status:'sending'};
  raw.pendingNotice={eventId:'old',conversationId:19,channel:'test',endpoint:'old',health:'auth_failed',reason:'authentication_failed',notice:{eligible:true},createdAt:123456};
  fs.writeFileSync(store.file,JSON.stringify(raw));
  const reopened=new HealthStore({zylosDir:f.root,now:f.now}), state=reopened.read();
  assert.equal(state.health,'auth_failed');assert.equal(state.rateLimitActive,true);assert.equal(state.scheduling.restartFailureCount,4);assert.equal(state.pending_notice,undefined);assert.equal(state.last_notice_outcome.status,'uncertain');
  const committed=fs.readFileSync(store.file,'utf8');assert.equal(JSON.parse(committed).hook.lastProcessedAt,undefined);assert.equal(JSON.parse(committed).hook.groups.origin.lastProcessedAt,123456);
  new HealthStore({zylosDir:f.root,now:f.now}).read();assert.equal(fs.readFileSync(store.file,'utf8'),committed);
});

test('IB-35 nonterminal controls cannot mutate durable health or consume registered association',async t=>{
  const f=fixture(t),request=f.request();await f.health.registerStartAttempt(request);const before=fs.readFileSync(f.health.store('claude').file,'utf8');
  for(const terminal of ['pending','running',undefined])assert.equal((await f.health.applyProbeResult({runtime:'claude',runId:request.runId,current:request,terminal})).classification,'pending');
  assert.equal(fs.readFileSync(f.health.store('claude').file,'utf8'),before);assert.equal(f.health.associations.get('claude').runId,request.runId);
});

test('IB-33 new auth failure invalidates a previously successful credential capture',async t=>{
  const f=fixture(t),runId=randomUUID(),scene={runtime:'claude',runId,sessionGroup:'telegram:a'};f.set({health:'auth_failed'});
  await f.health.beginAuthRecovery('claude',{status:'success'},[scene]);
  await f.health.applyProbeResult({runtime:'claude',runId,current:scene,terminal:'failed',matches:{authFailure:{detected:true}}});
  assert.equal(await f.health.completeAuthRecovery('claude',{isGone:()=>true}),false);assert.equal(f.read().health,'auth_failed');
});

test('T02 accepted current-process failure outranks conflicting screen evidence on failed recovery',async t=>{
  const f=fixture(t),runId=randomUUID(),identity={runtime:'claude',session_id:'session',claude_pid:44};
  await f.health.consumeHook('claude',{schema_version:1,source:'hook',runtime:'claude',...identity,event_id:randomUUID(),prompt_id:'prompt',event:'stop_failure',error:'authentication_failed',received_at:f.now()},{identity,sessionGroup:'telegram:a'});
  const answer=await f.health.applyProbeResult({runtime:'claude',runId,current:{runtime:'claude',runId},identity,terminal:'failed',matches:{rateLimit:{detected:true}}});
  assert.equal(answer.classification,'auth_error');assert.equal(f.read().health,'auth_failed');assert.equal(f.read().source,'hook');assert.equal(f.read().reason,'authentication_failed');
});

// ZYLO-99 P3-3 / DM-47: route writes public health, every recovery entry consumes it.
test('down and recovering share the normalized negative cache across all recovery entries', async t => {
  for (const health of ['down', 'recovering']) {
    const f = fixture(t);
    f.set({ health, reason: 'runtime_unavailable' });
    let probes = 0;
    const router = new MessageRouter({ healthCoordinator: f.health, now: f.now,
      cacheDirectory: path.join(f.root, 'cache'), resolveTargetRuntime: () => 'claude',
      requestProbe: () => { probes++; } });
    f.health.readNegativeCache = (runtime, state) => router.readNegativeCache(runtime, state.health, state.reason);
    const observer = new SupervisorHealthObserver({ coordinator: f.health, now: f.now });
    router.writeNegativeCache('claude', 'unavailable', 'runtime_unavailable');
    const request = { version: 2, type: 'route', requestId: 'cache-regression', channel: null,
      endpoint: null, componentName: null, sessionGroup: 'telegram:one', noReply: true, receivedAt: f.now() };
    assert.equal((await router.route(request)).cacheHit, true, health);
    assert.equal(probes, 0);
    assert.equal(await observer.due('claude'), false, health);
    const rejected = await f.health.registerStartAttempt(f.request());
    assert.equal(rejected.code, 'probe_cache', health);
    assert.equal(rejected.notBefore, f.now() + 30000);
    f.advance(30000);
    assert.equal(await observer.due('claude'), true, health);
    registered(await f.health.registerStartAttempt(f.request()));
  }
});

// IF-62 / #17: all entrypoints honor cooldown then backoff, including exact boundary.
test('registration, demand and inbound routing agree on cooldown and backoff boundaries', async t => {
  for (const health of ['rate_limited', 'unavailable', 'down']) {
    const f = fixture(t), seconds = f.now() / 1000;
    const delay = health === 'down' ? 3600 : 60;
    f.set({ health, reason: health === 'rate_limited' ? 'rate_limit_unclassified' : 'runtime_unavailable' },
      { restartFailureCount: 1, lastRecoveryAt: seconds, lastDownCheckAt: seconds,
        cooldownUntil: health === 'rate_limited' ? seconds + 30 : 0 });
    let probes = 0;
    const router = new MessageRouter({ healthCoordinator: f.health, now: f.now,
      cacheDirectory: path.join(f.root, 'cache'), resolveTargetRuntime: () => 'claude',
      requestProbe: () => { probes++; } });
    const observer = new SupervisorHealthObserver({ coordinator: f.health, now: f.now });
    const request = { version: 2, type: 'route', requestId: 'gate-regression', channel: null,
      endpoint: null, componentName: null, sessionGroup: 'telegram:one', noReply: true, receivedAt: f.now() };
    assert.equal(await observer.due('claude'), false);
    assert.equal((await f.health.registerStartAttempt(f.request())).code,
      health === 'rate_limited' ? 'rate_limit_cooldown' : health === 'down' ? 'down_retry_interval' : 'attempt_backoff');
    await router.route(request); assert.equal(probes, 0);
    f.advance(delay * 1000 - 1);
    assert.equal(await observer.due('claude'), false);
    await router.route(request); assert.equal(probes, 0);
    f.advance(1);
    assert.equal(await observer.due('claude'), true);
    await router.route(request); assert.equal(probes, 1);
    registered(await f.health.registerStartAttempt(f.request()));
  }
});
