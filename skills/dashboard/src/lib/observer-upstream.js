import fs from 'node:fs';
import { DEFAULT_OBSERVER_SIZE, validObserverSize } from '../../public/js/observer-size.js';
import { connectObserverWebSocket } from './observer-websocket.js';

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_TOKEN_FILE_BYTES = 4 * 1024;

async function readPrivateToken(filePath) {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TOKEN_FILE_BYTES) {
    throw new Error('unsafe Observer token file');
  }
  const text = await fs.promises.readFile(filePath, 'utf8');
  const match = text.match(/^token_[0-9]+:\s*([0-9a-f-]{36})(?:\s|$)/m);
  if (!match) throw new Error('invalid Observer token record');
  return match[1];
}

async function boundedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 64 * 1024) throw new Error('upstream response too large');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 64 * 1024) throw new Error('upstream response too large');
  return JSON.parse(buffer.toString('utf8'));
}

export class ObserverUpstream {
  constructor({ active, fetchImpl = globalThis.fetch }) {
    this.active = active;
    this.fetch = fetchImpl;
    this.control = null;
    this.terminal = null;
    this.webClientId = null;
    this.closed = false;
    this.abortController = new AbortController();
  }

  _signal() {
    return AbortSignal.any([this.abortController.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  }

  _assertOpen() {
    if (this.closed) throw new Error('Observer upstream closed');
  }

  async connect({ size = DEFAULT_OBSERVER_SIZE, onDisplay, onClose }) {
    this._assertOpen();
    if (!validObserverSize(size)) throw new Error('invalid Observer size');
    const authToken = await readPrivateToken(this.active.tokenFile);
    const origin = `http://127.0.0.1:${this.active.port}`;
    const login = await this.fetch(`${origin}/command/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_token: authToken, remember_me: false }),
      signal: this._signal(),
    });
    this._assertOpen();
    if (login.status !== 200) throw new Error(`Observer upstream login failed (${login.status})`);
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    if (!cookie?.startsWith('session_token=')) throw new Error('Observer upstream login returned no session cookie');
    const session = await this.fetch(
      `${origin}/session?session=${encodeURIComponent(this.active.sessionName)}&welcome=false`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        signal: this._signal(),
      },
    );
    this._assertOpen();
    if (session.status !== 200) throw new Error(`Observer upstream session failed (${session.status})`);
    const boot = await boundedJson(session);
    if (boot.is_read_only !== true || boot.session_name !== this.active.sessionName ||
        typeof boot.web_client_id !== 'string' || !boot.web_client_id) {
      throw new Error('Observer upstream returned an unsafe watcher session');
    }
    this.webClientId = boot.web_client_id;
    this.control = await connectObserverWebSocket({
      port: this.active.port,
      path: `/ws/control?web_client_id=${encodeURIComponent(boot.web_client_id)}`,
      headers: { Cookie: cookie },
      signal: this.abortController.signal,
    });
    this._assertOpen();
    this.terminal = await connectObserverWebSocket({
      port: this.active.port,
      path: `/ws/terminal/${encodeURIComponent(this.active.sessionName)}?web_client_id=${encodeURIComponent(boot.web_client_id)}&rows=${size.rows}&cols=${size.cols}`,
      headers: { Cookie: cookie },
      signal: this.abortController.signal,
    });
    this._assertOpen();
    const close = () => {
      if (this.closed) return;
      this.closed = true;
      this.control?.close();
      this.terminal?.close();
      onClose?.();
    };
    this.control.on('error', close);
    this.terminal.on('error', close);
    this.control.on('close', close);
    this.terminal.on('close', close);
    this.terminal.on('message', (message) => {
      if (this.closed) return;
      const payload = Buffer.isBuffer(message) ? message : Buffer.from(message);
      if (payload.length <= 256 * 1024) onDisplay?.(payload);
    });
    this.control.activate();
    this.terminal.activate();
    return this;
  }

  resize(size) {
    if (!validObserverSize(size) || this.closed || !this.control || !this.webClientId) return false;
    return this.control.sendText(JSON.stringify({
      web_client_id: this.webClientId,
      payload: { type: 'TerminalResize', rows: size.rows, cols: size.cols },
    }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    this.control?.close();
    this.terminal?.close();
  }
}
