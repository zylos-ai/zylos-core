import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestRuntimeRestart } from '../request-runtime-restart.js';

const base={now:()=>100,deadlineAt:1000,requestId:'producer',readMode:()=>({mode:'multi'}),readTransition:()=>null,
  enqueueExit:()=>{throw new Error('wrong fallback');}};
test('IB-40 producer uses supervisor in multi and transition, single exit only in steady single',async()=>{
  const sent=[];const send=async(...args)=>{sent.push(args);return {kind:'accepted',sent:true,reply:{result:'accepted',runCount:3}};};
  for(const [mode,transition] of [['multi',null],['single',{phase:'gating'}]]) {
    const result=await requestRuntimeRestart({...base,readMode:()=>({mode}),readTransition:()=>transition,send});assert.equal(result.data.runCount,3);
  }
  assert.equal(sent.length,2);assert.deepEqual(sent[0],[{version:1,type:'restart_all',requestId:'producer',reason:'upgrade'},{deadlineAt:1000}]);
  let exits=0;const single=await requestRuntimeRestart({...base,readMode:()=>({mode:'single'}),send:()=>{throw new Error('must not send');},enqueueExit:()=>{exits++;return 'control 1';}});
  assert.equal(exits,1);assert.equal(single.data.result,'exit_enqueued');
});
test('IB-43 producer never retries explicit refusal, connect failure or U; lookup reports facts only',async()=>{
  for(const kind of ['rejected','connect_failed','no_reply','invalid_reply','timeout','deadline_exceeded']) {
    for(const observation of ['accepted','done','unknown']) {
      let sends=0,lookups=0;const connected=!['connect_failed'].includes(kind);
      const result=await requestRuntimeRestart({...base,send:async()=>{sends++;return {kind,sent:connected,...(kind==='rejected'?{reply:{code:'entry_not_open'}}:{})};},lookup:async(id,options)=>{lookups++;assert.equal(id,'producer');assert.equal(options.deadlineAt,1000);return observation;}});
      assert.equal(sends,1);const uncertain=!['rejected','connect_failed'].includes(kind);assert.equal(lookups,uncertain?1:0);
      if(uncertain && observation!=='unknown'){assert.equal(result.ok,true);assert.equal(result.data.result,observation);}
      else {assert.equal(result.ok,false);assert.deepEqual(result.error.persisted,uncertain?null:[]);}
    }
  }
});
test('IB-40 producer does not downgrade transition races or invalid config to single exit',async()=>{
  await assert.rejects(requestRuntimeRestart({...base,readMode:()=>{throw Object.assign(new Error('config'),{code:'CONFIG_UNREADABLE'});}}),{code:'CONFIG_UNREADABLE'});
  await assert.rejects(requestRuntimeRestart({...base,readMode:()=>({mode:'single'}),enqueueExit:()=>{throw Object.assign(new Error('gate'),{code:'TRANSITION_OPEN'});}}),{code:'TRANSITION_OPEN'});
  let reads=0;const expired=await requestRuntimeRestart({...base,now:()=>1000,readMode:()=>{reads++;}});assert.equal(expired.error.code,'deadline_exceeded');assert.equal(reads,0);
});
