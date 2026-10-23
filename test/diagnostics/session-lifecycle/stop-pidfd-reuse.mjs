// Private namespace only. Same final-read boundary as stop-pid-reuse.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pinProcess} from '../../../cli/lib/runtime/session-process-signal.js';
import {readOwnedProcess} from '../../../cli/lib/runtime/session-process-ownership.js';
const {SessionAdapter,findRunProcesses}=await import(process.env.P02_ADAPTER_MODULE || new URL('../../../cli/lib/runtime/session-adapter.js',import.meta.url));
assert.equal(process.pid,1,'requires a fresh private PID namespace');
assert.match(await fs.readFile('/proc/self/status','utf8'),/^NSpid:\s+1$/m,'requires namespace-local proc');
const binary=process.argv[2];assert.ok(binary,'pass an absolute compiled helper path');
const numericControl=process.argv[3]==='--control-numeric';
const runId='private-pidfd-stop';
let original,replacement,originalExit,replacementExit,before,after,reads=0,acquired=0,closed=0,switched=false;
const replies=[];
const start=async env=>{
  await fs.writeFile('/proc/sys/kernel/ns_last_pid','4000');
  const child=spawn('/bin/sleep',['60'],{env,stdio:'ignore'});
  const exited=once(child,'exit');await once(child,'spawn');assert.equal(child.pid,4001);
  return {child,exited};
};
try {
  ({child:original,exited:originalExit}=await start({ZYLOS_RUN_ID:runId}));
  before=await readOwnedProcess(original.pid,runId);assert.ok(before);
  const adapter=new SessionAdapter({
    findRunProcesses:key=>findRunProcesses(key,{withIdentity:true,filesystem:{...fs,readdir:async()=>['4001']}}),
    pinProcess:async pid=>{
      const handle=await pinProcess(pid,{binary});assert.ok(handle);acquired++;
      return {signal:async sig=>{
        if(numericControl) {process.kill(pid,sig);replies.push('numeric-control');return true;}
        const result=await handle.signal(sig);replies.push(result);return result;
      },close:async()=>{await handle.close();closed++}};
    },
    readOwnedProcess:async(pid,key)=>{
      const result=await readOwnedProcess(pid,key);reads++;
      if(switched || (acquired && reads===1))return result;
      assert.deepEqual(result,before);switched=true;original.kill('SIGKILL');await originalExit;
      let advanced=false;
      for(let attempt=0;attempt<200;attempt++) {
        const child=spawn('/bin/sleep',['0'],{stdio:'ignore'}),exited=once(child,'exit');
        const stat=await fs.readFile(`/proc/${child.pid}/stat`,'utf8').catch(()=>null);await exited;
        if(stat && stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19]!==before.start) {advanced=true;break;}
      }
      assert.ok(advanced);
      ({child:replacement,exited:replacementExit}=await start({UNRELATED:'yes'}));
      const stat=await fs.readFile('/proc/4001/stat','utf8');
      after={pid:replacement.pid,start:stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19]};
      assert.notEqual(after.start,before.start);assert.equal(await readOwnedProcess(4001,key),null);
      return result;
    },
    sleep:async()=>{},dependencies:{openTmuxConnection:async()=>({close(){}}),observeSessionTarget:async()=>({present:false})},
  });
  await adapter.stop({tmuxName:'private-absent',expectedRunId:runId});
  assert.ok(switched);
  const stat=await fs.readFile('/proc/4001/stat','utf8').catch(()=>null);
  const alive=!!stat && stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]!=='Z';
  console.log(JSON.stringify({original:before,replacement:after,replacementAlive:alive,acquired,closed,replies,numericControl}));
  assert.equal(alive,true,'replacement without runId must remain alive');
  assert.equal(acquired,1);assert.equal(closed,1);assert.deepEqual(replies,[false]);
}finally {
  for(const [child,exited] of [[replacement,replacementExit],[original,originalExit]]) {
    if(child && child.exitCode===null && child.signalCode===null) {child.kill('SIGKILL');await exited;}
  }
}
