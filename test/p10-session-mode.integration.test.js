import { test, expect, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { guardDatabase } from '../skills/comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../skills/comm-bridge/scripts/c4-schema.js';
import { createStore } from '../skills/comm-bridge/scripts/c4-v2-store.js';
import { submit, lookupModeSwitch } from '../cli/lib/am-sock-client.js';
import { executeSessionMode } from '../cli/commands/session-mode.js';

const cleanups=[];
afterEach(async()=>{while(cleanups.length) await cleanups.pop()();});
async function fixture(responder) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'p10-cli-'));
  cleanups.push(()=>fs.rmSync(root,{recursive:true,force:true}));
  const db=new Database(path.join(root,'c4.db')); guardDatabase(db,schema);
  cleanups.push(()=>db.close());
  const store=createStore(db,{validateComponent:()=>true,readConfig:()=>({state:'ok',config:{runtime:'claude',session_mode:'single'}})});
  const socketPath=path.join(root,'am.sock'); const peers=new Set();const requests=[];
  const server=net.createServer(socket=>{
    peers.add(socket);socket.once('close',()=>peers.delete(socket)); let bytes='';
    socket.on('data',chunk=>{bytes+=chunk;if(!bytes.includes('\n'))return;const request=JSON.parse(bytes.split('\n')[0]);requests.push(request);responder(socket,request,store);});
  });
  server.listen(socketPath);await once(server,'listening');
  cleanups.push(async()=>{for(const p of peers)p.destroy();await new Promise(resolve=>server.close(resolve));});
  return {root,db,store,requests,send:(request,options)=>submit(request,{...options,socketPath,replyMaxMs:40})};
}
for (const behavior of ['accept','lost-after-commit','malformed','closed-before-commit']) {
  test(`IB44 real socket ${behavior} and real D9 observation`,async()=>{
    const f=await fixture((socket,request,store)=>{
      if(behavior==='accept'||behavior==='lost-after-commit') {
        const {runId}=store.beginModeTransition('single','multi');
        if(behavior==='accept')socket.end(JSON.stringify({version:1,type:'mode_switch',requestId:request.requestId,ok:true,result:'accepted',runId})+'\n');
        else socket.end();
      } else if(behavior==='malformed')socket.end('{broken\n');else socket.end();
    });
    let reads=0;
    const result=await executeSessionMode(['switch','multi'],{send:f.send,lookup:(target,options)=>lookupModeSwitch(target,{...options,getModeTransition:()=>{reads++;return f.store.getModeTransition();},readMode:()=>({mode:'single'})})});
    expect(f.requests).toHaveLength(1);
    expect(f.db.prepare('SELECT count(*) n FROM mode_transitions').get().n).toBe(['accept','lost-after-commit'].includes(behavior)?1:0);
    expect(result.ok).toBe(['accept','lost-after-commit'].includes(behavior));
    expect(reads).toBe(behavior==='accept'?0:1);
    if(behavior==='lost-after-commit')expect(result.data.observed).toBe('transition_open');
    if(!result.ok)expect(result.error.persisted).toBeNull();
  });
}
test('IB44 expired reply budget does not start a D9 read or resend',async()=>{
  const f=await fixture(()=>{});let reads=0;
  const deadlineAt=Date.now()+25;
  const result=await executeSessionMode(['switch','multi'],{deadlineAt,send:async(request,options)=>{
    const response=await f.send(request,options);
    // Socket timers use a monotonic fractional clock; Node can wake before
    // Date.now reaches the integer deadline. This case specifically tests an
    // exhausted lookup budget, so let that same real deadline elapse first.
    while(Date.now()<deadlineAt) await new Promise(resolve=>setTimeout(resolve,deadlineAt-Date.now()));
    return response;
  },lookup:(target,options)=>lookupModeSwitch(target,{...options,getModeTransition:()=>{reads++;return f.store.getModeTransition();}})});
  expect(result.ok).toBe(false);expect(result.error.persisted).toBeNull();expect(reads).toBe(0);expect(f.requests).toHaveLength(1);
});
test('IB44 public CLI dispatch rejects bad target with one JSON line and no instance writes',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'p10-cli-args-'));cleanups.push(()=>fs.rmSync(root,{recursive:true,force:true}));
  const child=spawnSync(process.execPath,['cli/zylos.js','session-mode','switch','bad','--json'],{encoding:'utf8',env:{...process.env,HOME:root,ZYLOS_DIR:root}});
  expect(child.status).toBe(1);expect(JSON.parse(child.stdout).error.code).toBe('INVALID_ARGUMENT');
  expect(child.stdout.trim().split('\n')).toHaveLength(1);expect(fs.readdirSync(root)).toEqual([]);
});
