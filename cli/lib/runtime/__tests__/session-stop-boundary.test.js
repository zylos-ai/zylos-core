import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionOps} from '../session-ops.js';
const fault=(code,cause='error')=>Object.assign(new Error(code),{code,cause});
function fixture({present=true,runId='r',openError,revalidateError,killError,confirmError=fault('TARGET_GONE'),confirmation='$1'}={}) {
  const calls=[],target={present,runId,tmuxSessionId:'$1',paneId:'%1',serverGeneration:'10:20'};
  const connection={close:()=>calls.push(['close']),
    command:async (args,options)=>{calls.push(args);assert.equal(options?.kind,'session');
      if(args[0]==='kill-session'){if(killError)throw killError;return '';}
      if(args[0]==='display-message'){if(confirmError)throw confirmError;return confirmation;}
      throw new Error('Unexpected stop command');}};
  const options={dependencies:{openTmuxConnection:async()=>{if(openError)throw openError;return connection},
    observeSessionTarget:async options=>{assert.equal(options.connection,connection);return target},
    revalidateSessionTarget:async options=>{assert.equal(options.connection,connection);assert.equal(options.target,target);
      calls.push(['validate']);if(revalidateError)throw revalidateError;},
  }};
  const adapter=createSessionOps(options);
  return {options,calls,stop:(expectedRunId='r')=>adapter.stop({tmuxName:'name',expectedRunId})};
}
test('run mismatch including null-vs-keyed refuses before revalidation or kill',async()=>{
  for(const [runId,expected] of [['r','wrong'],['r',null],[null,'r']]){
    const f=fixture({runId});await assert.rejects(f.stop(expected),{code:'RUNID_MISMATCH'});assert.deepEqual(f.calls,[['close']]);
  }
});
test('kill failure remains failure even if a later confirmation would report absence',async()=>{
  for(const code of ['TMUX_COMMAND_FAILED','TMUX_UNAVAILABLE']){
    const f=fixture({killError:fault(code)});await assert.rejects(f.stop(),{code:'STOP_UNCONFIRMED',cause:'error'});
    assert.equal(f.calls.filter(c=>c[0]==='kill-session').length,1);
  }
});
