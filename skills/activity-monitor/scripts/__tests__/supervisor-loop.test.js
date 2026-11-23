import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorLoop } from '../supervisor-loop.js';
function fixture(overrides={}) {
 const calls=[],timers=[]; const rec=n=>async()=>{calls.push(n);};
 const deps={readConfiguration:async()=>({mode:'multi'}),restore:rec('restore'),openAdmission:rec('open'),reportError:async(e,d)=>calls.push(`error:${d.phase}`),getModeTransition:async()=>null,listDrainFences:async()=>[],readRestartRequests:async()=>[],lifecycleSerial:fn=>fn(),advanceTransition:rec('transition'),advanceManual:rec('manual'),advanceRestarts:rec('restarts'),observe:async()=>{calls.push('observe');return [{sessionGroup:'origin'},{sessionGroup:'tg:one'}];},observeExits:rec('exits'),probeAndPublish:async s=>calls.push(`probe:${s.sessionGroup}`),advanceReclaim:rec('reclaim'),checkRotation:rec('rotation'),checkTtl:rec('ttl'),checkEviction:rec('evict'),checkSync:rec('sync'),writeMetricsAndMaintain:rec('metrics'),...overrides};
 return {calls,timers,deps,loop:new SupervisorLoop(deps,{schedule:(fn,ms)=>{timers.push({fn,ms});return timers.length;},cancel:()=>{}})};
}

// supervisor-loop: fixed stages and fresh capacity after reclaim.
test('restore precedes admission and lifecycle shares one scene sample',async()=>{const f=fixture({listDrainFences:async()=>[{sessionGroup:'tg:one'}]});await f.loop.start();assert.deepEqual(f.calls,['restore','open','observe','manual','restarts','exits','probe:origin','probe:tg:one','reclaim','rotation','rotation','ttl','ttl','evict','sync','metrics']);assert.equal(f.timers[0].ms,1000);await f.loop.stop();});
// one group failure does not starve another.
test('group failure preserves other observations and next tick',async()=>{const f=fixture();f.deps.probeAndPublish=async s=>{if(s.sessionGroup==='origin')throw new Error('unobservable');f.calls.push('second');};await f.loop.start();assert.ok(f.calls.includes('error:observe'));assert.ok(f.calls.includes('second'));assert.equal(f.timers.length,1);await f.loop.stop();});
// permits observations and existing reclaim only.
test('transition suppresses new lifecycle producers',async()=>{const f=fixture({getModeTransition:async()=>({id:'switch'}),listDrainFences:async()=>[{sessionGroup:'tg:one'}]});await f.loop.start();assert.deepEqual(f.calls,['restore','open','transition','observe','exits','probe:origin','probe:tg:one','reclaim','metrics']);await f.loop.stop();});

// supplemental each isolated stage failure must preserve a next round.
test('every loop step exception reports its phase and schedules the next round',async t=>{
 for(const [method,phase] of Object.entries({
  getModeTransition:'round',readConfiguration:'round',listDrainFences:'round',readRestartRequests:'restart-requests',
  observe:'round',checkManualFences:'manual-fences',advanceManual:'advanceManual',advanceRestarts:'advanceRestarts',
  observeExits:'round',probeAndPublish:'observe',updateCapacity:'capacity',advanceReclaim:'reclaim',
  checkRotation:'rotation',checkTtl:'ttl',checkEviction:'eviction',checkSync:'sync',writeMetricsAndMaintain:'round',afterRound:'after-round',
 })) await t.test(method,async()=>{
  const f=fixture({listDrainFences:async()=>[{sessionGroup:'origin'},{sessionGroup:'tg:one'}]});
  await f.loop.start();f.calls.length=0;const original=f.deps[method];
  f.deps[method]=async()=>{throw new Error(`injected ${method}`);};
  await f.loop.tick();assert.ok(f.calls.includes(`error:${phase}`));assert.equal(f.timers.length,2);
  if(['probeAndPublish','advanceReclaim','checkRotation','checkTtl'].includes(method))assert.equal(f.calls.filter(v=>v===`error:${phase}`).length,2);
  f.deps[method]=original;f.calls.length=0;await f.loop.tick();
  assert.ok(f.calls.includes('metrics'));assert.equal(f.timers.length,3);await f.loop.stop();
 });
});

