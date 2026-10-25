import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorLoop } from '../supervisor-loop.js';
function fixture(overrides={}) {
 const calls=[],timers=[]; const rec=n=>async()=>{calls.push(n);};
 const deps={readConfiguration:async()=>({mode:'multi'}),restore:rec('restore'),openAdmission:rec('open'),reportError:async(e,d)=>calls.push(`error:${d.phase}`),getModeTransition:async()=>null,listDrainFences:async()=>[],readRestartRequests:async()=>[],lifecycleSerial:fn=>fn(),advanceTransition:rec('transition'),advanceManual:rec('manual'),advanceRestarts:rec('restarts'),reconcileConfiguration:rec('config'),observe:async()=>{calls.push('observe');return [{sessionGroup:'origin'},{sessionGroup:'tg:one'}];},observeExits:rec('exits'),probeAndPublish:async s=>calls.push(`probe:${s.sessionGroup}`),advanceReclaim:rec('reclaim'),checkRotation:rec('rotation'),checkTtl:rec('ttl'),checkEviction:rec('evict'),checkSync:rec('sync'),writeMetricsAndMaintain:rec('metrics'),...overrides};
 return {calls,timers,deps,loop:new SupervisorLoop(deps,{schedule:(fn,ms)=>{timers.push({fn,ms});return timers.length;},cancel:()=>{}})};
}
// P05 T01 / supervisor-startup: configuration corruption cannot become single.
test('bad F1 does not open admission or schedule',async()=>{const f=fixture({readConfiguration:async()=>{throw new Error('CONFIG_UNREADABLE');}});await f.loop.start();await f.loop.tick();assert.deepEqual(f.calls,['error:configuration']);assert.equal(f.timers.length,0);await f.loop.stop();});
// P05 T01 / supervisor-loop: fixed stages and fresh capacity after reclaim.
test('restore precedes admission and lifecycle shares one scene sample',async()=>{const f=fixture({listDrainFences:async()=>[{sessionGroup:'tg:one'}]});await f.loop.start();assert.deepEqual(f.calls,['restore','open','observe','manual','restarts','config','exits','probe:origin','probe:tg:one','reclaim','rotation','rotation','ttl','ttl','evict','sync','metrics']);assert.equal(f.timers[0].ms,1000);await f.loop.stop();});
// P05 T01: one group failure does not starve another.
test('group failure preserves other observations and next tick',async()=>{const f=fixture();f.deps.probeAndPublish=async s=>{if(s.sessionGroup==='origin')throw new Error('unobservable');f.calls.push('second');};await f.loop.start();assert.ok(f.calls.includes('error:observe'));assert.ok(f.calls.includes('second'));assert.equal(f.timers.length,1);await f.loop.stop();});
// P05 T01: D9 permits observations and existing reclaim only.
test('transition suppresses new lifecycle producers',async()=>{const f=fixture({getModeTransition:async()=>({id:'switch'}),listDrainFences:async()=>[{sessionGroup:'tg:one'}]});await f.loop.start();assert.deepEqual(f.calls,['restore','open','transition','observe','exits','probe:origin','probe:tg:one','reclaim','metrics']);await f.loop.stop();});
// P05 T01: no overlap; failed authoritative reads cannot become empty.
test('overlap joins one round and read failure schedules recovery',async()=>{let release;const gate=new Promise(r=>release=r);let reads=0;const f=fixture({getModeTransition:async()=>{reads++;await gate;throw new Error('DB_BUSY');}});const first=f.loop.start();await new Promise(r=>setImmediate(r));const second=f.loop.tick();release();await Promise.all([first,second]);assert.equal(reads,1);assert.deepEqual(f.calls,['restore','open','error:round']);assert.equal(f.timers.length,1);await f.loop.stop();});

// Real hook notifications can tick between timers; they must replace the timer.
test('T01 hook wakeups keep one timer and deferred server maintenance runs on failed observations',async()=>{
 let maintenance=0;const cancelled=[];
 const f=fixture({afterRound:async()=>{maintenance++;}});f.loop.cancel=id=>cancelled.push(id);
 await f.loop.start();await f.loop.tick();assert.deepEqual(cancelled,[1]);assert.equal(maintenance,2);
 f.deps.observe=async()=>{throw new Error('TMUX_UNAVAILABLE');};await f.loop.tick();assert.equal(maintenance,3);
 assert.ok(f.calls.includes('error:round'));await f.loop.stop();assert.deepEqual(cancelled,[1,2,3]);
});

test('T01 missing pool/Sync dependencies preserve independent metrics and observation work',async()=>{
 const unavailable=async()=>{throw Object.assign(new Error('dependency absent'),{code:'DEPENDENCY_UNAVAILABLE'});};
 const f=fixture({checkEviction:unavailable,checkSync:unavailable,checkManualFences:unavailable});await f.loop.start();
 assert.ok(f.calls.includes('error:manual-fences'));assert.ok(f.calls.includes('probe:origin'));
 assert.ok(f.calls.includes('error:eviction'));assert.ok(f.calls.includes('error:sync'));assert.ok(f.calls.includes('metrics'));await f.loop.stop();
});

test('T01/P10 F1 cutover refreshes mode before lifecycle actions; unreadable F1 does not reuse stale mode',async()=>{
 let mode='single',bad=false;const f=fixture({readConfiguration:async()=>{if(bad)throw new Error('CONFIG_UNREADABLE');return {mode};}});
 await f.loop.start();assert.equal(f.calls.includes('ttl'),false);f.calls.length=0;
 mode='multi';await f.loop.tick();assert.ok(f.calls.includes('ttl'));assert.ok(f.calls.includes('evict'));f.calls.length=0;
 bad=true;await f.loop.tick();assert.deepEqual(f.calls,['error:round']);f.calls.length=0;
 bad=false;mode='single';await f.loop.tick();assert.equal(f.calls.includes('ttl'),false);assert.ok(f.calls.includes('metrics'));await f.loop.stop();
});

// B2/B6: one round samples scenes and admission authorities once; transition owns its own serialization.
test('round shares one serialized snapshot and checks manual fences once', async () => {
  let locked = false;
  const counts = { configuration: 0, transition: 0, fences: 0, requests: 0, scenes: 0, manual: 0 };
  const scenes = [{ sessionGroup: 'origin' }, { sessionGroup: 'group' }];
  const fences = [], requests = [], contexts = [];
  const read = (name, value) => async () => { assert.equal(locked, true); counts[name]++; return value; };
  const phase = async context => { assert.equal(locked, true); contexts.push(context); };
  const f = fixture({
    lifecycleSerial: async action => { assert.equal(locked, false); locked = true; try { return await action(); } finally { locked = false; } },
    readConfiguration: read('configuration', { mode: 'multi' }), getModeTransition: async () => { assert.equal(locked, false); counts.transition++; return null; },
    listDrainFences: read('fences', fences), readRestartRequests: read('requests', requests), observe: read('scenes', scenes),
    checkManualFences: async context => { counts.manual++; await phase(context); return []; },
    advanceManual: phase, advanceRestarts: phase, reconcileConfiguration: phase,
    checkRotation: async (scene, context) => { assert.ok(scenes.includes(scene)); await phase(context); },
    checkTtl: async (scene, context) => { assert.ok(scenes.includes(scene)); await phase(context); },
    checkEviction: async (sample, context) => { assert.equal(sample, scenes); await phase(context); },
    checkSync: async (sample, context) => { assert.equal(sample, scenes); await phase(context); },
    probeAndPublish: async (scene, context) => { assert.equal(locked, false); assert.ok(scenes.includes(scene)); contexts.push(context); },
    writeMetricsAndMaintain: async context => { assert.equal(locked, false); contexts.push(context); },
  });
  await f.loop.runRound();
  assert.deepEqual(counts, { configuration: 1, transition: 1, fences: 1, requests: 1, scenes: 1, manual: 1 });
  assert.ok(contexts.every(context => context === contexts[0]));
  assert.equal(contexts[0].scenes, scenes); assert.equal(contexts[0].fences, fences); assert.equal(contexts[0].restartRequests, requests);
});

// DM54: corrupt intent is not an empty queue and must not strand durable D8 work.
test('unreadable F9 is reported while the same snapshot still advances existing reclaim', async () => {
  const failure = Object.assign(new Error('corrupt F9'), { code: 'REQUESTS_UNREADABLE' });
  let observed;
  const f = fixture({ readRestartRequests: async () => { throw failure; },
    listDrainFences: async () => [{ sessionGroup: 'group', reason: 'upgrade', runId: 'run' }],
    advanceReclaim: async (fence, context) => { observed = context; f.calls.push('reclaim'); },
  });
  await f.loop.start();
  assert.equal(observed.restartRequestsError, failure);
  assert.deepEqual(observed.restartRequests, []);
  assert.ok(f.calls.includes('error:restart-requests')); assert.ok(f.calls.includes('reclaim')); assert.ok(f.calls.includes('metrics'));
  await f.loop.stop();
});

// P3-2: a transition present at step 1 restricts this whole round even after completion.
test('completed transition precedes serial work and keeps transition-round restrictions', async () => {
  let transition = { id: 'switch' }, mode = 'multi', locked = false;
  const f = fixture({
    getModeTransition: async () => { assert.equal(locked, false); return transition; },
    advanceTransition: async () => { assert.equal(locked, false); f.calls.push('transition'); transition = null; mode = 'single'; },
    readConfiguration: async () => ({ mode }),
    listDrainFences: async () => [{ sessionGroup: 'tg:one' }],
    advanceReclaim: async (fence, context) => { context.transition = null; f.calls.push('reclaim'); },
    lifecycleSerial: async action => { locked = true; try { return await action(); } finally { locked = false; } },
  });
  await f.loop.start();
  assert.ok(f.calls.indexOf('transition') < f.calls.indexOf('observe'));
  assert.ok(f.calls.indexOf('probe:origin') < f.calls.indexOf('reclaim'));
  for (const phase of ['manual','restarts','config','rotation','ttl','evict','sync']) assert.equal(f.calls.includes(phase), false, phase);
  assert.equal(f.loop.configuration.mode, 'single');
  await f.loop.stop();
});
