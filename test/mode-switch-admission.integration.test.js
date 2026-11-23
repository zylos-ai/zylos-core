import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { guardDatabase } from '../skills/comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../skills/comm-bridge/scripts/c4-schema.js';
import { createStore } from '../skills/comm-bridge/scripts/c4-v2-store.js';
import { submit, lookupModeSwitch } from '../cli/lib/am-sock-client.js';
import { executeSessionMode } from '../cli/commands/session-mode.js';

const cleanups=[];
afterEach(async()=>{while(cleanups.length) await cleanups.pop()();});
async function fixture(responder) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sw-cli-'));
  const home = fs.realpathSync(process.env.HOME);
  assert.equal(root.startsWith(home + path.sep), false);
  console.info({ HOME: home, ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME,
    TMPDIR: os.tmpdir(), database: path.join(root, 'c4.db'), socket: path.join(root, 'am.sock') });
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
  return {root,db,store,requests,send:(request,options)=>submit(request,{...options,socketPath})};
}
// Covers: the real socket client and session-mode command against an in-process
// Unix socket and a real C4 store, with every path under the runner's temporary
// directory. Run after changes to submit/validateReply, session-mode switch or
// the mode transition store; other changes can skip it.
// The server's reply or close decides each branch, never a reply timer. The
// fixture leaves submit's 10 s reply budget in place, which the command's own
// 10 s deadline also caps and which outlasts the 5 s test timeout: a short
// budget armed when the request is written can expire under CPU load before
// the client reads a reply the server has already sent, sending the client
// down the lookup branch. A slow reply now fails the test as a timeout.
// Budget expiry is covered by the expired-budget case below, the submit
// timeout cases in am-sock-client.test.js, and the timeout-then-lookup cases
// in session-mode-command.test.js.
for (const behavior of ['accept','lost-after-commit','malformed','closed-before-commit']) {
  test(`real socket ${behavior} and real observation`, { timeout: 5000 }, async () => {
    const f=await fixture((socket,request,store)=>{
      if(behavior==='accept'||behavior==='lost-after-commit') {
        const {runId}=store.beginModeTransition('single','multi');
        if(behavior==='accept')socket.end(JSON.stringify({version:1,type:'mode_switch',requestId:request.requestId,ok:true,result:'accepted',runId})+'\n');
        else socket.end();
      } else if(behavior==='malformed')socket.end('{broken\n');else socket.end();
    });
    let reads=0;
    const result=await executeSessionMode(['switch','multi'],{send:f.send,lookup:(target,options)=>lookupModeSwitch(target,{...options,getModeTransition:()=>{reads++;return f.store.getModeTransition();},readMode:()=>({mode:'single'})})});
    assert.equal(f.requests.length, 1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM mode_transitions').get().n, ['accept','lost-after-commit'].includes(behavior)?1:0);
    assert.equal(result.ok, ['accept','lost-after-commit'].includes(behavior));
    assert.equal(reads, behavior==='accept'?0:1);
    if(behavior==='lost-after-commit')assert.equal(result.data.observed, 'transition_open');
    if(!result.ok)assert.equal(result.error.persisted, null);
  });
}
// Budget expiry is driven by a controlled clock, not by real elapsed time:
// the clock stays before the deadline until the server has recorded the
// request, then jumps to it. The client's write callback is held until that
// moment, so submit arms its reply timer with no time left and its real timer
// ends the wait as deadline_exceeded. Until then the 10 s window outlasts
// the test timeout, so no timer can expire before the request is sent and
// read, however slow the machine is.
test('expired reply budget does not start a read or resend', { timeout: 5000 }, async () => {
  const start=Date.now();const deadlineAt=start+10000;let expired=false;let markReceived;
  const received=new Promise(resolve=>{markReceived=resolve;});
  const now=()=>expired?deadlineAt:start;
  const f=await fixture(()=>{expired=true;markReceived();});let reads=0;
  const connect=options=>{
    const socket=net.createConnection(options);const write=socket.write.bind(socket);
    socket.write=(data,callback)=>write(data,error=>received.then(()=>callback(error)));
    return socket;
  };
  const result=await executeSessionMode(['switch','multi'],{deadlineAt,send:(request,options)=>f.send(request,{...options,now,connect}),
    lookup:(target,options)=>lookupModeSwitch(target,{...options,now,getModeTransition:()=>{reads++;return f.store.getModeTransition();}})});
  assert.equal(result.ok, false);assert.equal(result.error.code, 'deadline_exceeded');assert.equal(result.error.persisted, null);assert.equal(reads, 0);assert.equal(f.requests.length, 1);
});
