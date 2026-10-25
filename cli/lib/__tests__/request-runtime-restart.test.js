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

test('M4 upgrade submission retries only connects with a 30s total budget and 1s spacing',async()=>{
  for (const afterServiceRestart of [false,true]) {
    let options;
    const result=await requestRuntimeRestart({...base,deadlineAt:undefined,afterServiceRestart,
      send:async(_request,received)=>{options=received;return {kind:'connect_failed',sent:false};}});
    assert.deepEqual(options,afterServiceRestart ? {deadlineAt:30100,connectRetryEveryMs:1000} : {deadlineAt:10100});
    assert.equal(result.ok,false);
    if(afterServiceRestart) assert.match(result.error.message,/All currently running managed sessions, including Origin, need manual restart/);
  }
});

test('M4 upgrade total budget respects an earlier deadline and never exceeds 30 seconds',async()=>{
  for(const [deadlineAt,expected] of [[500,500],[100000,30100]]) {
    let deadline;
    await requestRuntimeRestart({...base,afterServiceRestart:true,deadlineAt,
      send:async(_request,options)=>{deadline=options.deadlineAt;return {kind:'connect_failed',sent:false};}});
    assert.equal(deadline,expected);
  }
});

test('M4 upgrade retries never repeat a connected uncertain or refused request',async()=>{
  for(const kind of ['rejected','no_reply','invalid_reply','timeout']) {
    let sends=0,lookups=0;
    const result=await requestRuntimeRestart({...base,afterServiceRestart:true,
      send:async()=>{sends++;return {kind,sent:true,reply:{code:'entry_not_open'}};},
      lookup:async()=>{lookups++;return 'unknown';}});
    assert.equal(sends,1);assert.equal(lookups,kind==='rejected'?0:1);assert.equal(result.ok,false);
    if(kind!=='rejected') {
      assert.equal(result.error.persisted,null);assert.match(result.error.message,/do not resubmit automatically/);
      assert.doesNotMatch(result.error.message,/need manual restart/);
    }
  }
});

test('M4 post-upgrade submission reaches a real socket that starts listening after initial connect failure',{timeout:5000},async t=>{
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),net=await import('node:net');
  const {submit}=await import('../am-sock-client.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-retry-')),socketPath=path.join(root,'am.sock');
  let connections=0,attempts=0;const requests=[],peers=new Set();
  const server=net.createServer(socket=>{connections++;peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>{});
    let buffer='';socket.on('data',chunk=>{buffer+=chunk;if(!buffer.includes('\n'))return;
      const request=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));requests.push(request);
      socket.end(JSON.stringify({version:1,type:request.type,requestId:request.requestId,ok:true,result:'accepted',runCount:2})+'\n');
    });
  });
  t.after(async()=>{for(const peer of peers)peer.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  const result=await requestRuntimeRestart({readMode:()=>({mode:'multi'}),readTransition:()=>null,afterServiceRestart:true,
    requestId:'delayed-upgrade',send:(request,options)=>submit(request,{...options,socketPath,connect:opts=>{
      attempts++;const socket=net.createConnection(opts);
      // Start the listener only after the first connection has actually failed.
      if(attempts===1)socket.once('error',()=>server.listen(socketPath));
      return socket;
    }})});
  assert.equal(result.ok,true);assert.equal(result.data.runCount,2);assert.equal(attempts,2);
  assert.equal(connections,1);assert.equal(requests.length,1);assert.equal(requests[0].requestId,'delayed-upgrade');
});
