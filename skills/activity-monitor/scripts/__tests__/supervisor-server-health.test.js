import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorServerHealth,readServerProcessIdentity } from '../supervisor-server-health.js';
const failure=cause=>Object.assign(new Error('unavailable'),{code:'TMUX_UNAVAILABLE',cause});
function fixture(){
  let now=1000000,identity={present:true,pid:123,created:'99'},transition=null,generation='123:500';
  const alerts=[],kills=[];
  const guard=new SupervisorServerHealth({now:()=>now,readProcessIdentity:()=>identity,getModeTransition:()=>transition,
    readAlertTarget:()=>({channel:'fake',endpoint:'owner'}),sendAlert:(target,message)=>{alerts.push({target,message});return true;},
    signalProcess:pid=>{kills.push(pid);identity={present:false,pid};}});
  return {guard,alerts,kills,advance:ms=>now+=ms,setIdentity:v=>identity=v,setTransition:v=>transition=v,setGeneration:v=>generation=v,
    success:()=>guard.observeSuccess({readGeneration:()=>generation}),fail:(cause='timeout')=>guard.observeFailure({error:failure(cause)})};
}
test('T02 server unavailable warns once at60s and kills only cached original identity after10min',async()=>{
  const f=fixture();assert.equal((await f.success()).cached,true);await f.fail();f.advance(59999);await f.fail();assert.equal(f.alerts.length,0);
  f.advance(1);await f.fail();await f.fail();assert.equal(f.alerts.length,1);assert.equal(f.kills.length,0);
  f.advance(540000);const result=await f.fail();assert.equal(result.status,'old_server_gone');assert.equal(result.generation,'123:500');assert.deepEqual(f.kills,[123]);assert.equal(f.alerts.length,2);assert.doesNotMatch(f.alerts[1].message,/sessions? (?:have |has )?recovered/i);
});
test('T02 PID reuse is old-generation absence immediately, never permission to kill replacement',async()=>{
  const f=fixture();await f.success();f.setIdentity({present:true,pid:123,created:'100'});const result=await f.fail();assert.equal(result.status,'old_server_gone');assert.equal(result.generation,'123:500');assert.equal(f.kills.length,0);assert.equal(f.alerts.length,0);
});
test('T02 unknown identity, any non-timeout failure, and transition prevent server termination',async()=>{
  for(const condition of ['unknown','error','transition','no-cache']){
    const f=fixture();if(condition!=='no-cache')await f.success();await f.fail(condition==='error'?'error':'timeout');
    if(condition==='unknown')f.setIdentity({present:null});if(condition==='transition')f.setTransition({phase:'gating'});
    f.advance(600000);assert.equal((await f.fail()).status,'unavailable');assert.equal(f.kills.length,0);assert.equal(f.alerts.length,1);
  }
});
test('T02 successful observation resets episode and generation-race cannot cache process identity',async()=>{
  const f=fixture();await f.success();await f.fail();f.advance(60000);await f.fail();assert.equal(f.alerts.length,1);
  await f.success();await f.fail();f.advance(60000);await f.fail();assert.equal(f.alerts.length,2);
  let reads=0;const result=await f.guard.observeSuccess({socketKey:'other',readGeneration:()=>++reads===1?'123:500':'123:501'});assert.equal(result.cached,false);assert.equal(f.guard.servers.get('other').cache,null);
});
test('T02 alert fallback attempts once per episode and cached identity is rechecked inside lifecycle queue',async()=>{
  const f=fixture();await f.success();f.guard.sendAlert=async(target,message)=>{f.alerts.push({target,message});throw new Error('offline');};
  await f.fail();f.advance(60000);await f.fail();await f.fail();assert.deepEqual(f.alerts.map(x=>x.target.channel),['fake','web-console']);
  f.guard.lifecycleSerial=async operation=>{f.setIdentity({present:true,pid:123,created:'reused'});return operation();};
  f.advance(540000);assert.equal((await f.fail()).status,'old_server_gone');assert.equal(f.kills.length,0);
});
test('T02 OS identity keeps Linux starttime separate from tmux time; Darwin missing/error are distinct',async()=>{
  const fields=Array(20).fill('0');fields[0]='S';fields[19]='987654';
  assert.deepEqual(await readServerProcessIdentity(123,{platform:'linux',readFile:async()=>`123 (tmux (server)) ${fields.join(' ')}`}),{present:true,pid:123,created:'987654'});
  assert.equal((await readServerProcessIdentity(123,{platform:'linux',readFile:async()=>{throw Object.assign(new Error(),{code:'EACCES'});}})).present,null);
  assert.equal((await readServerProcessIdentity(123,{platform:'darwin',execFileAsync:async()=>({stdout:' Sun Oct 25 10:20:30 2026\n'})})).created,'Sun Oct 25 10:20:30 2026');
  assert.equal((await readServerProcessIdentity(123,{platform:'darwin',execFileAsync:async()=>{throw Object.assign(new Error(),{code:1,stderr:''});}})).present,false);
  assert.equal((await readServerProcessIdentity(123,{platform:'darwin',execFileAsync:async()=>{throw Object.assign(new Error(),{code:1,stderr:'permission denied'});}})).present,null);
});
