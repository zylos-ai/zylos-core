import test from 'node:test';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeSessionMode } from '../../commands/session-mode.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { submit, validateReply, lookupModeSwitchCancel } from '../am-sock-client.js';
const request = { version: 1, type: 'mode_switch_cancel', requestId: 'cancel-1', runId: 'run-1' };
for (const [fields, valid] of [
  [{ ok: true, result: 'cancelled', runId: 'run-1', extension: true }, true],
  [{ ok: true, result: 'cancelled' }, false], [{ ok: true, result: 'cancelled', runId: '' }, false],
  [{ ok: true, result: 'cancelled', runId: 'other-run' }, false],
  [{ ok: true, result: 'accepted', runId: 'run-1' }, false],
  [{ ok: false, code: 'run_not_open' }, true], [{ ok: false, code: 'not_cancellable' }, true],
  [{ ok: false, code: 'entry_not_open' }, true], [{ ok: false, code: 'invalid_request' }, true],
  [{ ok: false, code: 'unknown' }, false],
]) test(`cancel reply validation ${JSON.stringify(fields)}`, () => {
  assert.equal(validateReply(request, { version: 1, type: request.type, requestId: request.requestId, ...fields }), valid);
});
test('cancel submit traverses actual transport and validates first reply', async () => {
  const socket = new EventEmitter(); let connections = 0, writes = 0;
  socket.destroy = () => {};
  socket.write = (line, callback) => {
    writes++; assert.deepEqual(JSON.parse(line), request); callback();
    queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({ ...request, ok: true, result: 'cancelled' }) + '\n')));
  };
  const result = await submit(request, { connect: () => { connections++; queueMicrotask(() => socket.emit('connect')); return socket; } });
  assert.equal(result.kind, 'accepted'); assert.equal(result.sent, true); assert.equal(connections, 1); assert.equal(writes, 1);
});
for (const phase of ['cancelled', 'gating', 'cutover', 'complete', null]) test(`cancel lookup pins exact run for ${phase}`, async () => {
  let reads = 0;
  const result = await lookupModeSwitchCancel('run-1', { now: () => 1000, deadlineAt: 1001, getModeTransition: options => {
    reads++; assert.deepEqual(options, { runId: 'run-1' }); return phase && { run_id: 'run-1', phase };
  } });
  assert.equal(result, phase === 'cancelled' ? 'cancelled' : 'unknown'); assert.equal(reads, 1);
});
test('cancel lookup respects exhausted deadline without reading', async () => {
  assert.equal(await lookupModeSwitchCancel('run-1', { now: () => 1000, deadlineAt: 1000, getModeTransition: () => assert.fail('deadline exhausted') }), 'deadline_exceeded');
});
test('cancel lookup never accepts another cancelled run and propagates read failures', async () => {
  const options = { now: () => 1000, deadlineAt: 1001 };
  assert.equal(await lookupModeSwitchCancel('run-1', { ...options, getModeTransition: () => ({ run_id: 'other', phase: 'cancelled' }) }), 'unknown');
  await assert.rejects(lookupModeSwitchCancel('run-1', { ...options, getModeTransition: () => { throw new Error('busy'); } }), /busy/);
});

async function memoryPendingServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'g-'));
  const socketPath = path.join(directory, 'a.sock'), calls = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '';
    socket.on('data', bytes => {
      buffer += bytes.toString('utf8');
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); calls.push(request);
      socket.end(JSON.stringify({ version: 1, type: request.type, requestId: request.requestId, ok: false, code: 'global_memory_pending' }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  return { socketPath, calls };
}
test('global_memory_pending real transport is a complete rejection', async t => {
  const f = await memoryPendingServer(t);
  const result = await submit({ version: 1, type: 'mode_switch', requestId: 'switch-memory', target: 'multi' }, { socketPath: f.socketPath });
  assert.equal(result.kind, 'rejected'); assert.equal(result.reply.code, 'global_memory_pending'); assert.equal(result.sent, true);
  assert.equal(f.calls.length, 1);
});
test('global_memory_pending CLI preserves real transport rejection without uncertain lookup or retry', async t => {
  const f = await memoryPendingServer(t);
  const result = await executeSessionMode(['switch','multi','--json'], {
    requestId: () => 'switch-memory-cli', send: (request, options) => submit(request, { ...options, socketPath: f.socketPath }),
    lookup: () => assert.fail('a complete memory-pending rejection must not trigger lookup'),
  });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'global_memory_pending'); assert.deepEqual(result.error.persisted, []);
  assert.equal(f.calls.length, 1);
});
test('cancel lookup accepts authoritative cancellation when ordinary DB read finishes past deadline', async () => {
  let now = 1000;
  assert.equal(await lookupModeSwitchCancel('run-1', { deadlineAt: 1001, now: () => now, getModeTransition: options => {
    assert.deepEqual(options, { runId: 'run-1' }); now = 2000; return { run_id: 'run-1', phase: 'cancelled' };
  } }), 'cancelled');
});
