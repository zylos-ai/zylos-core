import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,service,actualDependencies,delay} from './stop-tmux-fixture.js';

test('real same-name replacement with the same run ID is never rebound or killed',async t=>{
 const f=await fixture(t),key='same-name-run';
 f.command('new-session','-d','-s','target','-e',`ZYLOS_RUN_ID=${key}`,'sleep 60');
 const original=f.snapshot('target'),independent=await service(f,key);let replacement;
 f.adapter.options.dependencies={...actualDependencies,revalidateSessionTarget:async options=>{
  f.command('kill-session','-t',options.target.tmuxSessionId);
  f.command('new-session','-d','-s','target','-e',`ZYLOS_RUN_ID=${key}`,'sleep 60');
  replacement=f.snapshot('target');return actualDependencies.revalidateSessionTarget(options);
 }};
 await assert.rejects(f.adapter.stop({tmuxName:'target',expectedRunId:key}),{code:'STOP_UNCONFIRMED'});
 assert.notEqual(replacement,original);assert.equal(f.snapshot('target'),replacement);assert.equal(f.snapshot('origin'),f.origin);
 t.diagnostic(JSON.stringify({original,replacement,replacementPreserved:true,service:await independent.verify(),originUnchanged:true}));
});

test('real same-socket server replacement does not reopen or act on the new server',async t=>{
 const f=await fixture(t),key='same-server-run',independent=await service(f,key);
 f.command('new-session','-d','-s','target','-e',`ZYLOS_RUN_ID=${key}`,'sleep 60');
 const generation=f.command('display-message','-p','#{pid}:#{start_time}');let replacement,newOrigin,newGeneration,opens=0;
 const oldServerPid=Number(generation.split(':')[0]),injectionErrors=[];let oldServerExited=false;
 assert.ok(Number.isSafeInteger(oldServerPid)&&oldServerPid>0);
 f.adapter.options.dependencies={...actualDependencies,
  openTmuxConnection:options=>{opens++;return actualDependencies.openTmuxConnection(options)},
  revalidateSessionTarget:async options=>{
   try {
    // kill-server can return before its process exits and releases the socket.
    // Wait for this fixture's original PID to disappear before creating a replacement.
    f.command('kill-server');
    for(let attempt=0;attempt<150;attempt++) {
     try {process.kill(oldServerPid,0);}
     catch(error) {if(error.code!=='ESRCH')throw error;oldServerExited=true;break;}
     await delay(20);
    }
    assert.equal(oldServerExited,true,`Original fixture server ${oldServerPid} did not exit`);
    f.command('-f','/dev/null','new-session','-d','-s','origin','-e','ZYLOS_RUN_ID=new-origin','sleep 60');
    f.command('new-session','-d','-s','target','-e',`ZYLOS_RUN_ID=${key}`,'sleep 60');
    newOrigin=f.snapshot('origin');replacement=f.snapshot('target');newGeneration=f.command('display-message','-p','#{pid}:#{start_time}');
   } catch(error) {injectionErrors.push(error.stack||String(error));throw error;}
   // Only this product revalidation failure is expected to become STOP_UNCONFIRMED.
   return actualDependencies.revalidateSessionTarget(options);
  },
 };
 await assert.rejects(f.adapter.stop({tmuxName:'target',expectedRunId:key}),{code:'STOP_UNCONFIRMED'});
 assert.deepEqual(injectionErrors,[],'Server-replacement injection must succeed independently of the expected stop error');
 assert.notEqual(newGeneration,generation);assert.equal(opens,1);assert.equal(f.snapshot('target'),replacement);assert.equal(f.snapshot('origin'),newOrigin);
 t.diagnostic(JSON.stringify({generation,newGeneration,oldServerPid,oldServerExited,injectionErrors,opens,replacementPreserved:true,newOriginUnchanged:true,service:await independent.verify()}));
});

for(const mode of ['command-failure','disconnect','target-remains'])test(`real transport ${mode}: no false stop success`,async t=>{
 const f=await fixture(t),key='failure-run';
 f.command('new-session','-d','-s','target','-e',`ZYLOS_RUN_ID=${key}`,'sleep 60');
 const original=f.snapshot('target');
 f.adapter.options.dependencies={...actualDependencies,openTmuxConnection:async options=>{
  const connection=await actualDependencies.openTmuxConnection(options);
  return {...connection,command:args=>{
   if(args[0]!=='kill-session')return connection.command(args);
   if(mode==='command-failure')return connection.command(['p02-deliberately-invalid-command']);
   if(mode==='target-remains')return Promise.resolve('');
   connection.close();return connection.command(args);
  }};
 }};
 await assert.rejects(f.adapter.stop({tmuxName:'target',expectedRunId:key}),{code:'STOP_UNCONFIRMED'});
 assert.equal(f.snapshot('target'),original);assert.equal(f.snapshot('origin'),f.origin);
});

for(const key of ['last-session-run',null])test(`real final-session kill confirms removal, runId=${key}`,async t=>{
 const f=await fixture(t,{origin:false});
 f.command('-f','/dev/null','new-session','-d','-s','target',...(key?['-e',`ZYLOS_RUN_ID=${key}`]:[]),'sleep 60');
 if(key===null)f.command('set-environment','-r','-t','=target','ZYLOS_RUN_ID');
 await f.adapter.stop({tmuxName:'target',expectedRunId:key});
 assert.throws(()=>f.command('list-sessions','-F','#{session_id}'));
 t.diagnostic(JSON.stringify({lastSession:true,key,targetRemovalAcknowledged:true}));
});
