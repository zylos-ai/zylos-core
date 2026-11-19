import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestRuntimeRestart } from '../request-runtime-restart.js';

const base={now:()=>100,deadlineAt:1000,requestId:'producer',readMode:()=>({mode:'multi'}),readTransition:()=>null,
  enqueueExit:()=>{throw new Error('wrong fallback');}};
test('the restart producer submits one restart_all and returns an empty completion', async () => {
  let submits = 0;
  const result = await requestRuntimeRestart({ ...base, send: (request, options) => {
    submits++;
    assert.deepEqual(request, { version: 1, type: 'restart_all', requestId: 'producer', reason: 'upgrade' });
    assert.equal(options.deadlineAt, 1000);
    return { kind: 'accepted', reply: { result: 'done_empty', runCount: 0 } };
  } });
  assert.equal(submits, 1);
  assert.equal(result.data.result, 'done_empty');
  assert.equal(result.data.runCount, 0);
});
test('producer never retries explicit refusal, connect failure or U; lookup reports facts only',async()=>{
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
test('expired submission budgets do not submit', async () => {
  const result = await requestRuntimeRestart({ ...base, now: () => 1000,
    send: () => assert.fail('expired requests do not submit') });
  assert.equal(result.error.code, 'deadline_exceeded');
});
test('upgrade restart submission retries only connects with a 30s total budget and 1s spacing',async()=>{
  for (const afterServiceRestart of [false,true]) {
    let options;
    const result=await requestRuntimeRestart({...base,deadlineAt:undefined,afterServiceRestart,
      send:async(_request,received)=>{options=received;return {kind:'connect_failed',sent:false};}});
    assert.deepEqual(options,afterServiceRestart ? {deadlineAt:30100,connectRetryEveryMs:1000} : {deadlineAt:10100});
    assert.equal(result.ok,false);
    if(afterServiceRestart) assert.match(result.error.message,/All currently running managed sessions, including Origin, need manual restart/);
  }
});

test('upgrade restart submission uses its own 30 second window regardless of an obsolete parent deadline',async()=>{
  for(const [deadlineAt,expected] of [[500,30100],[100000,30100]]) {
    let deadline;
    await requestRuntimeRestart({...base,afterServiceRestart:true,deadlineAt,
      send:async(_request,options)=>{deadline=options.deadlineAt;return {kind:'connect_failed',sent:false};}});
    assert.equal(deadline,expected);
  }
});

test('supervisor upgrade retries never repeat a connected uncertain or refused request',async()=>{
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

test('supervisor post-upgrade submission reaches a real socket that starts listening after initial connect failure',{timeout:5000},async t=>{
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
