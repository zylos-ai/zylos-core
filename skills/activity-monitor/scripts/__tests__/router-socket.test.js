import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { createSupervisorConnectionHandler, createRouterReply } from '../router-socket.js';

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

