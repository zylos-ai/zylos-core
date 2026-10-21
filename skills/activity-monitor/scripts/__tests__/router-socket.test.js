import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { createRouterReply } from '../router-socket.js';

test('asynchronous peer write errors are handled without exposing payloads', () => {
  const socket = new net.Socket();
  const logs = [];
  const reply = createRouterReply(socket, message => logs.push(message));
  assert.doesNotThrow(() => socket.emit('error', Object.assign(new Error('PRIVATE'), { code:'EPIPE' })));
  assert.equal(reply({ secret:'PRIVATE' }), false);
  assert.equal(socket.destroyed, true);
  assert.doesNotMatch(logs.join(''), /PRIVATE/);
});

test('normal IPC response completes once and a later disconnect does not throw', async t => {
  let accepted;
  const server = net.createServer(socket => {
    accepted = socket;
    const reply = createRouterReply(socket);
    socket.once('data', () => {
      assert.equal(reply({ type:'ack' }), true);
      assert.equal(reply({ type:'duplicate' }), false);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server,'listening');
  t.after(() => { accepted?.destroy(); server.close(); });
  const client = net.connect(server.address().port,'127.0.0.1');
  t.after(() => client.destroy());
  let output = '';
  client.on('data', data => { output += data; });
  client.end('wake\n');
  await once(client,'close');
  assert.deepEqual(JSON.parse(output), {type:'ack'});
  assert.doesNotThrow(() => accepted.emit('error', Object.assign(new Error('gone'), {code:'EPIPE'})));
});

test('client closes before delayed reply and server continues accepting requests', async t => {
  let completed;
  const replied = new Promise(resolve => { completed = resolve; });
  const server = net.createServer(socket => {
    const reply = createRouterReply(socket);
    socket.once('data', () => setTimeout(() => {
      assert.doesNotThrow(() => reply({ type:'ack' }));
      completed();
    }, 30));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => server.close());
  const client = net.connect(server.address().port,'127.0.0.1');
  await once(client,'connect'); client.end('wake\n'); client.destroy();
  await replied;
  assert.equal(server.listening,true);
});
