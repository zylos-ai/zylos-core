import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { connectObserverWebSocket, ObserverWebSocket } from '../src/lib/observer-websocket.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function serverFrame(payload) {
  const body = Buffer.from(payload);
  assert.ok(body.length < 126);
  return Buffer.concat([Buffer.from([0x82, body.length]), body]);
}

async function websocketPeer({ initialPayload, allowHalfOpen = false } = {}) {
  const peers = new Set();
  const server = net.createServer({ allowHalfOpen }, (socket) => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    let request = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (request === null) return;
      request = Buffer.concat([request, chunk]);
      const boundary = request.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const text = request.subarray(0, boundary).toString('latin1');
      const key = text.match(/Sec-WebSocket-Key: ([^\r\n]+)/i)?.[1];
      const accept = crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');
      const response = Buffer.from([
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Accept: ${accept}`,
        '', '',
      ].join('\r\n'));
      socket.write(initialPayload === undefined
        ? response
        : Buffer.concat([response, serverFrame(initialPayload)]));
      request = null;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    peers,
    async close() {
      for (const peer of peers) peer.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('101 response remainder is held until explicit listener activation', async () => {
  const peer = await websocketPeer({ initialPayload: 'INIT' });
  let socket;
  try {
    socket = await connectObserverWebSocket({ port: peer.port, path: '/' });
    const messages = [];
    socket.on('message', (payload) => messages.push(payload.toString()));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(messages, []);
    assert.equal(socket.activate(), true);
    assert.deepEqual(messages, ['INIT']);
  } finally {
    socket?.destroy();
    await peer.close();
  }
});

test('pre-activation response data is bounded and fails closed on activation', async () => {
  const peer = await websocketPeer({ initialPayload: 'INIT' });
  let socket;
  try {
    socket = await connectObserverWebSocket({
      port: peer.port, path: '/', maxQueuedBytes: 5,
    });
    const errors = [];
    socket.on('error', (error) => errors.push(error));
    assert.equal(socket.activate(), false);
    assert.equal(socket.closed, true);
    assert.match(errors[0]?.message || '', /startup buffer exceeded/);
  } finally {
    socket?.destroy();
    await peer.close();
  }
});

test('outbound queue overflow explicitly closes a slow consumer', () => {
  const socket = new EventEmitter();
  const writes = [];
  socket.destroyed = false;
  socket.writableEnded = false;
  socket.writableLength = 5;
  socket.setNoDelay = () => {};
  socket.write = (value) => { writes.push(Buffer.from(value)); return true; };
  socket.end = () => { socket.writableEnded = true; };
  socket.destroy = () => { socket.destroyed = true; };
  const websocket = new ObserverWebSocket(socket, {
    maskedInbound: true,
    maskOutbound: false,
    maxQueuedBytes: 5,
    closeTimeoutMs: 50,
  });

  assert.equal(websocket.sendBinary(Buffer.from('x')), false);
  assert.equal(websocket.closing, true);
  assert.equal(socket.writableEnded, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 0x88);
  assert.equal(writes[0].readUInt16BE(2), 1009);
  websocket.destroy();
});

test('close enters a terminal closing state and destroys a half-open socket by deadline', async () => {
  const peer = await websocketPeer({ allowHalfOpen: true });
  let socket;
  try {
    socket = await connectObserverWebSocket({
      port: peer.port, path: '/', closeTimeoutMs: 50,
    });
    socket.activate();
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.close();
    socket.close();
    assert.equal(socket.closing, true);
    assert.equal(socket.sendText('late input'), false);
    await closed;
    assert.equal(socket.closed, true);
    assert.equal(socket.socket.destroyed, true);
  } finally {
    socket?.destroy();
    await peer.close();
  }
});
