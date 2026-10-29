import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;

function headerHasToken(value, token) {
  return String(value || '').split(',').some((item) => item.trim().toLowerCase() === token);
}

function acceptValue(key) {
  return crypto.createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
}

function encodeFrame(opcode, payload, masked) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const maskLength = masked ? 4 : 0;
  let headerLength = 2;
  if (body.length >= 126 && body.length <= 0xffff) headerLength += 2;
  else if (body.length > 0xffff) headerLength += 8;
  const frame = Buffer.allocUnsafe(headerLength + maskLength + body.length);
  frame[0] = 0x80 | opcode;
  let offset = 2;
  if (body.length < 126) frame[1] = (masked ? 0x80 : 0) | body.length;
  else if (body.length <= 0xffff) {
    frame[1] = (masked ? 0x80 : 0) | 126;
    frame.writeUInt16BE(body.length, 2);
    offset = 4;
  } else {
    frame[1] = (masked ? 0x80 : 0) | 127;
    frame.writeBigUInt64BE(BigInt(body.length), 2);
    offset = 10;
  }
  if (!masked) {
    body.copy(frame, offset);
    return frame;
  }
  const mask = crypto.randomBytes(4);
  mask.copy(frame, offset);
  offset += 4;
  for (let index = 0; index < body.length; index += 1) frame[offset + index] = body[index] ^ mask[index % 4];
  return frame;
}

export class ObserverWebSocket extends EventEmitter {
  constructor(socket, {
    maskedInbound,
    maskOutbound,
    head = Buffer.alloc(0),
    maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
    maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
  }) {
    super();
    this.socket = socket;
    this.maskedInbound = maskedInbound;
    this.maskOutbound = maskOutbound;
    this.maxMessageBytes = maxMessageBytes;
    this.maxQueuedBytes = maxQueuedBytes;
    this.closeTimeoutMs = closeTimeoutMs;
    this.buffer = Buffer.from(head);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.closed = false;
    this.closing = false;
    this.active = false;
    this.closeTimer = null;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      if (this.closing || this.closed) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (!this.active && this.buffer.length > this.maxQueuedBytes) {
        this._emitError(new Error('WebSocket startup buffer exceeded'));
        this.destroy();
        return;
      }
      if (!this.active) return;
      try { this._drain(); } catch (error) { this._emitError(error); this.destroy(); }
    });
    socket.on('error', (error) => this._emitError(error));
    socket.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.closing = false;
      clearTimeout(this.closeTimer);
      this.emit('close');
    });
  }

  activate() {
    if (this.active || this.closing || this.closed) return false;
    if (this.buffer.length > this.maxQueuedBytes) {
      this._emitError(new Error('WebSocket startup buffer exceeded'));
      this.destroy();
      return false;
    }
    this.active = true;
    if (this.buffer.length) {
      try { this._drain(); } catch (error) { this._emitError(error); this.destroy(); return false; }
    }
    return !this.closed;
  }

  sendBinary(payload) { return this._send(0x2, payload); }
  sendText(text) { return this._send(0x1, Buffer.from(text)); }
  ping(payload = Buffer.alloc(0)) { return this._send(0x9, payload); }

  close(code = 1000, reason = '') {
    if (this.closed || this.closing) return;
    const reasonBytes = Buffer.from(String(reason));
    const payload = Buffer.allocUnsafe(2 + Math.min(reasonBytes.length, 123));
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2, 0, payload.length - 2);
    this.closing = true;
    this.active = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    try {
      if (!this.socket.destroyed && !this.socket.writableEnded) {
        this.socket.write(encodeFrame(0x8, payload, this.maskOutbound));
      }
    } catch {}
    this.closeTimer = setTimeout(() => this.destroy(), this.closeTimeoutMs);
    this.closeTimer.unref?.();
    this.socket.end();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.closing = false;
    clearTimeout(this.closeTimer);
    this.socket.destroy();
    this.emit('close');
  }

  _emitError(error) {
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  _send(opcode, payload) {
    if (this.closed || this.closing || this.socket.destroyed || this.socket.writableEnded) return false;
    const frame = encodeFrame(opcode, payload, this.maskOutbound);
    if (this.socket.writableLength + frame.length > this.maxQueuedBytes) {
      this.close(1009, 'slow_consumer');
      return false;
    }
    return this.socket.write(frame);
  }

  _drain() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      if ((first & 0x70) !== 0) throw new Error('unsupported WebSocket extension bits');
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      if (masked !== this.maskedInbound) throw new Error('invalid WebSocket masking');
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const value = this.buffer.readBigUInt64BE(2);
        if (value > BigInt(this.maxMessageBytes)) throw new Error('WebSocket frame too large');
        length = Number(value);
        offset = 10;
      }
      if (length > this.maxMessageBytes) throw new Error('WebSocket frame too large');
      if (opcode >= 0x8 && (!fin || length > 125)) throw new Error('invalid WebSocket control frame');
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskLength;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

      if (opcode === 0x8) {
        if (!this.closed && !this.closing) {
          this.closing = true;
          this.active = false;
          try {
            if (!this.socket.destroyed && !this.socket.writableEnded) {
              this.socket.write(encodeFrame(0x8, payload, this.maskOutbound));
            }
          } catch {}
          this.closeTimer = setTimeout(() => this.destroy(), this.closeTimeoutMs);
          this.closeTimer.unref?.();
          this.socket.end();
        }
        return;
      }
      if (opcode === 0x9) { this._send(0xA, payload); this.emit('ping', payload); continue; }
      if (opcode === 0xA) { this.emit('pong', payload); continue; }
      if (opcode === 0x0) {
        if (this.fragmentOpcode === null) throw new Error('unexpected continuation frame');
        this.fragments.push(payload);
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (this.fragmentOpcode !== null) throw new Error('interleaved fragmented message');
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
      } else {
        throw new Error(`unsupported WebSocket opcode ${opcode}`);
      }
      const total = this.fragments.reduce((sum, part) => sum + part.length, 0);
      if (total > this.maxMessageBytes) throw new Error('WebSocket message too large');
      if (!fin) continue;
      const message = Buffer.concat(this.fragments, total);
      const messageOpcode = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentOpcode = null;
      this.emit('message', messageOpcode === 0x1 ? message.toString('utf8') : message, messageOpcode);
    }
  }
}

export function acceptObserverWebSocket(req, socket, head, protocol) {
  const key = String(req.headers['sec-websocket-key'] || '');
  if (!headerHasToken(req.headers.connection, 'upgrade') ||
      String(req.headers.upgrade || '').toLowerCase() !== 'websocket' ||
      req.headers['sec-websocket-version'] !== '13' ||
      !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    throw new Error('invalid WebSocket handshake');
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptValue(key)}`,
    `Sec-WebSocket-Protocol: ${protocol}`,
    '',
    '',
  ].join('\r\n'));
  return new ObserverWebSocket(socket, { maskedInbound: true, maskOutbound: false, head });
}

export function rejectObserverUpgrade(socket, status = 404, code = 'not_found') {
  const body = JSON.stringify({ error: code });
  const reason = status === 400 ? 'Bad Request' : status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' :
    status === 429 ? 'Too Many Requests' : status === 502 ? 'Bad Gateway' : status === 503 ? 'Service Unavailable' : 'Not Found';
  socket.end([
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    'Cache-Control: no-store',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'));
}

export async function connectObserverWebSocket({
  host = '127.0.0.1', port, path, headers = {}, timeoutMs = 5_000,
  secure = false, servername = host,
  closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
  maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES,
  signal,
}) {
  if (signal?.aborted) throw new Error('WebSocket connect aborted');
  const key = crypto.randomBytes(16).toString('base64');
  const socket = secure
    ? tls.connect({ host, port, servername })
    : net.createConnection({ host, port });
  socket.setNoDelay(true);
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { cleanup(); socket.destroy(); reject(new Error('WebSocket connect aborted')); };
    const timeout = setTimeout(() => { cleanup(); socket.destroy(); reject(new Error('WebSocket connect timeout')); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once(secure ? 'secureConnect' : 'connect', () => { cleanup(); resolve(); });
    socket.once('error', (error) => { cleanup(); reject(error); });
  });
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}:${port}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${key}`,
  ];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  socket.write([...lines, '', ''].join('\r\n'));
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => { cleanup(); socket.destroy(); reject(new Error('WebSocket handshake timeout')); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onClose);
      socket.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { cleanup(); socket.destroy(); reject(new Error('WebSocket handshake aborted')); };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('WebSocket handshake closed')); };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf('\r\n\r\n');
      if (boundary < 0) {
        if (buffer.length > 16 * 1024) onError(new Error('WebSocket response headers too large'));
        return;
      }
      const head = buffer.subarray(0, boundary).toString('latin1');
      const remainder = buffer.subarray(boundary + 4);
      const responseLines = head.split('\r\n');
      const status = Number(responseLines[0].split(' ')[1]);
      const responseHeaders = new Map(responseLines.slice(1).map((line) => {
        const index = line.indexOf(':');
        return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
      }));
      if (status !== 101 || responseHeaders.get('sec-websocket-accept') !== acceptValue(key)) {
        cleanup(); socket.destroy(); reject(new Error(`WebSocket handshake rejected (${status})`));
        return;
      }
      cleanup();
      resolve(new ObserverWebSocket(socket, {
        maskedInbound: false,
        maskOutbound: true,
        head: remainder,
        closeTimeoutMs,
        maxQueuedBytes,
      }));
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onClose);
    socket.on('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
