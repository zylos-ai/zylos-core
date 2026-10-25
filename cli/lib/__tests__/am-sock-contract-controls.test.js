import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { submit } from '../am-sock-client.js';

async function mutant(from, to) {
  const file = new URL('../am-sock-client.js', import.meta.url);
  let source = fs.readFileSync(file, 'utf8');
  assert.equal(source.split(from).length, 2, 'mutation must match exactly once');
  source = source.replace(from, to).replace(/from '(\.[^']+)'/g, (_, relative) => `from '${new URL(relative, file).href}'`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).submit;
}
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
test('IF-37 bad implementation controls: field relation and IB-13 connected-write classification', async () => {
  await fields(submit); await partial(submit);
  const Fields = await mutant("(reply.result === 'done_empty' ? reply.runCount === 0 : reply.runCount >= 1)", 'reply.runCount >= 0');
  await assert.rejects(fields(Fields), { code: 'ERR_ASSERTION' });
  const NotificationClassification = await mutant("current.once('end', () => { if (current === socket && !done) sent ? finish('no_reply') : failOnce(); });", "current.once('end', () => { if (current === socket && !done) sent ? finish('accepted') : failOnce(); });");
  await assert.rejects(partial(NotificationClassification), { code: 'ERR_ASSERTION' });
});

test('IF-37 reply timeout remains independent of total deadline; total-as-reply mutant fails', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const Bad = await mutant('const replyDeadline = now() + replyMaxMs;', 'const replyDeadline = deadline;');
  async function scenario(client) {
    let now = 1792000000000, settled = false;
    const pending = client(request, { connect: connection(null), now: () => now, deadlineAt: now + 30000, replyMaxMs: 10000 }).then(result => { settled = true; return result; });
    await flush(); now += 10000; t.mock.timers.tick(10000); await flush();
    const settledAtReplyDeadline = settled;
    // Drain the deliberate bad implementation too; no abandoned timers/promises.
    now += 20000; t.mock.timers.tick(20000); await flush(); const result = await pending;
    assert.equal(settledAtReplyDeadline, true); assert.deepEqual(result, { kind: 'timeout', sent: true });
  }
  await scenario(submit); await assert.rejects(scenario(Bad), { code: 'ERR_ASSERTION' });
});
