import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {fixture,count,responses,launches,registeredBeforeLaunch,T} from './fixtures/i2-if63-harness.js';
test('IF63 ①⑫ transient registered run preserves attempt budget between M4 scans',{timeout:30000},async t=>{
 const f=await fixture(t);await f.add();const live=await f.launched();registeredBeforeLaunch(f);assert.equal(count(await f.health()),1);
 for(let i=0;i<3;i++)await f.round();await f.killRun();const beforeExitScan=(await f.health()).scheduling;await f.m4.call('scan');assert.deepEqual((await f.health()).scheduling,beforeExitScan);await f.m1.call('fence',{group:'origin'});await f.round();await f.add();await f.time(f.clock+1000);await f.attempt();
 assert.equal(count(await f.health()),1);assert.equal(launches(f).length,1);assert.equal(responses(f).at(-1).response.code,'attempt_backoff');
});
test('IF63 ② two pending groups share one registered attempt',{timeout:30000},async t=>{const f=await fixture(t);await f.add('a');await f.add('b');await f.attempt();assert.equal(responses(f).filter(x=>x.response.result==='registered').length,1);assert.equal(launches(f).length,1);assert.equal(launches(f)[0].input.runId,responses(f)[0].request.runId);registeredBeforeLaunch(f)});
test('IF63 ③ absent M4 socket prevents restricted ordinary launch',{timeout:30000},async t=>{const f=await fixture(t);await f.m4.call('stop');assert.equal(fs.existsSync(path.join(f.root,'activity-monitor/am.sock')),false);await f.add();await f.attempt();assert.equal(launches(f).length,0);assert.equal(f.trace('m1','request').length,1)});
for(const scenario of ['4a','4a-invalid','4a-no-reply','4b','4d','5','6','7','8','9'])test('IF63 '+scenario+' persisted grant survives transport/process/fence interruption',{timeout:30000},async t=>{
 const f=await fixture(t);await f.m4.call('fault',{value:scenario==='4a-no-reply'?'no-reply':scenario==='4a-invalid'?'invalid':scenario==='9'||scenario==='6'?'':'hold'});
 if(scenario==='6')await f.m1.call('fault',{value:'pause-grant'});
 if(scenario==='9')await f.m1.call('fault',{value:'fence-grant'});
 await f.add();const first=f.attempt();first.catch(()=>{});
 for(let i=0;i<100&&!responses(f).length;i++)await delay(10);
 assert.equal(responses(f)[0]?.response.result,'registered');
 if(scenario==='5')await f.m4.kill();
 if(scenario==='6'){for(let i=0;i<100&&!f.trace('m1','reply').some(x=>x.result.kind==='accepted');i++)await delay(10);assert.equal(f.trace('m1','reply').at(-1)?.result.kind,'accepted');await f.m1.kill()}else await first;
 if(scenario==='4a-no-reply')assert.equal(f.trace('m1','reply').at(-1).result.kind,'no_reply');
 if(scenario==='4a-invalid')assert.equal(f.trace('m1','reply').at(-1).result.kind,'invalid_reply');
 assert.equal(launches(f).length,0);assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'activity-monitor/runtime-health/claude.json'))).restartFailureCount,1);
 if(['5','8'].includes(scenario)){if(scenario==='8')await f.m4.kill();f.m4=await f.start('m4');await f.m1.call('fence',{group:'origin'})}
 else await f.m4.call('release');
 if(['6','7'].includes(scenario)){if(scenario==='7')await f.m1.kill();f.m1=await f.start('m1');await f.warm()}
 if(scenario==='9'){await f.m1.call('fault',{value:''});await f.m1.call('unfence',{group:'chat'})}
 await f.m4.call('fault',{value:''});
 if(scenario==='4d'){await delay(50);assert.equal(launches(f).length,0)}
 if(scenario==='4b'){await f.time(f.clock+60000);await f.launched();assert.equal(count(await f.health()),2);assert.ok(responses(f).at(-1).clock-responses(f)[0].clock>=60000);registeredBeforeLaunch(f)}
 else {const beforeRetry=await f.health();const requestCount=f.trace('m1','request').length;await f.attempt();assert.equal(f.trace('m1','request').length,requestCount+1);assert.deepEqual((await f.health()).scheduling,beforeRetry.scheduling);const previous=responses(f)[0].request,next=responses(f).at(-1).request;assert.notEqual(previous.requestId,next.requestId);assert.notEqual(previous.runId,next.runId);assert.equal(launches(f).length,0,JSON.stringify({m1:f.trace('m1'),m4:f.trace('m4')}));assert.equal(count(await f.health()),1);assert.equal(responses(f).at(-1).response.code,'attempt_backoff')}
});
for(const kind of ['unavailable','rate_limited','down'])test(`IF63 ⑰ ${kind} real incoming route accelerates before prior notBefore`,{timeout:30000},async t=>{
 const f=await fixture(t,{health:kind,budget:{restartFailureCount:3,lastRecoveryAt:T/1000,lastDownCheckAt:T/1000,cooldownUntil:kind==='rate_limited'?T/1000+3600:0}});
 await f.add();await f.attempt();const old=responses(f).at(-1).response;assert.ok(old.notBefore>f.clock);
 await f.time(f.clock+1000);const route=await f.m4.call('message');assert.ok(route);await f.attempt();
 const reply=responses(f).at(-1).response;assert.equal(reply.result,'registered',JSON.stringify({reply,route,health:await f.health()}));assert.equal(reply.reason,'user_message');assert.ok(f.clock<old.notBefore);
 const state=await f.health();assert.equal(state.health,kind);assert.equal(count(state),kind==='unavailable'?1:kind==='rate_limited'?4:3);
 if(kind==='rate_limited')assert.equal(state.scheduling.cooldownUntil,0);
 if(kind==='down')assert.equal(state.scheduling.lastDownCheckAt,f.clock/1000);
 await f.launched();registeredBeforeLaunch(f);
});
test('IF63 ⑰a′ without incoming message early next round preserves F10 bytes',{timeout:30000},async t=>{
 const f=await fixture(t,{budget:{restartFailureCount:3,lastRecoveryAt:T/1000}});await f.add();await f.attempt();const first=responses(f).at(-1);
 const file=path.join(f.root,'activity-monitor/runtime-health/claude.json'),before=fs.readFileSync(file,'utf8');await f.time(f.clock+1000);await f.attempt();const second=responses(f).at(-1);
 assert.equal(second.response.code,'attempt_backoff');assert.ok(second.clock<first.response.notBefore);assert.notEqual(first.request.requestId,second.request.requestId);assert.notEqual(first.request.runId,second.request.runId);assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(launches(f).length,0);
});
for(const mode of ['healthy','origin','single'])test(`IF63 ⑪ ${mode} bypasses start_attempt`,{timeout:30000},async t=>{
 const f=await fixture(t,{mode:mode==='single'?'single':'multi'});
 if(mode==='healthy'){await f.m4.call('seed',{runtime:'codex',health:'ok'});await f.add();await f.m1.call('runtime',{group:'chat',runtime:'codex'});await f.launched()}
 else if(mode==='origin'){await f.m1.call('unfence',{group:'origin'});await f.launched('origin')}
 else await f.launched(null);
 assert.equal(f.trace('m1','request').length,0);assert.ok(launches(f).length>0);
});
for(const stale of [false,true])test(`IF63 ⑬${stale?'b':''} bound other ${stale?'after stale ':''}does not recount; Origin does`,{timeout:30000},async t=>{
 const f=await fixture(t);await f.add();const live=await f.launched();const before=await f.health();assert.equal(count(before),1);
 if(stale){await f.time(f.clock+1000);assert.equal((await f.m4.call('probe',{group:'chat',terminal:'STALE_TARGET'})).classification,'stale');assert.equal(count(await f.health()),1)}
 await f.time(f.clock+1000);assert.equal((await f.m4.call('probe',{group:'chat'})).classification,'other');let state=await f.health();assert.equal(count(state),1);assert.equal(state.scheduling.lastRecoveryAt,f.clock/1000);assert.equal(state.health,'unavailable');
 await f.m1.call('unfence',{group:'origin'});await f.launched('origin');await f.time(f.clock+1000);assert.equal((await f.m4.call('probe',{group:'origin'})).classification,'other');state=await f.health();assert.equal(count(state),2);assert.equal(state.scheduling.lastRecoveryAt,f.clock/1000);registeredBeforeLaunch(f);assert.equal(live.runId,responses(f)[0].request.runId);
});
test('IF63 ⑭ replacement run binds only the new registration',{timeout:30000},async t=>{
 const f=await fixture(t);await f.add();const old=await f.launched();await f.killRun();await f.round();await f.time(f.clock+60000);await f.add();const current=await f.launched();assert.notEqual(old.runId,current.runId);assert.equal(count(await f.health()),2);
 await f.time(f.clock+1000);await f.m4.call('probe',{group:'chat'});assert.equal(count(await f.health()),2);assert.equal(responses(f).at(-1).request.runId,current.runId);registeredBeforeLaunch(f);
});
test('IF63 ⑮ restart before probe conservatively counts once per lost association',{timeout:30000},async t=>{
 const f=await fixture(t);await f.add();let live=await f.launched();
 for(let cycle=0;cycle<2;cycle++){
  const before=count(await f.health());await f.m4.kill();f.m4=await f.start('m4');await f.m1.call('fence',{group:'origin'});await f.time(f.clock+1000);await f.m4.call('probe',{group:'chat'});const state=await f.health();assert.equal(count(state),before+1);
  await f.killRun();await f.round();await f.add();await f.attempt();assert.equal(responses(f).at(-1).response.code,'attempt_backoff');assert.equal(count(await f.health()),before+1);
  if(cycle===0){await f.time(f.clock+300000);live=await f.launched();assert.equal(count(await f.health()),before+2)}
 }
});
test('IF63 ⑯ same-group different run does not consume lost-reply association',{timeout:30000},async t=>{
 const f=await fixture(t);await f.m4.call('fault',{value:'hold'});await f.add();await f.attempt();const r1=responses(f)[0].request.runId;assert.equal(launches(f).length,0);await f.m4.call('release');await f.m4.call('fault',{value:''});
 await f.m1.call('fence',{group:'chat'});await f.m1.call('unfence',{group:'origin'});await f.launched('origin');const beforeR2=f.trace('m1','request').length;await f.m1.call('unfence',{group:'chat'});const current=await f.launched();assert.notEqual(current.runId,r1);assert.equal(f.trace('m1','request').length,beforeR2);
 const requests=responses(f).length;await f.killRun('origin');await f.m1.call('fence',{group:'origin'});await f.time(f.clock+1000);await f.m4.call('probe',{group:'chat'});assertUnlinkedCount(await f.health());assert.equal(responses(f).length,requests);assert.equal(responses(f).filter(x=>x.response.result==='registered').length,1);
});
test('IF63 ④c⑩ incoming message during uncertainty accelerates once per 60 seconds',{timeout:30000},async t=>{
 const f=await fixture(t);await f.m4.call('fault',{value:'hold'});await f.add();await f.attempt();assert.equal(count(await f.health()),1);assert.equal(launches(f).length,0);
 await f.time(f.clock+1000);await f.m4.call('message');await f.attempt();const accelerated=responses(f).at(-1);assert.equal(accelerated.response.result,'registered');assert.equal(accelerated.response.reason,'user_message');assert.equal(count(await f.health()),1);assert.equal((await f.health()).health,'unavailable');
 await f.time(f.clock+1000);await f.m4.call('message');await f.attempt();assert.equal(responses(f).at(-1).response.code,'attempt_backoff');assert.equal(count(await f.health()),1);assert.equal((await f.health()).scheduling.lastUserMessageRecoveryAt,accelerated.clock/1000);
 await f.m4.call('release');assert.equal(launches(f).length,0);assert.equal(f.trace('m1','request').length,3);
});
function assertBudgetRejected(reply,before,after){assert.equal(reply.code,'attempt_backoff');assert.deepEqual(after.scheduling,before.scheduling)}
test('IF63 negative control: removing backoff fails the unchanged rejection oracle',{timeout:30000},async t=>{
 const f=await fixture(t,{budget:{restartFailureCount:3,lastRecoveryAt:T/1000}});await f.add();const before=await f.health();await f.attempt();assertBudgetRejected(responses(f).at(-1).response,before,await f.health());
 await f.m4.call('fault',{value:'bad-backoff'});await f.attempt();assert.throws(()=>assertBudgetRejected(responses(f).at(-1).response,before,responses(f).at(-1).health),{code:'ERR_ASSERTION'});
});
function assertUnlinkedCount(state){assert.equal(count(state),2)}
test('IF63 negative control: group-only association fails the same runId counter oracle',{timeout:30000},async t=>{
 const f=await fixture(t);await f.m4.call('fault',{value:'hold'});await f.add();await f.attempt();await f.m4.call('release');await f.m4.call('fault',{value:''});
 await f.m1.call('fence',{group:'chat'});await f.m1.call('unfence',{group:'origin'});await f.launched('origin');await f.m1.call('unfence',{group:'chat'});await f.launched();await f.killRun('origin');await f.m1.call('fence',{group:'origin'});
 await f.m4.call('fault',{value:'bad-group-link'});await f.time(f.clock+1000);await f.m4.call('probe',{group:'chat'});const state=await f.health();assert.equal(count(state),1);assert.throws(()=>assertUnlinkedCount(state),{code:'ERR_ASSERTION'});
});
test('IF63 ⑪ concurrent healthy runtime and Origin launch while restricted group is backoff blocked',{timeout:30000},async t=>{
 const f=await fixture(t,{budget:{restartFailureCount:3,lastRecoveryAt:T/1000}});await f.add('blocked');await f.attempt();assert.equal(responses(f).at(-1).response.code,'attempt_backoff');
 await f.m1.call('fence',{group:'blocked'});await f.m4.call('seed',{runtime:'codex',health:'ok'});await f.add('healthy');await f.m1.call('runtime',{group:'healthy',runtime:'codex'});await f.m1.call('unfence',{group:'origin'});
 await f.launched('healthy');await f.launched('origin');assert.deepEqual(new Set(launches(f).map(x=>x.input.sessionGroup)),new Set(['healthy','origin']));assert.ok(f.trace('m1','request').every(x=>x.request.sessionGroup==='blocked'));assert.equal(count(await f.health()),3);
});
