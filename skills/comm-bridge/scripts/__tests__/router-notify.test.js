import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter, once } from 'node:events';
import { notifyDelivered } from '../router/notify.js';

const fields = { conversationId: 42, channel: 'telegram', sessionGroup: 'telegram:g-1', runId: 'observed-run', runtime: 'codex', pastedAt: 1792000003456 };

// P04 T05 / IB-13 client only. Ledger independence is asserted by delivery tests.
test('one real socket receives the exact v2 line without providing an acknowledgment', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
  const socketPath = path.join(dir, 'am.sock'), sockets = new Set();
  let connections = 0, bytes = '';
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    connections++; sockets.add(socket);
    socket.on('data', data => { bytes += data; });
    socket.on('end', () => server.emit('request-ended'));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  server.listen(socketPath); await once(server, 'listening');
  const received = once(server, 'request-ended');
  await notifyDelivered(fields, { socketPath });
  await received;
  assert.equal(connections, 1);
  assert.equal(bytes, JSON.stringify({ version: 2, type: 'notify_delivered', requestId: `dispatcher-${process.pid}-${fields.pastedAt}`, ...fields }) + '\n');
});

test('connection refusal resolves and makes one attempt', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let attempts = 0;
  await notifyDelivered(fields, { socketPath: path.join(dir, 'absent.sock'), createConnection: (...args) => { attempts++; return net.createConnection(...args); } });
  assert.equal(attempts, 1);
});

test('default absolute five-second deadline bounds stalled connect and write, regardless of incoming bytes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const connect of [false, true]) {
    const socket = new EventEmitter(); let destroyed = 0, writes = 0, resolved = false, attempts = 0;
    socket.destroy = () => { destroyed++; };
    socket.end = () => { writes++; };
    const pending = notifyDelivered(fields, { createConnection: () => { attempts++; return socket; } }).then(() => { resolved = true; });
    if (connect) socket.emit('connect');
    t.mock.timers.tick(4999); socket.emit('data', Buffer.from('irrelevant ack bytes'));
    await Promise.resolve(); assert.equal(resolved, false);
    t.mock.timers.tick(1); await pending;
    socket.emit('connect'); socket.emit('error', new Error('late failure')); socket.emit('close');
    assert.equal(attempts, 1); assert.equal(destroyed, 1); assert.equal(writes, Number(connect));
  }
});

test('synchronous connect/write failures are discarded and never retried', async () => {
  let attempts = 0;
  await notifyDelivered(fields, { createConnection: () => { attempts++; throw new Error('connect failed'); } });
  assert.equal(attempts, 1);
  const socket = new EventEmitter(); let destroyed = 0;
  socket.destroy = () => { destroyed++; };
  socket.end = () => { throw new Error('write failed'); };
  const pending = notifyDelivered(fields, { createConnection: () => socket });
  socket.emit('connect'); await pending;
  assert.equal(destroyed, 1);
});
