import test from 'node:test';
import assert from 'node:assert/strict';
const {SessionAdapter}=await import(process.env.P02_STOP_ADAPTER_MODULE || new URL('../session-adapter.js',import.meta.url));
const fault=(code,cause='error')=>Object.assign(new Error(code),{code,cause});
function fixture({present=true,runId='r',openError,revalidateError,killError,confirmError=fault('TARGET_GONE'),confirmation='$1'}={}) {
  const calls=[],target={present,runId,tmuxSessionId:'$1',paneId:'%1',serverGeneration:'10:20'};
  const connection={close:()=>calls.push(['close']),
    command:async (args,options)=>{calls.push(args);assert.equal(options?.kind,'session');
      if(args[0]==='kill-session'){if(killError)throw killError;return '';}
      if(args[0]==='display-message'){if(confirmError)throw confirmError;return confirmation;}
      throw new Error('Unexpected stop command');}};
  const adapter=new SessionAdapter({dependencies:{openTmuxConnection:async()=>{if(openError)throw openError;return connection},
    observeSessionTarget:async options=>{assert.equal(options.connection,connection);return target},
    revalidateSessionTarget:async options=>{assert.equal(options.connection,connection);assert.equal(options.target,target);
      calls.push(['validate']);if(revalidateError)throw revalidateError;},
  }});
  // Old-source controls must not enumerate or signal any host process.
  if(process.env.P02_STOP_ADAPTER_MODULE)adapter.options.findRunProcesses=async()=>[];
  return {adapter,calls,stop:(expectedRunId='r')=>adapter.stop({tmuxName:'name',expectedRunId})};
}
test('present keyed and historical-null targets close exact original ID and confirm removal',async()=>{
  for(const runId of ['r',null]){
    const f=fixture({runId});await f.stop(runId);
    assert.deepEqual(f.calls,[['validate'],['kill-session','-t','$1'],['display-message','-p','-t','$1','#{session_id}'],['close']]);
  }
});
test('absent target and explicit no-server succeed for nonempty and null expected run IDs',async()=>{
  for(const expected of ['r',null])for(const options of [{present:false},{openError:fault('TMUX_NO_SERVER')}]){
    const f=fixture(options);await f.stop(expected);assert.equal(f.calls.some(c=>c[0]==='kill-session'),false);
  }
});
test('run mismatch including null-vs-keyed refuses before revalidation or kill',async()=>{
  for(const [runId,expected] of [['r','wrong'],['r',null],[null,'r']]){
    const f=fixture({runId});await assert.rejects(f.stop(expected),{code:'RUNID_MISMATCH'});assert.deepEqual(f.calls,[['close']]);
  }
});
test('generation/object/run replacement during revalidation never retargets or kills',async()=>{
  for(const code of ['GENERATION_CHANGED','TARGET_GONE','RUNID_MISMATCH']){
    const f=fixture({revalidateError:fault(code)});
    await assert.rejects(f.stop(),{code:code==='RUNID_MISMATCH'?code:'STOP_UNCONFIRMED'});
    assert.deepEqual(f.calls,[['validate'],['close']]);
  }
});
test('kill failure remains failure even if a later confirmation would report absence',async()=>{
  for(const code of ['TMUX_COMMAND_FAILED','TMUX_UNAVAILABLE']){
    const f=fixture({killError:fault(code)});await assert.rejects(f.stop(),{code:'STOP_UNCONFIRMED',cause:'error'});
    assert.equal(f.calls.filter(c=>c[0]==='kill-session').length,1);
  }
});
test('same-generation gone confirms removal; changed generation or unknown result never does',async()=>{
  for(const code of ['TARGET_GONE','GENERATION_CHANGED','TMUX_UNAVAILABLE','TMUX_COMMAND_FAILED']){
    const f=fixture({confirmError:fault(code)});
    if(code==='TARGET_GONE')await f.stop();
    else await assert.rejects(f.stop(),{code:'STOP_UNCONFIRMED'});
  }
});
test('successful confirmation guard means session still exists regardless of action output',async()=>{
  for(const confirmation of ['$1','$2','malformed','']){
    const f=fixture({confirmError:null,confirmation});
    await assert.rejects(f.stop(),{code:'STOP_UNCONFIRMED'});
  }
});
test('unobservable tmux cannot be treated as absence; preserve stable cause',async()=>{
  for(const cause of ['timeout','error']){
    const f=fixture({openError:fault('TMUX_UNAVAILABLE',cause)});
    await assert.rejects(f.stop(),{code:'STOP_UNCONFIRMED',cause});assert.deepEqual(f.calls,[]);
  }
});
test('no obsolete cleanup capability, delay or process environment is consumed',async()=>{
  for(const present of [true,false]){
    const f=fixture({present});
    for(const key of ['findRunProcesses','readOwnedProcess','pinProcess','signalProcess','processSignal','stopGraceMs','sleep'])
      Object.defineProperty(f.adapter.options,key,{get(){throw new Error('Process cleanup is forbidden')}});
    await f.stop();
  }
});
