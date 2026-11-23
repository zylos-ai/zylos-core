import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeHealthCoordinator } from '../runtime-health.js';
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
  const options = {zylosDir:root,now:()=>clock,resolveTargetRuntime:()=> 'claude',
    listScenes:()=>scenes,probeInFlight:()=>probe,readNegativeCache:()=>cache,clearNegativeCache:()=>{cache=null;}};
  const health = new RuntimeHealthCoordinator(options);
  const state = health.store('claude').read(); state.health = 'unavailable'; state.reason='runtime_unavailable'; health.store('claude').write(state);
  return {root,health,options,now:()=>clock,advance:ms=>clock+=ms,setScene:v=>scenes=v,setProbe:v=>probe=v,setCache:v=>cache=v,
    request:(extra={})=>({version:1,type:'start_attempt',requestId:`sa-${clock}-123456789abc`,runtime:'claude',sessionGroup:'telegram:one',runId:randomUUID(),...extra}),
    read:()=>health.store('claude').read(),set:(patch,budget={})=>{const s=health.store('claude').read();Object.assign(s,patch);Object.assign(s.scheduling,budget);health.store('claude').write(s);}};
}

// A/B: all ordered decisions and response field relationships.
test('start registration validates request and evaluates restrictions in order',async t=>{
  const f=fixture(t);
  for(const change of [{version:2},{requestId:'bad'},{runtime:'BAD'},{runId:'bad'},{sessionGroup:'*'},{sessionGroup:null}]) assert.equal((await f.health.registerStartAttempt(f.request(change))).code,'invalid_request');
  f.set({health:'ok'});f.setScene([{runtime:'claude'}]);f.setProbe(true);
  assert.equal((await f.health.registerStartAttempt(f.request())).result,'not_restricted');
  f.set({health:'auth_failed'});assert.equal((await f.health.registerStartAttempt(f.request())).code,'auth_blocked');
  f.set({health:'rate_limited',reason:'rate_limit_unclassified'},{cooldownUntil:f.now()/1000+500});
  assert.equal((await f.health.registerStartAttempt(f.request())).code,'scene_present');
  f.setScene([]);assert.deepEqual((await f.health.registerStartAttempt(f.request())).code,'probe_inflight');
  assert.equal(Object.hasOwn(await f.health.registerStartAttempt(f.request()),'notBefore'),false);
  f.setProbe(false);assert.equal((await f.health.registerStartAttempt(f.request())).notBefore,f.now()+500000);
  f.set({}, {cooldownUntil:0});f.setCache({version:2,recovered:false,runtime:'claude',health:'rate_limited',reason:'rate_limit_unclassified',expiresAt:f.now()+30000});
  assert.equal((await f.health.registerStartAttempt(f.request())).code,'probe_cache');
  f.setCache(null);const answer=await f.health.registerStartAttempt(f.request());
  registered(answer);assert.deepEqual(scheduling(f.read()),[1,f.now()/1000,0]);
  assert.equal(Object.hasOwn(answer,'code'),false);assert.equal(Object.hasOwn(answer,'notBefore'),false);
  assert.equal((await f.health.registerStartAttempt(f.request())).code,'attempt_backoff');
});

test('concurrent same-runtime requests commit exactly one attempt and reopen preserves backoff',async t=>{
  const f=fixture(t), first=f.request(), second=f.request({sessionGroup:'lark:two'});
  const replies=await Promise.all([f.health.registerStartAttempt(first),f.health.registerStartAttempt(second)]);
  assert.equal(replies.filter(r=>r.result==='registered').length,1);assert.equal(f.read().scheduling.restartFailureCount,1);
  const restarted=new RuntimeHealthCoordinator(f.options);
  assert.equal((await restarted.registerStartAttempt(f.request())).code,'attempt_backoff');
  f.advance(60000);registered(await restarted.registerStartAttempt(f.request()));
  assert.deepEqual(scheduling(f.read()),[2,f.now()/1000,0]);
  assert.equal((await restarted.registerStartAttempt(f.request())).notBefore,f.now()+300000);
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

// #17: all entrypoints honor cooldown then backoff, including exact boundary.
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
