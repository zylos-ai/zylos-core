import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { submit } from '../am-sock-client.js';

const request = { version: 1, type: 'restart_all', requestId: 'control', reason: 'upgrade' };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function connection(body) {
  return () => {
    const socket = new EventEmitter(); socket.destroy = () => {};
    socket.write = (_, done) => { done(); queueMicrotask(() => {
      if (body === 'partial') { socket.emit('data', Buffer.from('{"ok":')); socket.emit('end'); }
      else if (body) socket.emit('data', Buffer.from(JSON.stringify(body) + '\n'));
    }); };
    queueMicrotask(() => socket.emit('connect')); return socket;
  };
}
async function fields(client) {
  const result = await client(request, { connect: connection({ ...request, ok: true, result: 'done_empty', runCount: 3 }) });
  assert.deepEqual(result, { kind: 'invalid_reply', sent: true });
}
async function partial(client) {
  const result = await client(request, { connect: connection('partial') });
  assert.deepEqual(result, { kind: 'no_reply', sent: true });
}
test('field relation and connected partial-reply classification', async () => {
  await fields(submit); await partial(submit);

});

test('reply timeout remains independent of total deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  async function scenario(client) {
    let now = 1792000000000, settled = false;
    const pending = client(request, { connect: connection(null), now: () => now, deadlineAt: now + 30000, replyMaxMs: 10000 }).then(result => { settled = true; return result; });
    await flush(); now += 10000; t.mock.timers.tick(10000); await flush();
    const settledAtReplyDeadline = settled;
    // Drain the remaining clock interval; no abandoned timers/promises.
    now += 20000; t.mock.timers.tick(20000); await flush(); const result = await pending;
    assert.equal(settledAtReplyDeadline, true); assert.deepEqual(result, { kind: 'timeout', sent: true });
  }
  await scenario(submit);
});
