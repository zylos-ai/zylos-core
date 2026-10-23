import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readOwnedProcess} from '../session-process-ownership.js';
import {SessionAdapter,findRunProcesses} from '../session-adapter.js';
const fault=code=>Object.assign(new Error(code),{code});
const stat=(start='100',state='S')=>`42 (owned process) ${[state,...Array(18).fill('0'),start].join(' ')}`;
function source({starts=['100','100'],owners=[7,7],env='ZYLOS_RUN_ID=r\0',readError,identities}={}){
 let n=0,u=0;
 return {platform:'linux',procRoot:'/fixture',uid:7,filesystem:{
  async stat(file){return file==='/fixture'?{isDirectory:()=>true}:{uid:owners[Math.min(u++,owners.length-1)]}},
  async readFile(file){if(file.endsWith('/stat')){const i=Math.min(n++,starts.length-1);const value=identities?identities[i]:stat(starts[i]);if(value instanceof Error)throw value;return value;}if(readError)throw readError;return Buffer.from(env)},
  async readdir(){return ['42']},
 }};
}
test('ownership identity brackets exact runId and UID; numeric scan export stays compatible',async()=>{
 assert.deepEqual(await readOwnedProcess(42,'r',source()),{pid:42,start:'100'});
 assert.deepEqual(await findRunProcesses('r',source()),[42]);
 assert.deepEqual(await findRunProcesses('r',{...source(),withIdentity:true}),[{pid:42,start:'100'}]);
 assert.equal(await readOwnedProcess(42,'r',source({env:'ZYLOS_RUN_ID=r-other\0'})),null);
 assert.equal(await readOwnedProcess(42,'r',source({owners:[8]})),null);
});
test('same PID generation or UID changes across environment read are not absence',async()=>{
 for(const options of [source({starts:['100','101']}),source({owners:[7,8]})])await assert.rejects(readOwnedProcess(42,'r',options),{code:'PROCESS_IDENTITY_CHANGED'});
 await assert.rejects(findRunProcesses('r',source({starts:['100','101']})),{code:'PROCESS_IDENTITY_CHANGED'});
});
test('missing environment with original incarnation alive is unavailable, exit remains absence',async()=>{
 await assert.rejects(readOwnedProcess(42,'r',source({readError:fault('ENOENT')})),{code:'ENOENT'});
 await assert.rejects(readOwnedProcess(42,'r',source({readError:fault('EACCES')})),{code:'EACCES'});
 assert.equal(await readOwnedProcess(42,'r',source({identities:[stat(),fault('ENOENT')],readError:fault('EACCES')})),null);
 assert.equal(await readOwnedProcess(42,'r',source({identities:[stat(),stat('100','Z')]})),null);
});
function fixture({present=true,scan,observe}={}){
 const signals=[],logs=[],commands=[];let exists=present;
 const connection={close(){},didAcknowledgeSessionKill:()=>true,command:async a=>{commands.push(a);if(a[0]==='kill-session')exists=false;return exists?'$1':'$2'}};
 const adapter=new SessionAdapter({findRunProcesses:scan|| (async()=>[]),readOwnedProcess:observe|| (async pid=>({pid,start:'100'})),pinProcess:async pid=>({signal:async sig=>signals.push([pid,sig]),close:async()=>{}}),sleep:async()=>{},log:x=>logs.push(x),dependencies:{
  openTmuxConnection:async()=>connection,observeSessionTarget:async()=>({present:exists,runId:'r',tmuxSessionId:'$1'}),revalidateSessionTarget:async()=>{},
 }});
 return {adapter,signals,logs,commands};
}
test('observed scan generation change is unconfirmed even absent at entry',async()=>{
 const f=fixture({present:false,scan:async()=>{throw fault('PROCESS_IDENTITY_CHANGED')}});
 await assert.rejects(f.adapter.stop({tmuxName:'x',expectedRunId:'r'}),{code:'STOP_UNCONFIRMED'});
 assert.deepEqual(f.logs,[]);assert.deepEqual(f.signals,[]);
});
test('TERM cannot signal an observed replacement generation',async()=>{
 const f=fixture({scan:async()=>[{pid:42,start:'100'}],observe:async()=>({pid:42,start:'101'})});
 await assert.rejects(f.adapter.stop({tmuxName:'x',expectedRunId:'r'}),{code:'STOP_UNCONFIRMED'});assert.deepEqual(f.signals,[]);
});
test('KILL revalidates generation after TERM rather than trusting the earlier snapshot',async()=>{
 let reads=0;const f=fixture({scan:async()=>[{pid:42,start:'100'}],observe:async()=>({pid:42,start:++reads<=2?'100':'101'})});
 await assert.rejects(f.adapter.stop({tmuxName:'x',expectedRunId:'r'}),{code:'STOP_UNCONFIRMED'});assert.deepEqual(f.signals,[[42,'SIGTERM']]);
});
test('different ownership or exited PID is never signalled and a later empty scan confirms exit',async()=>{
 for(const present of [false,true]){
  let scans=0;const f=fixture({present,scan:async()=>++scans<=(present?2:1)?[{pid:42,start:'100'}]:[],observe:async()=>null});
  await f.adapter.stop({tmuxName:'x',expectedRunId:'r'});assert.deepEqual(f.signals,[]);assert.deepEqual(f.logs,[]);
 }
});
test('identity read failure before signal stays unconfirmed, without unknown-success logging',async()=>{
 const f=fixture({present:false,scan:async()=>[{pid:42,start:'100'}],observe:async()=>{throw fault('EACCES')}});
 await assert.rejects(f.adapter.stop({tmuxName:'x',expectedRunId:'r'}),{code:'STOP_UNCONFIRMED'});assert.deepEqual(f.signals,[]);assert.deepEqual(f.logs,[]);
});
test('real proc-format same-PID replacement between initial and post-kill scans is not signalled',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p02-stop-reuse-'));let scans=0;
 try{
  await fs.mkdir(path.join(dir,'42'));await fs.writeFile(path.join(dir,'42','stat'),stat());await fs.writeFile(path.join(dir,'42','environ'),'ZYLOS_RUN_ID=r\0');
  const f=fixture({scan:async()=>{if(++scans===2)await fs.writeFile(path.join(dir,'42','stat'),stat('101'));return findRunProcesses('r',{procRoot:dir,withIdentity:true})},observe:pid=>readOwnedProcess(pid,'r',{procRoot:dir})});
  f.adapter.options.pinProcess=async pid=>({signal:async sig=>{f.signals.push([pid,sig]);writeFileSync(path.join(dir,'42','environ'),'ZYLOS_RUN_ID=other\0')},close:async()=>{}});
  let outcome='success';try{await f.adapter.stop({tmuxName:'x',expectedRunId:'r'})}catch(error){outcome=error.code}
  t.diagnostic(JSON.stringify({outcome,signals:f.signals,scanCount:scans,syntheticPIDReuse:true}));
  assert.equal(outcome,'STOP_UNCONFIRMED');assert.deepEqual(f.signals,[]);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('real proc-format missing environ for a still-live identity cannot become an empty scan',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p02-stop-partial-'));
 try{
  await fs.mkdir(path.join(dir,'42'));await fs.writeFile(path.join(dir,'42','stat'),stat());
  await assert.rejects(findRunProcesses('r',{procRoot:dir}),{code:'ENOENT'});
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
