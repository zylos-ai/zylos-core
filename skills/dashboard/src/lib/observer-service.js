import { isSameOriginRequest } from './request-origin.js';
import { observerFrameDocument } from './observer-frame.js';
import { readJsonBody, sendJson } from './http.js';
import { ObserverManagerError } from './observer-manager.js';
import { ObserverUpstream } from './observer-upstream.js';
import { ObserverSizeMonitor } from './observer-size-monitor.js';
import { validAgentSize } from '../../public/js/observer-size.js';
import {
  acceptObserverWebSocket,
  rejectObserverUpgrade,
} from './observer-websocket.js';

const OBSERVER_PROTOCOL = 'zylos-observer-v1';
const LEASE_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REVALIDATE_MS = 10_000;
const MAX_STARTUP_DISPLAY_BYTES = 2 * 1024 * 1024;

class ObserverHttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function firstHeader(value) {
  return String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
}

// Accepts the Observer protocol, one lease token and an optional one-time
// ticket token, in any order. Unknown or repeated tokens are rejected.
function parseProtocol(value) {
  const parts = String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 3 || parts.filter((part) => part === OBSERVER_PROTOCOL).length !== 1) return null;
  const leases = parts.filter((part) => part.startsWith('lease.')).map((part) => part.slice('lease.'.length));
  const tickets = parts.filter((part) => part.startsWith('ticket.')).map((part) => part.slice('ticket.'.length));
  if (leases.length !== 1 || tickets.length > 1 || 1 + leases.length + tickets.length !== parts.length) return null;
  if (!LEASE_ID_PATTERN.test(leases[0]) || (tickets.length && !TICKET_PATTERN.test(tickets[0]))) return null;
  return { leaseId: leases[0], ticket: tickets[0] || null };
}

function parseAgentSize(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('cols') || !keys.includes('rows')) return null;
  return validAgentSize(body) ? { cols: body.cols, rows: body.rows } : null;
}

function errorStatus(error) {
  if (error instanceof ObserverHttpError) return error.status;
  switch (error?.code) {
    case 'auth_required': return 401;
    case 'admin_required':
    case 'insufficient_scope':
    case 'origin_required': return 403;
    case 'lease_not_found':
    case 'lease_expired':
    case 'lease_mismatch':
    case 'observer_disabled':
    case 'artifact_unavailable':
    case 'not_installed': return 404;
    case 'capacity_exceeded': return 429;
    case 'lease_in_use':
    case 'agent_session_unavailable':
    case 'observer_starting': return 409;
    case 'invalid_size': return 400;
    case 'agent_resize_failed': return 500;
    case 'target_mismatch': return 400;
    case 'unsupported_platform': return 501;
    default: return 503;
  }
}

function publicError(error) {
  const code = error?.code || 'observer_unavailable';
  return { status: errorStatus(error), code };
}

function publicStatus(status) {
  const { binaryPath: _binaryPath, ...installation } = status || {};
  return installation;
}

export class ObserverService {
  constructor({ coordinator, containment, manager, authGate, upstreamFactory, ensureCoordinatorOwnership, historyService, sizeMonitor }) {
    this.coordinator = coordinator;
    this.historyService = historyService;
    this.containment = containment;
    this.manager = manager;
    this.authGate = authGate;
    this.upstreamFactory = upstreamFactory || ((options) => new ObserverUpstream(options));
    this.ensureCoordinatorOwnership = ensureCoordinatorOwnership || (async () => {});
    this.streams = new Set();
    this.sizeMonitor = sizeMonitor || new ObserverSizeMonitor();
    this.sizeMonitor.onChange = (size, active) => this._resizeStreams(size, active);
    this._startup = null;
    this._agentResize = Promise.resolve();
    this._initialized = false;
    this.startupError = null;
    this.containment.on?.('failure', (error, active) => {
      if (active && active !== this.containment.active) return;
      this.manager.handleContainmentFailure(error, active).catch(() => {});
      this._closeAllStreams(1011, 'child_failure');
    });
  }

  startup() {
    if (this._startup) return this._startup;
    this._startup = (async () => {
      await this.ensureCoordinatorOwnership();
      await this.containment.reconcilePersisted();
      const status = await this.coordinator.reconcileStartup();
      this.startupError = null;
      return status;
    })().catch((error) => {
      this.startupError = error;
      return null;
    }).finally(() => { this._initialized = true; });
    return this._startup;
  }

  _authContext(req, { requireOrigin = false } = {}) {
    if (!this.authGate.enabled) throw new ObserverHttpError(401, 'auth_required');
    const context = req._authContext || this.authGate.resolveAuthContext(req);
    if (!context) throw new ObserverHttpError(401, 'unauthorized');
    if (context.scope !== 'admin') throw new ObserverHttpError(403, 'insufficient_scope');
    if (requireOrigin && context.kind === 'cookie' && !isSameOriginRequest(req)) {
      throw new ObserverHttpError(403, 'origin_required');
    }
    return context;
  }

  async _ready({ allowRecovery = false } = {}) {
    await this.startup();
    if (this.startupError && !allowRecovery) throw this.startupError;
  }

  // Serialized so the remembered size always matches the last applied resize.
  _setAgentSize(size) {
    const operation = async () => {
      if (this.manager.isStarting()) throw new ObserverHttpError(409, 'observer_starting');
      let applied;
      try {
        applied = await this.containment.resizeAgent({ runtime: this.manager.runtime, ...size });
      } catch (error) {
        if (error?.code === 'target_unavailable') throw new ObserverHttpError(409, 'agent_session_unavailable');
        if (['invalid_size', 'unsupported_platform', 'unsupported_runtime'].includes(error?.code)) throw error;
        throw new ObserverHttpError(500, 'agent_resize_failed');
      }
      const agentSize = await this.coordinator.saveAgentSize(size);
      // Viewers follow on the next poll; polling now only shortens the wait.
      if (this.sizeMonitor.active) this.sizeMonitor.poll();
      return { agentSize, applied };
    };
    const result = this._agentResize.then(operation, operation);
    this._agentResize = result.catch(() => {});
    return result;
  }

  async _resizeStreams(size, active) {
    if (active !== this.containment.active) return;
    if (!await this.containment.resize(active, size)) throw new Error('Observer generation changed during resize');
    if (active !== this.containment.active) return;
    for (const stream of this.streams) {
      if (stream.closed || stream.active !== active || !stream.connected) continue;
      stream.upstream.resize(size);
      stream.downstream?.sendText(JSON.stringify({ type: 'size', ...size }));
    }
  }

  _closeLeaseStreams(leaseId, code = 1000, reason = 'lease_closed') {
    for (const stream of [...this.streams]) {
      if (stream.leaseId === leaseId) this._closeStream(stream, code, reason);
    }
  }

  _closeAllStreams(code = 1001, reason = 'observer_stopped') {
    for (const stream of [...this.streams]) this._closeStream(stream, code, reason);
  }

  _closeStream(stream, code, reason) {
    if (stream.closed) return;
    stream.closed = true;
    clearInterval(stream.timer);
    stream.startupDisplay = [];
    stream.startupDisplayBytes = 0;
    stream.upstream?.close();
    if (stream.downstream) stream.downstream.close(code, reason);
    else stream.socket?.destroy();
    this.streams.delete(stream);
    if (!this.streams.size) this.sizeMonitor.stop();
    try { this.manager.releaseLease(stream.leaseId, stream.context); } catch {}
  }

  async handle(req, res, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/observer') && !pathname.startsWith('/observer/')) return false;
    try {
      if (pathname === '/observer/frame') {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new ObserverHttpError(405, 'method_not_allowed');
        await this._ready();
        const context = this._authContext(req);
        const leaseId = firstHeader(req.headers['x-observer-lease']);
        if (!LEASE_ID_PATTERN.test(leaseId)) throw new ObserverHttpError(404, 'lease_not_found');
        this.manager.validateLease(leaseId, context);
        const body = req.method === 'HEAD' ? '' : observerFrameDocument();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'",
          'X-Frame-Options': 'SAMEORIGIN',
        });
        res.end(body);
        return true;
      }

      const context = this._authContext(req, { requireOrigin: req.method !== 'GET' && req.method !== 'HEAD' });
      if (pathname.startsWith('/api/observer/history/')) {
        if (!this.historyService) throw new ObserverHttpError(404, 'not_found');
        // File history must never start/reconcile containment or acquire a lease.
        const status = await this.coordinator.historyStatus();
        if (status.state !== 'installed' || !status.desired?.enabled) throw new ObserverHttpError(404, 'observer_disabled');
        return await this.historyService.handle(req, res, url);
      }
      if (pathname === '/api/observer/status' && req.method === 'GET') {
        await this._ready({ allowRecovery: true });
        const status = await this.coordinator.status();
        sendJson(res, 200, {
          ...publicStatus(status),
          startupError: this.startupError?.code || null,
          runtime: this.manager.runtimeStatus(),
          agentSize: await this.coordinator.agentSize(),
        });
        return true;
      }
      if (pathname === '/api/observer/agent-size' && req.method === 'POST') {
        await this._ready();
        let body;
        try { body = await readJsonBody(req, 1024); } catch { throw new ObserverHttpError(400, 'invalid_size'); }
        const size = parseAgentSize(body);
        if (!size) throw new ObserverHttpError(400, 'invalid_size');
        sendJson(res, 200, await this._setAgentSize(size));
        return true;
      }
      if (pathname === '/api/observer/install' && req.method === 'POST') {
        await this._ready();
        await this.ensureCoordinatorOwnership();
        sendJson(res, 200, publicStatus(await this.coordinator.installAndEnable()));
        return true;
      }
      if (pathname === '/api/observer/enable' && req.method === 'POST') {
        await this._ready();
        await this.ensureCoordinatorOwnership();
        sendJson(res, 200, publicStatus(await this.coordinator.enable()));
        return true;
      }
      if (pathname === '/api/observer/disable' && req.method === 'POST') {
        await this._ready({ allowRecovery: true });
        await this.ensureCoordinatorOwnership();
        this._closeAllStreams(1001, 'disabled');
        const result = await this.manager.invalidateAndDisable();
        this.startupError = null;
        sendJson(res, 200, publicStatus(result));
        return true;
      }
      if (pathname === '/api/observer/install' && req.method === 'DELETE') {
        await this._ready({ allowRecovery: true });
        await this.ensureCoordinatorOwnership();
        this._closeAllStreams(1001, 'uninstalled');
        const result = await this.manager.invalidateAndUninstall();
        this.startupError = null;
        sendJson(res, 200, publicStatus(result));
        return true;
      }
      if (pathname === '/api/observer/leases' && req.method === 'POST') {
        await this._ready();
        await this.ensureCoordinatorOwnership();
        sendJson(res, 201, await this.manager.createLease(context, { runId: req.headers['x-observer-run'] }));
        return true;
      }
      const leaseRoute = pathname.match(/^\/api\/observer\/leases\/([A-Za-z0-9_-]{32})\/(renew|release)$/);
      if (leaseRoute && req.method === 'POST') {
        await this._ready();
        const [, leaseId, action] = leaseRoute;
        if (action === 'renew') {
          sendJson(res, 200, this.manager.renewLease(leaseId, context));
          return true;
        }
        if (action === 'release') {
          try { this.manager.releaseLease(leaseId, context); } catch (error) {
            if (!(error instanceof ObserverManagerError) || error.code !== 'lease_not_found') throw error;
          }
          this._closeLeaseStreams(leaseId, 1000, 'released');
          sendJson(res, 200, { released: true });
          return true;
        }
      }
      throw new ObserverHttpError(404, 'not_found');
    } catch (error) {
      const result = publicError(error);
      // Set size reports the live height limit when status lines reduce it.
      const detail = result.code === 'invalid_size' && Number.isInteger(error?.maxRows) ? { maxRows: error.maxRows } : {};
      sendJson(res, result.status, { error: result.code, ...detail });
      return true;
    }
  }

  async handleUpgrade(req, socket, head) {
    let upstream;
    let stream;
    let aborted = false;
    let awaitingAdmission = true;
    const closeAbortedDownstream = () => {
      aborted = true;
      if (stream) this._closeStream(stream, 1001, 'client_aborted');
      else if (!socket.writableEnded) socket.destroy();
    };
    // Own socket failures before any rejection can write a response.
    socket.on('error', closeAbortedDownstream);
    socket.on('data', () => { if (awaitingAdmission) closeAbortedDownstream(); });
    socket.on('end', closeAbortedDownstream);
    socket.on('close', closeAbortedDownstream);
    try {
      let url;
      try { url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`); } catch {
        throw new ObserverHttpError(400, 'invalid_request');
      }
      if (url.pathname !== '/observer/stream' || url.search) {
        rejectObserverUpgrade(socket, 404, 'not_found');
        return true;
      }
      await this._ready();
      if (aborted || socket.destroyed || socket.writableEnded) return true;
      const context = this._authContext(req);
      const protocol = parseProtocol(req.headers['sec-websocket-protocol']);
      // Chromium omits Fetch Metadata on WebSocket handshakes, so a proxy that
      // rewrites Host defeats the Origin fallback. A one-time ticket from the
      // origin-checked lease response substitutes only for that fallback.
      if (context.kind === 'cookie' && !isSameOriginRequest(req) &&
          !(protocol?.ticket && !Object.hasOwn(req.headers, 'sec-fetch-site') &&
            this.manager.consumeTicket(protocol.ticket, protocol.leaseId, context))) {
        throw new ObserverHttpError(403, 'origin_required');
      }
      if (!protocol) throw new ObserverHttpError(404, 'invalid_protocol');
      const { leaseId } = protocol;
      const lease = this.manager.validateLease(leaseId, context);
      if ([...this.streams].some((current) => current.leaseId === leaseId && !current.closed)) {
        throw Object.assign(new Error('Observer lease already has a stream'), { code: 'lease_in_use' });
      }
      const active = this.containment.active;
      upstream = this.upstreamFactory({ active });
      stream = {
        leaseId, context, lease, upstream, socket, active, connected: false,
        downstream: null, timer: null, closed: false, awaitingPong: false,
        startupDisplay: [], startupDisplayBytes: 0,
      };
      this.streams.add(stream);
      stream.timer = setInterval(() => {
        try {
          if (stream.downstream && stream.awaitingPong) throw new Error('pong_timeout');
          const refreshed = this.authGate.revalidateAuthContext(stream.context);
          if (!refreshed) throw new Error('auth_expired');
          stream.context = refreshed;
          stream.lease = this.manager.validateLease(stream.leaseId, refreshed);
          if (stream.downstream) {
            stream.awaitingPong = true;
            stream.downstream.ping();
          }
        } catch (error) {
          const code = error?.code || error?.message || 'unknown';
          const reason = code === 'pong_timeout' ? 'pong_timeout'
            : ['auth_expired', 'admin_required'].includes(code) ? 'auth_expired' : 'lease_invalid';
          const logCode = String(code).replace(/[^\w-]/g, '_').slice(0, 80);
          console.error(`[observer] stream closed: ${reason} (${logCode}) lease=${stream.leaseId.slice(0, 8)}…`);
          this._closeStream(stream, 1008, reason);
        }
      }, REVALIDATE_MS);
      stream.timer.unref?.();
      await this.sizeMonitor.start(active);
      if (stream.closed || active !== this.containment.active) throw new Error('Observer generation changed');
      const initialSize = this.sizeMonitor.size;
      await upstream.connect({
        size: initialSize,
        onDisplay: (payload) => {
          if (stream.closed) return;
          if (stream.downstream) {
            stream.downstream.sendBinary(payload);
            return;
          }
          const buffered = Buffer.from(payload);
          stream.startupDisplayBytes += buffered.length;
          if (stream.startupDisplayBytes > MAX_STARTUP_DISPLAY_BYTES) {
            this._closeStream(stream, 1009, 'startup_display_overflow');
            return;
          }
          stream.startupDisplay.push(buffered);
        },
        onClose: () => this._closeStream(stream, 1011, 'upstream_closed'),
      });
      if (stream.closed || socket.destroyed || socket.writableEnded) {
        this._closeStream(stream, 1001, 'client_aborted');
        throw new Error('Observer downstream closed during handshake');
      }
      if (active !== this.containment.active) throw new Error('Observer generation changed');
      stream.connected = true;
      const size = this.sizeMonitor.size;
      if (size.cols !== initialSize.cols || size.rows !== initialSize.rows) upstream.resize(size);
      const refreshed = this.authGate.revalidateAuthContext(stream.context);
      if (!refreshed) throw new ObserverHttpError(401, 'unauthorized');
      stream.context = refreshed;
      stream.lease = this.manager.validateLease(stream.leaseId, refreshed);
      awaitingAdmission = false;
      stream.downstream = acceptObserverWebSocket(req, socket, head, OBSERVER_PROTOCOL);
      stream.downstream.on('message', () => this._closeStream(stream, 1008, 'input_forbidden'));
      stream.downstream.on('error', () => this._closeStream(stream, 1011, 'stream_error'));
      stream.downstream.on('close', () => this._closeStream(stream, 1000, 'client_closed'));
      stream.downstream.on('pong', () => { stream.awaitingPong = false; });
      stream.downstream.sendText(JSON.stringify({ type: 'size', ...size }));
      for (const payload of stream.startupDisplay) {
        stream.downstream.sendBinary(payload);
        if (stream.downstream.closed || stream.downstream.closing) break;
      }
      stream.startupDisplay = [];
      stream.startupDisplayBytes = 0;
      stream.downstream.activate();
      return true;
    } catch (error) {
      upstream?.close();
      if (stream?.downstream) this._closeStream(stream, 1011, 'observer_unavailable');
      else if (stream?.closed) this.streams.delete(stream);
      else {
        clearInterval(stream?.timer);
        if (stream) this.streams.delete(stream);
        const result = publicError(error);
        if (!socket.destroyed && !socket.writableEnded) rejectObserverUpgrade(socket, result.status, result.code);
      }
      if (!this.streams.size) this.sizeMonitor.stop();
      return true;
    }
  }

  async shutdown(reason = 'dashboard_shutdown') {
    await this.historyService?.close();
    await this.ensureCoordinatorOwnership();
    this._closeAllStreams(1001, reason);
    return this.manager.shutdown(reason);
  }

  async preUninstall() {
    await this._ready({ allowRecovery: true });
    await this.ensureCoordinatorOwnership();
    this._closeAllStreams(1001, 'component_uninstall');
    const result = await this.manager.invalidateAndUninstall();
    this.startupError = null;
    return result;
  }
}

export const OBSERVER_WEBSOCKET_PROTOCOL = OBSERVER_PROTOCOL;
