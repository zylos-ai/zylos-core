import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createSupervisorConnectionHandler } from '../router-socket.js';
import { submit } from '../../../../cli/lib/am-sock-client.js';
import { RestartRequestStore } from '../restart-request-store.js';

async function socketFixture(t, deps) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'supervisor-sock-'));const socketPath=path.join(root,'am.sock');const sockets=new Set();
  const handler=createSupervisorConnectionHandler(deps);
  const server=net.createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));handler(socket);});
  server.listen(socketPath);await once(server,'listening');
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  const send=async input=>{
    const socket=net.createConnection(socketPath);let output='';socket.on('data',data=>output+=data);await once(socket,'connect');
    socket.write(typeof input==='string'?input:JSON.stringify(input)+'\n');await once(socket,'close');return output?JSON.parse(output):null;
  };
  send.handler=handler;return send;
}
test('IF-14 actual socket scopes v2 delivery, rejects stale runs and maps v1 timestamp', async t => {
  const delivered=[],groups=[],logs=[];let mode='multi';
  const exchange=await socketFixture(t,{readMode:()=>({mode}),readRun:group=>{groups.push(group);return {runId:'r',runtime:'claude'};},onDelivered:event=>delivered.push(event),log:line=>logs.push(line)});
  const v2={version:2,type:'notify_delivered',requestId:'n',conversationId:1,channel:'telegram',sessionGroup:'telegram:a',runId:'r',runtime:'claude',pastedAt:1792000000000};
  assert.equal((await exchange(v2)).type,'ack');assert.equal(delivered[0].sessionGroup,'telegram:a');
  await exchange({...v2,runId:'old'});assert.equal(delivered.length,1);assert.equal(logs.length,1);
  await exchange({version:1,type:'notify_delivered',requestId:'old-client',deliveredAt:1792000000123});
  assert.equal(delivered[1].sessionGroup,'origin');assert.equal(delivered[1].pastedAt,1792000000123);
  mode='single';await exchange({version:1,type:'notify_delivered',requestId:'single',deliveredAt:1792000000456});assert.equal(delivered[2].sessionGroup,null);
  assert.equal((await exchange({...v2,sessionGroup:'../bad'})).code,'invalid_request');assert.equal(delivered.length,3);
  assert.equal((await exchange({...v2,pastedAt:'wrong'})).code,'invalid_request');
  assert.deepEqual(groups,['telegram:a','telegram:a','origin',null]);
});
test('T04 first line is consumed once and malformed requests do not enter admission', async t => {
  const accepted=[];const exchange=await socketFixture(t,{admission:{handle:async r=>{accepted.push(r);return {ok:true};}}});
  assert.equal((await exchange('bad\n')).code,'invalid_request');assert.equal((await exchange('[]\n')).code,'invalid_request');
  assert.equal((await exchange('{"type":"first"}\n{"type":"second"}\n')).ok,true);assert.deepEqual(accepted,[{type:'first'}]);
});
test('T04 uncertain admission write closes without a fabricated rejection; route preserves baseline error', async t => {
  const exchange=await socketFixture(t,{admission:{handle:async()=>{throw Object.assign(new Error('disk'),{code:'EIO'});}},router:{route:async()=>{throw new Error('routing failed');}}});
  assert.equal(await exchange({version:1,type:'restart_all',requestId:'u'}),null);
  const failed=await exchange({version:2,type:'route',requestId:'r'});assert.equal(failed.reason,'message_router_error');assert.equal(failed.recovered,false);
});
test('DM-42 real process dies after F9 commit before reply; recovered owner preserves idempotence', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'supervisor-crash-'));const socketPath=path.join(root,'am.sock');
  const children=new Set();t.after(async()=>{for(const child of children){child.kill('SIGKILL');await once(child,'exit').catch(()=>{});}fs.rmSync(root,{recursive:true,force:true});});
  const admissionURL=new URL('../supervisor-admission.js',import.meta.url).href;
  const storeURL=new URL('../restart-request-store.js',import.meta.url).href;
  const socketURL=new URL('../router-socket.js',import.meta.url).href;
  async function start(crash) {
    const source=`import net from 'node:net';import fs from 'node:fs';import path from 'node:path';
import {SupervisorAdmission} from ${JSON.stringify(admissionURL)};
import {RestartRequestStore} from ${JSON.stringify(storeURL)};
import {createSupervisorConnectionHandler} from ${JSON.stringify(socketURL)};
const root=process.env.AM_TEST_ROOT;const file=path.join(root,'restart-requests.json');const socket=path.join(root,'am.sock');
try{fs.unlinkSync(socket);}catch(e){if(e.code!=='ENOENT')throw e;}
const store=new RestartRequestStore({file});const write=store.write.bind(store);
if(${crash})store.write=rows=>{write(rows);process.kill(process.pid,'SIGKILL');};
const admission=new SupervisorAdmission({store,db:{getModeTransition:()=>null},readMode:()=>({mode:'multi'}),listRuns:()=>[{runId:'one'},{runId:'starting'}]});
admission.restore();admission.openEntry();const server=net.createServer(createSupervisorConnectionHandler({admission}));
server.listen(socket,()=>process.send('ready'));`;
    const child=spawn(process.execPath,['--input-type=module','-e',source],{env:{...process.env,AM_TEST_ROOT:root},stdio:['ignore','pipe','pipe','ipc']});children.add(child);child.once('exit',()=>children.delete(child));
    let errors='';child.stderr.on('data',data=>errors+=data);await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error(errors);})]);return child;
  }
  const input={version:1,type:'restart_all',requestId:'crash-commit',reason:'upgrade'};
  const child=await start(true);const exited=once(child,'exit');
  assert.deepEqual(await submit(input,{socketPath}),{kind:'no_reply',sent:true});await exited;
  assert.deepEqual(new RestartRequestStore({file:path.join(root,'restart-requests.json')}).read()[0].runIds,['one','starting']);
  await start(false);const reply=await submit(input,{socketPath});assert.equal(reply.kind,'accepted');assert.equal(reply.reply.result,'already_accepted');assert.equal(reply.reply.runCount,2);
});

test('T01 socket shutdown drain waits accepted async route mutations and closed entry rejects bypass paths', async t=>{
  let release,started;const blocked=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  let open=true,mutated=false,calls=0;
  const send=await socketFixture(t,{isOpen:()=>open,router:{route:async()=>{calls++;started();await blocked;mutated=true;return {ok:true};}},
    admission:{handle:async()=>({ok:false,code:'entry_not_open'})}});
  const reply=send({type:'route'});await entered;
  let drained=false;const drain=send.handler.drain().then(()=>drained=true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(drained,false);assert.equal(mutated,false);release();await drain;assert.equal(mutated,true);assert.deepEqual(await reply,{ok:true});
  open=false;for(const type of ['route','health_events_ready','notify_delivered'])assert.equal(await send({type}),null);
  assert.equal(calls,1);assert.equal((await send({type:'restart_all'})).code,'entry_not_open');
});
