import { isSameOriginRequest } from './request-origin.js';
import { CHAT_SETTINGS_PATH } from './chat/access.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { once } from 'node:events';
import { browserPath, browserBaseFromRequest } from './browser-base.js';
import { sendHtml, sendJson, sendText, serveStatic } from './http.js';
import { validateMemoryQueryPath } from './memory-browser.js';
import {
  acceptObserverWebSocket,
  connectObserverWebSocket,
  rejectObserverUpgrade,
} from './observer-websocket.js';

import { SECRET_PATTERN } from './redaction/dashboard-secret-pattern.js';
const STREAM_GUARD_TAIL_CHARS = 128;
const MAX_WRITE_BODY_BYTES = 1024 * 1024;
const MAX_MEMORY_WRITE_BODY_BYTES = 2 * 1024 * 1024 + 64 * 1024;
const OBSERVER_TICKET_TTL_MS = 30_000;
const MAX_OBSERVER_TICKETS_PER_LEASE = 3;

function decodeAgentName(value) {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return '';
  }
}

function stripHopByHop(headers) {
  const result = {};
  const blocked = new Set([
    'connection',
    'content-length',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'authorization',
    'cookie',
    'set-cookie',
    // undici fetch decompresses upstream bodies; forwarding the upstream
    // content-encoding (e.g. gzip added by Cloudflare in front of a producer)
    // would make browsers decode plain bytes and fail (#255). Stripping
    // accept-encoding from forwarded requests keeps undici's own negotiation
    // (and therefore its auto-decompression) deterministic.
    'accept-encoding',
    'content-encoding'
  ]);
  for (const [key, value] of Object.entries(headers || {})) {
    if (!blocked.has(key.toLowerCase()) && value !== undefined) result[key] = value;
  }
  return result;
}

function remoteUrl(agent, remotePath, search = '') {
  const base = String(agent.base_url || '').replace(/\/+$/, '');
  const cleanPath = String(remotePath || '').replace(/^\/+/, '');
  return `${base}/${cleanPath}${search || ''}`;
}

function containsSecret(value) {
  return SECRET_PATTERN.test(String(value || ''));
}

function isSseResponse(resp) {
  return /\btext\/event-stream\b/i.test(resp.headers.get('content-type') || '');
}

function isAllowedProxyWrite(method, suffix) {
  return method === 'PATCH' && /^\/api\/chat\/conversations\/[^/]+$/.test(suffix) ||
    method === 'POST' && (suffix === '/api/chat/drafts' || /^\/api\/chat\/conversations\/[^/]+\/(?:send|answers|uploads)$/.test(suffix)) ||
    ['PUT', 'DELETE'].includes(method) && /^\/api\/workbench\/groups\/[^/]+\/name$/.test(suffix) ||
    method === 'POST' && /^\/api\/workbench\/groups\/[^/]+\/(?:config|actions\/(?:interrupt|chop-chop|restart))$/.test(suffix) ||
    method === 'POST' && /^\/api\/workbench\/schedule(?:\/[^/]+\/(?:pause|resume))?$/.test(suffix) ||
    ['PUT', 'DELETE'].includes(method) && /^\/api\/workbench\/schedule\/[^/]+$/.test(suffix) ||
    method === 'POST' && /^\/api\/actions\/[^/]+$/.test(suffix) ||
    method === 'PUT' && (suffix === '/api/settings' || suffix === '/api/memory/file') ||
    method === 'POST' && (
      /^\/api\/observer\/(?:install|enable|disable|leases|agent-size)$/.test(suffix) ||
      /^\/api\/observer\/leases\/[A-Za-z0-9_-]{32}\/(?:renew|release)$/.test(suffix)
    ) ||
    method === 'DELETE' && suffix === '/api/observer/install';
}

function isObserverProxyRoute(method, suffix) {
  if (method === 'GET' || method === 'HEAD') {
    return suffix === '/api/observer/status' || suffix === '/observer/frame' ||
      method === 'GET' && /^\/api\/observer\/history\/(?:sessions|entries|content|search)$/.test(suffix);
  }
  return isAllowedProxyWrite(method, suffix) && suffix.startsWith('/api/observer/');
}

function samePrincipal(left, right) {
  return left?.kind === right?.kind && left?.principalId === right?.principalId &&
    left?.scope === 'admin' && right?.scope === 'admin';
}

function observerLeaseId(req, suffix) {
  if (suffix === '/observer/frame') return String(req.headers['x-observer-lease'] || '');
  return suffix.match(/^\/api\/observer\/leases\/([A-Za-z0-9_-]{32})\//)?.[1] || null;
}

function isLocalOnlyEndpoint(suffix) {
  return suffix === CHAT_SETTINGS_PATH || suffix === '/api/fleet/agents' ||
    suffix.startsWith('/api/fleet/agents/') ||
    suffix === '/api/agent/name' ||
    suffix === '/api/keys' ||
    suffix.startsWith('/api/keys/');
}

function normalizeProxySuffix(suffix) {
  const value = String(suffix || '/');
  if (/%2f/i.test(value)) return null;
  try {
    const decoded = decodeURIComponent(value);
    const normalized = path.posix.normalize(decoded);
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  } catch {
    return null;
  }
}

function validateMemoryProxyQuery(suffix, search) {
  if (suffix !== '/api/memory/file' && suffix !== '/api/memory/git') return true;
  try {
    const params = new URLSearchParams(search || '');
    validateMemoryQueryPath(params.get('path') || '');
    return true;
  } catch {
    return false;
  }
}

async function readBodyBuffer(req, maxBytes = MAX_WRITE_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const err = new Error('request_body_too_large');
      err.status = 413;
      throw err;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function createSecretGuard(token) {
  const tokenLiteral = String(token || '');
  return {
    minTailChars: Math.max(STREAM_GUARD_TAIL_CHARS, Math.max(0, tokenLiteral.length - 1)),
    contains(value) {
      const text = String(value || '');
      return (tokenLiteral && text.includes(tokenLiteral)) || containsSecret(text);
    }
  };
}

function headersContainSecret(headers, guard) {
  for (const [name, value] of Object.entries(headers || {})) {
    if (guard.contains(name)) return true;
    const values = Array.isArray(value) ? value : [value];
    if (values.some(v => guard.contains(v))) return true;
  }
  return false;
}

function guardedSseStream(guard, upstreamStream, onLeak) {
  let tail = '';
  let leaked = false;
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (leaked) {
        callback();
        return;
      }
      const text = chunk.toString('utf8');
      const combined = tail + text;
      if (guard.contains(combined)) {
        leaked = true;
        try { upstreamStream?.unpipe?.(this); } catch { /* upstream already closed */ }
        try { upstreamStream?.destroy?.(); } catch { /* upstream already closed */ }
        onLeak();
        this.push('event: proxy_error\ndata: {"error":"secret_leak_blocked"}\n\n');
        this.push(null);
        callback();
        return;
      }
      const tailChars = guard.minTailChars || STREAM_GUARD_TAIL_CHARS;
      if (combined.length <= tailChars) {
        tail = combined;
        callback();
        return;
      }
      const safeLength = combined.length - tailChars;
      this.push(combined.slice(0, safeLength));
      tail = combined.slice(safeLength);
      callback();
    },
    flush(callback) {
      if (!leaked && tail) this.push(tail);
      callback();
    }
  });
}

// Validate complete SSE records so a retained secret-guard tail cannot delay
// chat_ready or a dirty hint until the producer's next keepalive.
function guardedChatSseStream(guard, authorize) {
  let pending = '';
  const decoder = new TextDecoder();
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (!authorize()) return callback(new Error('chat_access_revoked'));
      pending += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(pending) > 64 * 1024) return callback(new Error('sse_record_too_large'));
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const end = boundary.index + boundary[0].length;
        const record = pending.slice(0, end);
        if (guard.contains(record)) return callback(new Error('secret_leak_blocked'));
        this.push(record);
        pending = pending.slice(end);
      }
      callback();
    },
    flush(callback) {
      // A truncated record is not an event and must not become one on close.
      pending = '';
      callback();
    }
  });
}

export class FleetProxy {
  constructor({ config, rootDir, poller, fetch, authGate, observerConnect = connectObserverWebSocket }) {
    this.config = config;
    this.rootDir = rootDir;
    this.poller = poller;
    this.fetch = fetch || globalThis.fetch;
    this.authGate = authGate;
    this.observerConnect = observerConnect;
    this.observerLeases = new Map();
    // Local one-time relay handshake tickets; the upstream hop uses Bearer.
    this.observerTickets = new Map();
    this.observerStreams = new Set();
  }

  pruneObserverLeases(now = Date.now()) {
    for (const [id, binding] of this.observerLeases) {
      if (!Number.isFinite(binding.expiresAt) || binding.expiresAt <= now) {
        this.observerLeases.delete(id);
        for (const stream of [...this.observerStreams]) if (stream.leaseId === id) stream.close();
      }
    }
    for (const [value, ticket] of this.observerTickets) {
      if (ticket.expiresAt <= now || !this.observerLeases.has(ticket.leaseId)) this.observerTickets.delete(value);
    }
  }

  mintObserverTicket(leaseId, binding, now = Date.now()) {
    const owned = [];
    for (const [value, ticket] of this.observerTickets) if (ticket.leaseId === leaseId) owned.push(value);
    // Map order is mint order, so the oldest tickets are dropped first.
    while (owned.length >= MAX_OBSERVER_TICKETS_PER_LEASE) this.observerTickets.delete(owned.shift());
    const value = crypto.randomBytes(32).toString('base64url');
    this.observerTickets.set(value, {
      leaseId, agentName: binding.agentName, principal: binding.principal, expiresAt: now + OBSERVER_TICKET_TTL_MS,
    });
    return value;
  }

  consumeObserverTicket(value, leaseId, agentName, context) {
    const ticket = typeof value === 'string' ? this.observerTickets.get(value) : undefined;
    if (!ticket) return false;
    this.observerTickets.delete(value);
    return ticket.expiresAt > Date.now() && ticket.leaseId === leaseId && ticket.agentName === agentName &&
      samePrincipal(ticket.principal, context);
  }

  async handle(req, res, url) {
    const match = url.pathname.match(/^\/fleet\/([^/]+)(\/.*)?$/);
    if (!match) return false;
    const agentName = decodeAgentName(match[1]);
    const suffix = match[2] || '/';
    const agent = this.config.fleet?.agents?.find(a => a.name === agentName);
    if (!agent) {
      sendJson(res, 404, { error: 'unknown_agent' });
      return true;
    }

    const normalizedSuffix = normalizeProxySuffix(suffix);
    if (!normalizedSuffix || isLocalOnlyEndpoint(normalizedSuffix)) {
      sendJson(res, 403, { error: 'local_endpoint_not_proxyable' });
      return true;
    }

    if (!validateMemoryProxyQuery(normalizedSuffix, url.search)) {
      sendJson(res, 400, { error: 'invalid_memory_path' });
      return true;
    }

    if (suffix === '/api/stream' || suffix.startsWith('/api/') || suffix === '/observer/frame') {
      await this.proxyApi(req, res, agent, suffix, url.search);
      return true;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'method not allowed');
      return true;
    }

    if (['/', '/index.html', '/trends', '/memory', '/observer', '/schedule', '/usage', '/settings', '/chat'].includes(suffix)) {
      // Include the reverse-proxy base path (X-Forwarded-Prefix, e.g. /dashboard)
      // so the browser requests assets/API under it. Caddy forwards everything
      // under /dashboard/* and strips the prefix before this handler runs, so
      // internal routing is unaffected; locally (no prefix) browserBase is '' and
      // the paths fall back to /fleet/<name>. See issue #159.
      const browserBase = browserBaseFromRequest(req);
      const prefix = browserPath(browserBase, `fleet/${encodeURIComponent(agent.name)}`);
      let access = 'read';
      try {
        await this.poller.getSessionToken(agent.name);
        access = this.poller.getAgentAccess?.(agent.name) === 'admin' ? 'admin' : 'read';
      } catch {
        access = 'read';
      }
      const html = fs.readFileSync(path.join(this.rootDir, 'index.html'), 'utf8')
        .replaceAll('__BASE_PATH__', prefix)
        .replaceAll('__ASSET_ROOT__', browserPath(prefix, '_assets'))
        .replaceAll('__REMOTE_ACCESS__', access);
      sendHtml(res, 200, html);
      return true;
    }

    const originalUrl = req.url;
    try {
      req.url = suffix;
      if (!serveStatic(req, res, this.rootDir)) {
        sendText(res, 404, 'not found');
      }
    } finally {
      req.url = originalUrl;
    }
    return true;
  }

  async proxyApi(req, res, agent, suffix, search) {
    const chatStream = suffix === '/api/stream' && new URLSearchParams(search).has('chat');
    if (suffix.startsWith('/api/chat/') || chatStream) {
      const context = req._authContext;
      if (context?.scope !== 'admin' || chatStream && this.authGate?.resolveAuthContext(req, { touch: false })?.scope !== 'admin') {
        sendJson(res, 403, { error: 'admin_required' });
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method) && context.kind === 'cookie' && !isSameOriginRequest(req)) {
        sendJson(res, 403, { error: 'origin_required' });
        return;
      }
    }
    if (suffix.startsWith('/api/observer/') || suffix.startsWith('/observer/')) {
      this.pruneObserverLeases();
      if (!isObserverProxyRoute(req.method, suffix)) {
        sendJson(res, 403, { error: 'observer_route_not_allowlisted' });
        return;
      }
      const context = req._authContext;
      if (!context || context.scope !== 'admin') {
        sendJson(res, 403, { error: 'admin_required' });
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method) && context.kind === 'cookie' && !isSameOriginRequest(req)) {
        sendJson(res, 403, { error: 'origin_required' });
        return;
      }
      const leaseId = observerLeaseId(req, suffix);
      if (leaseId) {
        const binding = this.observerLeases.get(leaseId);
        if (!binding || binding.agentName !== agent.name || !samePrincipal(binding.principal, context)) {
          sendJson(res, 404, { error: 'lease_not_found' });
          return;
        }
      }
    } else if (!['GET', 'HEAD'].includes(req.method) && !isAllowedProxyWrite(req.method, suffix)) {
      sendJson(res, 403, { error: 'read_only_proxy' });
      return;
    }

    let token;
    try {
      token = await this.poller.getSessionToken(agent.name);
    } catch (err) {
      sendJson(res, err.status || 502, { error: err.reason || err.message || 'proxy_auth_failed' });
      return;
    }

    const attachment = /^(\/api\/chat\/conversations\/[^/]+)\/(uploads|attachments\/[^/]+)$/.exec(suffix);
    if (attachment && (req.method === 'POST' && attachment[2] === 'uploads' ||
        req.method === 'GET' && attachment[2].startsWith('attachments/'))) {
      await this._relayAttachment(req, res, agent, suffix, search, token, attachment[1], attachment[2] === 'uploads');
      return;
    }

    // Owns the upstream fetch lifetime: aborting it is the only reliable way
    // to release the upstream connection when a relay is torn down (#257).
    const upstreamControl = new AbortController();
    let remoteResp;
    try {
      remoteResp = await this._fetchUpstream(req, agent, suffix, search, token, upstreamControl.signal);
      if (remoteResp.status === 401) {
        token = await this.poller.getSessionToken(agent.name, { force: true });
        remoteResp = await this._fetchUpstream(req, agent, suffix, search, token, upstreamControl.signal);
      }
    } catch (err) {
      if (err.status === 413) sendJson(res, 413, { error: 'request_body_too_large' });
      else sendJson(res, 502, { error: 'upstream_unreachable' });
      return;
    }

    const guard = createSecretGuard(token);
    if (req.method === 'HEAD') {
      const responseHeaders = stripHopByHop(Object.fromEntries(remoteResp.headers.entries()));
      responseHeaders['cache-control'] = 'no-store';
      if (headersContainSecret(responseHeaders, guard)) {
        process.stderr.write(`[fleet-proxy] blocked secret-bearing response headers from ${agent.name} ${suffix}\n`);
        sendJson(res, 502, { error: 'secret_leak_blocked' });
        return;
      }
      res.writeHead(remoteResp.status, responseHeaders);
      res.end();
      return;
    }
    if (!remoteResp.body) {
      const responseHeaders = stripHopByHop(Object.fromEntries(remoteResp.headers.entries()));
      responseHeaders['cache-control'] = 'no-store';
      if (headersContainSecret(responseHeaders, guard)) {
        process.stderr.write(`[fleet-proxy] blocked secret-bearing response headers from ${agent.name} ${suffix}\n`);
        sendJson(res, 502, { error: 'secret_leak_blocked' });
        return;
      }
      res.writeHead(remoteResp.status, responseHeaders);
      res.end();
      return;
    }
    if (isSseResponse(remoteResp)) {
      const responseHeaders = stripHopByHop(Object.fromEntries(remoteResp.headers.entries()));
      responseHeaders['cache-control'] = 'no-store';
      if (headersContainSecret(responseHeaders, guard)) {
        process.stderr.write(`[fleet-proxy] blocked secret-bearing SSE headers from ${agent.name} ${suffix}\n`);
        sendJson(res, 502, { error: 'secret_leak_blocked' });
        return;
      }
      res.writeHead(remoteResp.status, responseHeaders);
      const upstream = Readable.fromWeb(remoteResp.body);
      const chatAuthorized = () => this.authGate?.resolveAuthContext(req, { touch: false })?.scope === 'admin';
      const guarded = chatStream ? guardedChatSseStream(guard, chatAuthorized) : guardedSseStream(guard, upstream, () => {
        process.stderr.write(`[fleet-proxy] blocked secret-bearing SSE response from ${agent.name}\n`);
      });
      let chatValidationTimer;
      // pipe() does not propagate errors: an unhandled 'error' on any stream in
      // this chain would crash the whole process (#257). A failed relay must
      // only tear down its own connection; the browser's EventSource reconnects.
      const abortRelay = (err) => {
        if (err && err.name !== 'AbortError') {
          process.stderr.write(`[fleet-proxy] SSE relay from ${agent.name} aborted: ${err.message || err}\n`);
        }
        clearInterval(chatValidationTimer);
        upstreamControl.abort();
        upstream.destroy();
        guarded.destroy();
        if (!res.destroyed && !res.writableEnded) res.end();
      };
      if (chatStream) {
        chatValidationTimer = setInterval(() => { if (!chatAuthorized()) abortRelay(); }, 15000);
        chatValidationTimer.unref?.();
      }
      upstream.on('error', abortRelay);
      guarded.on('error', abortRelay);
      res.on('error', () => { /* client write failures surface via 'close' */ });
      res.on('close', () => abortRelay());
      guarded.on('end', () => clearInterval(chatValidationTimer));
      upstream.pipe(guarded).pipe(res);
    } else {
      let buffer;
      try {
        buffer = Buffer.from(await remoteResp.arrayBuffer());
      } catch (err) {
        process.stderr.write(`[fleet-proxy] upstream body read from ${agent.name} ${suffix} failed: ${err.message || err}\n`);
        sendJson(res, 502, { error: 'upstream_body_error' });
        return;
      }
      const text = buffer.toString('utf8');
      if (guard.contains(text)) {
        process.stderr.write(`[fleet-proxy] blocked secret-bearing response from ${agent.name} ${suffix}\n`);
        sendJson(res, 502, { error: 'secret_leak_blocked' });
        return;
      }
      const responseHeaders = stripHopByHop(Object.fromEntries(remoteResp.headers.entries()));
      responseHeaders['cache-control'] = 'no-store';
      if (headersContainSecret(responseHeaders, guard)) {
        process.stderr.write(`[fleet-proxy] blocked secret-bearing response headers from ${agent.name} ${suffix}\n`);
        sendJson(res, 502, { error: 'secret_leak_blocked' });
        return;
      }
      if (remoteResp.ok && req.method === 'POST' &&
          (suffix === '/api/observer/leases' || suffix.endsWith('/renew'))) {
        try {
          const lease = JSON.parse(text);
          if (/^[A-Za-z0-9_-]{32}$/.test(lease.id)) {
            const current = this.observerLeases.get(lease.id);
            if (!current || (current.agentName === agent.name && samePrincipal(current.principal, req._authContext))) {
              const binding = {
                agentName: agent.name,
                principal: req._authContext,
                expiresAt: Number(lease.expiresAt),
              };
              this.observerLeases.set(lease.id, binding);
              // The browser presents this local ticket to the relay; any
              // upstream ticket only serves the remote Dashboard's own check.
              buffer = Buffer.from(JSON.stringify({ ...lease, ticket: this.mintObserverTicket(lease.id, binding) }));
            }
          }
        } catch { /* malformed upstream response is returned and rejected by the browser */ }
      }
      const completedLease = observerLeaseId(req, suffix);
      if (completedLease && suffix.endsWith('/release') && remoteResp.ok) this.observerLeases.delete(completedLease);
      if ((suffix === '/api/observer/disable' || (suffix === '/api/observer/install' && req.method === 'DELETE')) && remoteResp.ok) {
        for (const [id, binding] of this.observerLeases) if (binding.agentName === agent.name) this.observerLeases.delete(id);
        for (const stream of [...this.observerStreams]) if (stream.agentName === agent.name) stream.close();
      }
      res.writeHead(remoteResp.status, responseHeaders);
      res.end(buffer);
    }
  }

  async handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`); } catch {
      socket.on('error', () => socket.destroy());
      rejectObserverUpgrade(socket, 400, 'invalid_request');
      return true;
    }
    const match = url.pathname.match(/^\/fleet\/([^/]+)\/observer\/stream$/);
    if (!match || url.search) return false;
    let upstream;
    let downstream;
    let revalidationTimer = null;
    let closed = false;
    let stream;
    let awaitingAdmission = true;
    const upstreamControl = new AbortController();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(revalidationTimer);
      upstreamControl.abort();
      upstream?.close(1000, 'relay_closed');
      downstream?.close(1000, 'relay_closed');
      // A pre-admission byte is not a socket close. Terminate that raw
      // connection, but let an already-ended rejection response drain.
      if (!downstream && !socket.writableEnded) socket.destroy();
      if (stream) this.observerStreams.delete(stream);
    };
    socket.on('error', close);
    socket.on('data', () => { if (awaitingAdmission) close(); });
    socket.on('end', close);
    socket.on('close', close);
    const agentName = decodeAgentName(match[1]);
    const agent = this.config.fleet?.agents?.find((candidate) => candidate.name === agentName);
    const context = req._authContext;
    const exactOrigin = isSameOriginRequest(req);
    const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map((value) => value.trim());
    const leaseId = protocols.find((value) => value.startsWith('lease.'))?.slice(6);
    const ticket = protocols.find((value) => value.startsWith('ticket.'))?.slice(7);
    this.pruneObserverLeases();
    const binding = leaseId && this.observerLeases.get(leaseId);
    // Chromium omits Fetch Metadata on WebSocket handshakes; a one-time ticket
    // from the origin-checked lease response replaces the Origin/Host fallback.
    if (!agent || !context || context.scope !== 'admin' || !binding ||
        binding.agentName !== agentName || !samePrincipal(binding.principal, context) ||
        (context.kind === 'cookie' && !exactOrigin && (Object.hasOwn(req.headers, 'sec-fetch-site') ||
          !this.consumeObserverTicket(ticket, leaseId, agentName, context)))) {
      rejectObserverUpgrade(socket, 404, 'lease_not_found');
      return true;
    }
    stream = { agentName, leaseId, close };
    try {
      let token = await this.poller.getSessionToken(agentName);
      if (closed || socket.destroyed || socket.writableEnded) return true;
      const target = new URL(remoteUrl(agent, '/observer/stream'));
      const connect = () => this.observerConnect({
        host: target.hostname,
        port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
        path: `${target.pathname}${target.search}`,
        secure: target.protocol === 'https:',
        servername: target.hostname,
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: `${target.protocol}//${target.host}`,
          'Sec-WebSocket-Protocol': `zylos-observer-v1, lease.${leaseId}`,
        },
        signal: upstreamControl.signal,
      });
      try { upstream = await connect(); } catch {
        if (closed || socket.destroyed || socket.writableEnded) return true;
        token = await this.poller.getSessionToken(agentName, { force: true });
        if (closed || socket.destroyed || socket.writableEnded) return true;
        upstream = await connect();
      }
      if (closed || socket.destroyed || socket.writableEnded) {
        upstream.close(1000, 'downstream_aborted');
        return true;
      }
      this.pruneObserverLeases();
      const refreshedContext = this.authGate?.revalidateAuthContext?.(context) || null;
      const currentBinding = this.observerLeases.get(leaseId);
      if (!refreshedContext || refreshedContext.scope !== 'admin' || !currentBinding ||
          currentBinding.expiresAt <= Date.now() || currentBinding.agentName !== agentName ||
          !samePrincipal(currentBinding.principal, refreshedContext) || !samePrincipal(refreshedContext, context)) {
        upstream.close(1000, 'local_auth_revoked');
        rejectObserverUpgrade(socket, 404, 'lease_not_found');
        return true;
      }
      awaitingAdmission = false;
      downstream = acceptObserverWebSocket(req, socket, head, 'zylos-observer-v1');
      this.observerStreams.add(stream);
      upstream.on('message', (payload, opcode) => {
        if (opcode === 1) downstream.sendText(payload);
        else downstream.sendBinary(payload);
      });
      downstream.on('message', () => close());
      upstream.on('error', close);
      downstream.on('error', close);
      upstream.on('close', close);
      downstream.on('close', close);
      revalidationTimer = setInterval(() => {
        const refreshed = this.authGate?.revalidateAuthContext(context);
        this.pruneObserverLeases();
        const liveBinding = this.observerLeases.get(leaseId);
        if (!refreshed || !liveBinding || liveBinding.expiresAt <= Date.now() ||
            liveBinding.agentName !== agentName || !samePrincipal(refreshed, liveBinding.principal)) close();
      }, 10_000);
      revalidationTimer.unref?.();
      upstream.activate();
      downstream.activate();
      return true;
    } catch {
      if (!downstream && !socket.destroyed && !socket.writableEnded) {
        rejectObserverUpgrade(socket, 502, 'upstream_unreachable');
      }
      close();
      return true;
    }
  }

  async _relayAttachment(req, res, agent, suffix, search, token, conversationPath, upload) {
    const control = new AbortController();
    const context = req._authContext;
    let guard = createSecretGuard(token);
    let tokenBytes = Buffer.from(String(token || ''));
    const fail = (code, status = 502) => Object.assign(new Error(code), { status });
    let body, uploadError, started = false, lastLocalCheck = -Infinity;
    const abort = () => control.abort();
    req.once('aborted', abort);
    req.once('error', abort);
    res.once('close', abort);
    const localAccess = () => {
      const now = Date.now();
      if (now - lastLocalCheck < 1000) return true;
      const current = this.authGate?.revalidateAuthContext
        ? this.authGate.revalidateAuthContext(context) : context;
      const allowed = samePrincipal(current, context) && this.config.fleet?.agents?.some(candidate =>
        candidate.name === agent.name && candidate.base_url === agent.base_url);
      if (allowed) lastLocalCheck = now;
      return allowed;
    };
    const fetchTarget = (route, options = {}) => this.fetch(remoteUrl(agent, route), {
      ...options, redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'identity', ...options.headers },
      signal: options.signal || control.signal,
    });
    const fetchRead = async (route, options) => {
      let response = await fetchTarget(route, options);
      if (response.status === 401) {
        await response.body?.cancel();
        token = await this.poller.getSessionToken(agent.name, { force: true });
        guard = createSecretGuard(token);
        tokenBytes = Buffer.from(String(token || ''));
        response = await fetchTarget(route, options);
      }
      return response;
    };
    const smallBody = async response => {
      const chunks = []; let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_WRITE_BODY_BYTES) throw fail('upstream_body_too_large');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (guard.contains(bytes.toString('utf8'))) throw fail('secret_leak_blocked');
      return bytes;
    };
    const responseHeaders = response => {
      const headers = stripHopByHop(Object.fromEntries(response.headers.entries()));
      headers['cache-control'] = 'no-store';
      if (headersContainSecret(headers, guard)) throw fail('secret_leak_blocked');
      return headers;
    };
    try {
      if (search) throw fail('invalid_chat_parameters', 400);
      if (!localAccess()) throw fail('admin_required', 403);
      if (upload) {
        // A target-authorized config read precedes any access to the browser's
        // body. Never refresh credentials and replay a streaming upload.
        const configResponse = await fetchRead(`${conversationPath}/uploads/config`, {
          signal: AbortSignal.any([control.signal, AbortSignal.timeout(5000)]),
        });
        const configHeaders = responseHeaders(configResponse);
        const configBytes = await smallBody(configResponse);
        if (!configResponse.ok) {
          res.writeHead(configResponse.status, configHeaders); res.end(configBytes); return;
        }
        let maximum;
        try { maximum = JSON.parse(configBytes.toString('utf8')).maxUploadBytes; } catch { throw fail('invalid_upload_config'); }
        if (!Number.isSafeInteger(maximum) || maximum <= 0 || !Number.isSafeInteger(maximum + 65536)) throw fail('invalid_upload_config');
        if (!localAccess()) throw fail('admin_required', 403);
        if (Number(req.headers['content-length']) > maximum + 65536) throw fail('chat_upload_too_large', 413);
        let total = 0;
        // The target owns multipart parsing and per-part limits. The relay
        // only needs a bounded byte budget for the original streamed request.
        body = new Transform({ transform(chunk, encoding, callback) {
          total += chunk.length;
          callback(total > maximum + 65536 ? fail('chat_upload_too_large', 413) : null, chunk);
        } });
        body.once('error', error => { uploadError = error; control.abort(); });
        req.pipe(body);
        started = true;
        const response = await fetchTarget(suffix, { method: 'POST', duplex: 'half', body,
          headers: { 'content-type': req.headers['content-type'] } });
        const headers = responseHeaders(response);
        const bytes = await smallBody(response);
        if (uploadError) throw uploadError;
        if (!localAccess()) throw fail('admin_required', 403);
        res.writeHead(response.status, headers); res.end(bytes);
        return;
      }

      const response = await fetchRead(suffix);
      const headers = responseHeaders(response);
      if (!response.ok) {
        const bytes = await smallBody(response);
        res.writeHead(response.status, headers); res.end(bytes); return;
      }
      if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') throw fail('unexpected_attachment_encoding');
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) throw fail('invalid_attachment_length');
      if (declared !== null) headers['content-length'] = declared;
      let count = 0, tail = Buffer.alloc(0);
      const write = async bytes => {
        if (!bytes.length) return;
        if (!localAccess()) throw fail('admin_required', 403);
        control.signal.throwIfAborted();
        if (!res.headersSent) res.writeHead(response.status, headers);
        if (!res.write(bytes)) await once(res, 'drain', { signal: control.signal });
      };
      if (response.body) for await (const chunk of response.body) {
        count += chunk.length;
        if (declared !== null && count > Number(declared)) throw fail('invalid_attachment_length');
        const combined = Buffer.concat([tail, chunk]);
        // Latin-1 preserves ASCII credential shapes without decoding binary
        // payloads. Exact token matching also covers non-ASCII token bytes.
        if (containsSecret(combined.toString('latin1')) || tokenBytes.length && combined.includes(tokenBytes)) throw fail('secret_leak_blocked');
        const safe = Math.max(0, combined.length - Math.max(STREAM_GUARD_TAIL_CHARS, tokenBytes.length));
        await write(combined.subarray(0, safe));
        tail = Buffer.from(combined.subarray(safe));
      }
      if (declared !== null && count !== Number(declared)) throw fail('invalid_attachment_length');
      await write(tail);
      control.signal.throwIfAborted();
      if (!localAccess()) throw fail('admin_required', 403);
      if (!res.headersSent) res.writeHead(response.status, headers);
      res.end();
    } catch (error) {
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) {
        // An interrupted reply can follow a committed target upload. The
        // browser must retain uncertainty rather than infer message delivery.
        const failure = uploadError || error;
        const code = failure.status ? failure.message : upload && started ? 'upload_result_unknown' : 'upstream_unreachable';
        sendJson(res, failure.status || 502, { error: code });
      }
    } finally {
      control.abort();
      if (body) { req.unpipe(body); body.destroy(); }
      if (upload && !req.complete) {
        req.pause();
        // Close only after the error response drains; do not continue consuming
        // an unbounded rejected browser body or leave a target partial alive.
        res.shouldKeepAlive = false;
        if (res.writableFinished) req.destroy();
        else res.once('finish', () => req.destroy());
      }
      req.removeListener('aborted', abort);
      req.removeListener('error', abort);
      res.removeListener('close', abort);
    }
  }

  async _fetchUpstream(req, agent, suffix, search, token, signal) {
    const headers = stripHopByHop(req.headers);
    headers.authorization = `Bearer ${token}`;
    const options = {
      method: req.method,
      headers,
      signal
    };
    if (!['GET', 'HEAD'].includes(req.method)) {
      const maxBodyBytes = req.method === 'PUT' && suffix === '/api/memory/file'
        ? MAX_MEMORY_WRITE_BODY_BYTES
        : MAX_WRITE_BODY_BYTES;
      if (!req._fleetProxyBody) req._fleetProxyBody = await readBodyBuffer(req, maxBodyBytes);
      options.body = req._fleetProxyBody;
    }
    return this.fetch(remoteUrl(agent, suffix, search), options);
  }
}
