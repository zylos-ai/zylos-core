import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createSupervisorConnectionHandler } from '../router-socket.js';

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
  send.handler=handler;send.socketPath=socketPath;return send;
}
test('actual socket scopes v2 delivery, rejects stale runs and maps v1 timestamp', async t => {
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
test('first line is consumed once and malformed requests do not enter admission', async t => {
  const accepted=[];const exchange=await socketFixture(t,{admission:{handle:async r=>{accepted.push(r);return {ok:true};}}});
  assert.equal((await exchange('bad\n')).code,'invalid_request');assert.equal((await exchange('[]\n')).code,'invalid_request');
  assert.equal((await exchange('{"type":"first"}\n{"type":"second"}\n')).ok,true);assert.deepEqual(accepted,[{type:'first'}]);
});

