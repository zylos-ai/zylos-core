import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {pinProcess} from '../session-process-signal.js';
import {SessionAdapter,findRunProcesses} from '../session-adapter.js';
let dir,binary;
let children;
const childList=async()=> (await fs.readFile(`/proc/self/task/${process.pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).sort();
beforeEach(async()=>{children=await childList()});
afterEach(async()=>{assert.deepEqual(await childList(),children,'all helper children must be reaped')});
before(async()=>{
  dir=await fs.mkdtemp(path.join(os.tmpdir(),'p02-pidfd-'));
  binary=path.join(dir,'helper');
  execFileSync(process.execPath,[new URL('../../../../scripts/build-process-signal.js',import.meta.url).pathname,binary]);
});
after(async()=>{await fs.rm(dir,{recursive:true,force:true})});
async function program(name,body) {
  const file=path.join(dir,name);
  await fs.writeFile(file,`#!${process.execPath}\n${body}`,{mode:0o700});return file;
}
test('native handle sends real TERM and closes idempotently; no extra child remains',async()=>{
  const child=spawn('/bin/sleep',['60']);const exit=once(child,'exit');await once(child,'spawn');
  let handle;
  try {
    handle=await pinProcess(child.pid,{binary});assert.ok(handle);
    assert.equal(await handle.signal('SIGTERM'),true);
    assert.deepEqual(await exit,[null,'SIGTERM']);
    assert.equal(await handle.signal('SIGKILL'),false);
  }finally {await handle?.close();await handle?.close();if(child.exitCode===null&&child.signalCode===null){child.kill();await exit}}
});
test('missing executable, unsupported platform and invalid PID refuse acquisition',async()=>{
  for(const [pid,options] of [[process.pid,{binary:path.join(dir,'missing')}],[process.pid,{binary,platform:'darwin'}],[0,{binary}]])
    await assert.rejects(pinProcess(pid,options),{code:'PROCESS_SIGNAL_UNAVAILABLE'});
});
test('kernel denial/unsupported response is unavailable, not an acquired handle',async()=>{
  const denied=await program('denied',"process.stdout.write('ERR 38\\n')");
  await assert.rejects(pinProcess(process.pid,{binary:denied}),{code:'PROCESS_SIGNAL_UNAVAILABLE'});
});
test('process already gone before acquisition returns no handle and reaps helper',async()=>{
  const gone=await program('gone',"process.stdout.write('GONE\\n')");
  assert.equal(await pinProcess(process.pid,{binary:gone}),null);
});
test('malformed/oversized helper output is unavailable',async()=>{
  for(const [name,body] of [['bad',"process.stdout.write('not-ready\\n')"],['large',"process.stdout.write('x'.repeat(2048))"]]) {
    const fake=await program(name,body);
    await assert.rejects(pinProcess(process.pid,{binary:fake}),{code:'PROCESS_SIGNAL_UNAVAILABLE'});
  }
});
test('helper dies after READY or fails a signal: no numeric-PID fallback',async()=>{
  for(const [name,body] of [['die',"process.stdout.write('READY\\n');process.stdin.once('data',()=>process.exit(1))"],
    ['send-denied',"process.stdout.write('READY\\n');process.stdin.on('data',()=>process.stdout.write('ERR 1\\n'))"]]) {
    const fake=await program(name,body);const handle=await pinProcess(process.pid,{binary:fake});
    try {await assert.rejects(handle.signal('SIGTERM'),{code:'PROCESS_SIGNAL_UNAVAILABLE'})} finally {await handle.close()}
  }
});
test('unresponsive helper times out, is reaped, and request refuses success',async()=>{
  const fake=await program('hang',"process.stdout.write('READY\\n');process.stdin.resume()");
  const handle=await pinProcess(process.pid,{binary:fake,timeoutMs:100});
  try {await assert.rejects(handle.signal('SIGTERM'),{code:'PROCESS_SIGNAL_UNAVAILABLE',cause:'timeout'})} finally {await handle.close()}
});
test('closed handle cannot send and unsupported signal is rejected',async()=>{
  const handle=await pinProcess(process.pid,{binary});
  try {await assert.rejects(handle.signal('SIGUSR1'),{code:'PROCESS_SIGNAL_UNAVAILABLE'})}finally {await handle.close()}
  await assert.rejects(handle.signal('SIGTERM'),{code:'PROCESS_SIGNAL_UNAVAILABLE'});
});
test('real missing helper refuses present mutation and absent keyed stop; target survives',async()=>{
  const child=spawn('/bin/sleep',['60'],{env:{ZYLOS_RUN_ID:'native-missing'}});
  const exit=once(child,'exit');await once(child,'spawn');
  try {
    for(const present of [true,false]) {
      const commands=[],logs=[];
      const adapter=new SessionAdapter({processSignal:{binary:path.join(dir,'missing')},
        findRunProcesses:key=>findRunProcesses(key,{withIdentity:true,filesystem:{...fs,readdir:async()=>[String(child.pid)]}}),
        log:line=>logs.push(line),dependencies:{openTmuxConnection:async()=>({close(){},command:async a=>commands.push(a)}),
          observeSessionTarget:async()=>({present,runId:'native-missing',tmuxSessionId:'$1'}),revalidateSessionTarget:async()=>{}},
      });
      await assert.rejects(adapter.stop({tmuxName:'fixture',expectedRunId:'native-missing'}),{code:'STOP_UNCONFIRMED',cause:'error'});
      assert.deepEqual(commands,[]);assert.deepEqual(logs,[]);assert.equal(child.signalCode,null);
    }
  }finally {child.kill();await exit}
});
