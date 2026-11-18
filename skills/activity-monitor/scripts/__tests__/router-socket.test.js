import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { createSupervisorConnectionHandler, createRouterReply } from '../router-socket.js';

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


function failureRequest(overrides = {}) {
  return { version: 2, type: 'notify_delivery_failed', requestId: 'failure-1', conversationId: 42,
    sessionGroup: 'telegram:a', runId: 'run-a', sessionId: 'session-a', runtime: 'codex', pastedAt: 1234, ...overrides };
}
async function handleFailure(request, options = {}) {
  const replies = [], failures = [], reads = [], observations = [];
  const socket = new EventEmitter();
  socket.destroy = () => { socket.destroyed = true; };
  socket.end = line => { replies.push(JSON.parse(line)); socket.writableEnded = true; };
  const handler = createSupervisorConnectionHandler({
    readRun: async group => { reads.push(group); return { runId: 'run-a', sessionId: 'session-a', runtime: 'codex', runDir: '/isolated/run', currentSessionTs: 1000 }; },
    onDeliveryFailed: async (fact, observed) => { failures.push(fact); observations.push(observed); }, ...options,
  });
  handler(socket);
  socket.emit('data', Buffer.from(JSON.stringify(request) + '\n'));
  await handler.drain();
  return { replies, failures, reads, observations, socket };
}

test('delivery failure IPC passes a current v2 fact and normalizes the single session to origin', async () => {
  for (const group of ['telegram:a', null]) {
    const request = failureRequest({ sessionGroup: group });
    const result = await handleFailure(request);
    assert.deepEqual(result.failures, [{ ...request, sessionGroup: group ?? 'origin' }]);
    assert.deepEqual(result.reads, [group]);
    assert.deepEqual(result.observations, [{ runId: 'run-a', sessionId: 'session-a', runtime: 'codex', runDir: '/isolated/run', currentSessionTs: 1000 }]);
    assert.deepEqual(result.replies, [{ version: 1, type: 'ack', requestId: request.requestId }]);
  }
});

for (const key of ['runId', 'sessionId', 'runtime']) {
  test(`delivery failure IPC acknowledges but ignores stale ${key}`, async () => {
    const result = await handleFailure(failureRequest({ [key]: 'stale' }));
    assert.equal(result.failures.length, 0);
    assert.equal(result.replies[0].type, 'ack');
  });
}

test('delivery failure IPC rejects malformed facts before reading the run', async () => {
  for (const invalid of [{ version: 1 }, { conversationId: 0 }, { pastedAt: -1 }, { pastedAt: 1.5 },
    { sessionId: '' }, { runtime: '' }, { runId: '' }, { requestId: '' }, { sessionGroup: '../escape' }]) {
    const result = await handleFailure(failureRequest(invalid));
    assert.deepEqual(result.replies, [{ ok: false, code: 'invalid_request' }]);
    assert.equal(result.reads.length, 0);
    assert.equal(result.failures.length, 0);
  }
});

test('closed supervisor admission drops delivery failure IPC', async () => {
  const result = await handleFailure(failureRequest(), { isOpen: () => false });
  assert.equal(result.socket.destroyed, true);
  assert.equal(result.reads.length, 0);
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.replies, []);
});
