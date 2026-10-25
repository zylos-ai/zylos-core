import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const repository=fileURLToPath(new URL('../../../../',import.meta.url));
const entry=fileURLToPath(new URL('../supervisor-main.js',import.meta.url));
const worker=fileURLToPath(new URL('./fixtures/supervisor-entry-worker.js',import.meta.url));
function prepare(t,config={session_mode:'multi',runtime:'claude'}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'supervisor-entry-'));
  fs.mkdirSync(path.join(root,'.zylos'));fs.writeFileSync(path.join(root,'.zylos','config.json'),JSON.stringify(config));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
function launch(t,root,{entryFile=entry,packageRoot=repository,scenario='normal'}={}) {
  const child=fork(worker,[entryFile,scenario],{env:{...process.env,HOME:root,ZYLOS_DIR:root,ZYLOS_PACKAGE_ROOT:packageRoot},silent:true});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  const inbox=[],waiters=[];
  child.on('message',message=>waiters.length?waiters.shift().resolve(message):inbox.push(message));
  child.on('exit',(code,signal)=>{for(const waiter of waiters.splice(0))waiter.reject(new Error(`Child exited ${code ?? signal}: ${stderr}`));});
  const next=()=>inbox.length?Promise.resolve(inbox.shift()):new Promise((resolve,reject)=>waiters.push({resolve,reject}));
  return {child,next,stderr:()=>stderr};
}
async function request(root,value) {
  const socket=net.createConnection(path.join(root,'activity-monitor','am.sock'));
  await once(socket,'connect');socket.end(JSON.stringify(value)+'\n');
  let text='';for await(const chunk of socket)text+=chunk;return JSON.parse(text);
}
async function stop(worker) {
  const exited=once(worker.child,'exit');worker.child.send('stop');assert.deepEqual(await worker.next(),{stopped:true});
  const [code]=await exited;assert.equal(code,0,worker.stderr());
}
test('T01 actual entry restores before Sock admission and shuts down with a partial-line peer', {timeout:15000}, async t=>{
  const root=prepare(t),w=launch(t,root);const ready=await w.next();assert.equal(ready.admissionOpen,true);
  assert.ok(ready.logs.some(row=>row?.error==='DEPENDENCY_UNAVAILABLE'&&row.dependency==='P04 pool configuration reader'));
  assert.equal(fs.statSync(path.join(root,'activity-monitor/am.sock')).mode&0o777,0o600);
  assert.equal((await request(root,{version:1,type:'restart_all',requestId:'empty',reason:'upgrade'})).result,'done_empty');
  const partial=net.createConnection(path.join(root,'activity-monitor/am.sock'));await once(partial,'connect');partial.write('{');
  partial.on('error',error=>assert.equal(error.code,'ECONNRESET'));
  const closed=new Promise(resolve=>partial.once('close',resolve));await stop(w);await closed;assert.equal(fs.existsSync(path.join(root,'activity-monitor/am.sock')),false);
});
test('T01 duplicate entry preserves the original listener; non-socket paths remain intact', {timeout:15000}, async t=>{
  const root=prepare(t),w=launch(t,root);await w.next();w.child.send('second');
  assert.deepEqual(await w.next(),{duplicateError:'EADDRINUSE',originalListening:true});
  assert.equal((await request(root,{version:1,type:'restart_all',requestId:'still-alive',reason:'upgrade'})).result,'done_empty');await stop(w);
  fs.writeFileSync(path.join(root,'activity-monitor/am.sock'),'preserve');
  const invalid=launch(t,root);assert.deepEqual(await invalid.next(),{startupError:'EADDRINUSE'});
  assert.equal(fs.readFileSync(path.join(root,'activity-monitor/am.sock'),'utf8'),'preserve');
});
test('T01 bad startup F1 keeps Sock closed to mutations; restore failure cleans up listener', {timeout:15000}, async t=>{
  const root=prepare(t,{session_mode:'invalid'}),w=launch(t,root);const ready=await w.next();
  assert.equal(ready.admissionOpen,false);assert.equal(ready.configurationError,'CONFIG_UNREADABLE');
  assert.equal((await request(root,{version:1,type:'restart_all',requestId:'blocked',reason:'upgrade'})).code,'entry_not_open');await stop(w);
  fs.writeFileSync(path.join(root,'.zylos/config.json'),JSON.stringify({session_mode:'multi',runtime:'claude'}));
  const broken=launch(t,root,{scenario:'restore-failure'});assert.deepEqual(await broken.next(),{startupError:'RESTORE_FAILED'});
  assert.equal(fs.existsSync(path.join(root,'activity-monitor/am.sock')),false);
});
test('T01 copied installed skills resolve the separate Core package and serve actual Sock requests', {timeout:15000}, async t=>{
  const root=prepare(t);const pkg=path.join(root,'installed-core'),skills=path.join(root,'.claude','skills');
  fs.mkdirSync(pkg);fs.copyFileSync(path.join(repository,'package.json'),path.join(pkg,'package.json'));
  const filter=file=>!['node_modules','__tests__'].includes(path.basename(file));
  fs.cpSync(path.join(repository,'cli'),path.join(pkg,'cli'),{recursive:true,filter});
  fs.symlinkSync(fs.realpathSync(path.join(repository,'node_modules')),path.join(pkg,'node_modules'),'dir');
  for(const name of ['activity-monitor','comm-bridge','zylos-memory']) {
    fs.cpSync(path.join(repository,'skills',name),path.join(skills,name),{recursive:true,filter});
    fs.cpSync(path.join(repository,'skills',name),path.join(pkg,'skills',name),{recursive:true,filter});
  }
  fs.symlinkSync(fs.realpathSync(path.join(repository,'skills/comm-bridge/node_modules')),path.join(pkg,'skills/comm-bridge/node_modules'),'dir');
  fs.symlinkSync(fs.realpathSync(path.join(repository,'skills/comm-bridge/node_modules')),path.join(skills,'comm-bridge/node_modules'),'dir');
  const w=launch(t,root,{entryFile:path.join(skills,'activity-monitor/scripts/supervisor-main.js'),packageRoot:pkg});
  assert.equal((await w.next()).admissionOpen,true);
  assert.equal((await request(root,{version:1,type:'restart_all',requestId:'installed',reason:'upgrade'})).result,'done_empty');await stop(w);
});

test('T02 entry freezes first-failure notice synchronously with correct single/multi SQL scope', {timeout:15000}, async t=>{
  for(const mode of ['single','multi']) {
    const root=prepare(t,{session_mode:mode,runtime:'claude'}),w=launch(t,root);await w.next();w.child.send('freeze');
    const result=await w.next();assert.equal(result.notice.endpoint,'frozen');assert.equal(result.notice.reason,'authentication_failed');
    assert.equal(result.noticeScope,mode==='single'?'':'origin');await stop(w);
    const stored=JSON.parse(fs.readFileSync(path.join(root,'activity-monitor/runtime-health/claude.json'),'utf8'));
    assert.equal(stored.hook.groups.origin.pendingNotice.endpoint,'frozen');
  }
});

// P05 T01 / F1: a missing key is a readable legacy instance, not corrupt F1.
test('T01 legacy F1 opens actual entry as single and reports unavailable automatic migration separately', {timeout:15000}, async t=>{
  const root=prepare(t,{runtime:'claude'}),w=launch(t,root);const ready=await w.next();
  assert.equal(ready.admissionOpen,true);assert.equal(ready.configurationError,undefined);
  assert.equal(ready.mode,'single');assert.equal(ready.legacy,true);
  assert.ok(ready.logs.some(row=>row?.error==='DEPENDENCY_UNAVAILABLE' && row.phase==='automatic-migration'));
  assert.equal((await request(root,{version:1,type:'restart_all',requestId:'legacy',reason:'upgrade'})).code,'single_mode');
  await stop(w);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'.zylos/config.json'),'utf8')),{runtime:'claude'});
  const explicit=prepare(t,{session_mode:'single',runtime:'claude'}),e=launch(t,explicit);const explicitReady=await e.next();
  assert.equal(explicitReady.admissionOpen,true);assert.equal(explicitReady.legacy,false);
  assert.equal(explicitReady.logs.some(row=>row?.phase==='automatic-migration'),false);await stop(e);
});
