#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8892;
const DEFAULT_MODE = 'body';
const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_INITIAL_DELAY_MS = 0;
const DEFAULT_PROTOCOL = 'http';
const VALID_MODES = new Set(['headers', 'body', 'sse']);
const VALID_PROTOCOLS = new Set(['http', 'https']);

function usage(exitCode = 0) {
  const lines = [
    'Usage: node scripts/e2e/issue-492-webfetch-hang-server.js [options]',
    '',
    'Options:',
    '  --host <host>               Bind host (default: 127.0.0.1)',
    '  --port <port>               Bind port (default: 8892)',
    '  --protocol <http|https>    Listener protocol (default: http)',
    '  --https                     Shorthand for --protocol https',
    '  --cert-file <path>          TLS certificate file for HTTPS mode',
    '  --key-file <path>           TLS private key file for HTTPS mode',
    '  --mode <headers|body|sse>   Default hang mode (default: body)',
    '  --interval-ms <ms>          Keepalive chunk interval for body/sse (default: 1000)',
    '  --initial-delay-ms <ms>     Delay before first body/sse chunk (default: 0)',
    '  --quiet                     Suppress request logs',
    '  -h, --help                  Show this help',
    '',
    'Endpoints:',
    '  GET /healthz',
    '  GET /active',
    '  GET /hang',
    '  GET /hang/headers',
    '  GET /hang/body',
    '  GET /hang/sse',
    '',
    'Per-request query params:',
    '  mode=headers|body|sse',
    '  interval_ms=<ms>',
    '  initial_delay_ms=<ms>',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(exitCode);
}

function parseNonNegativeInt(raw, flagName) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flagName} must be an integer >= 0`);
  }
  return value;
}

function parsePort(raw) {
  const value = parseNonNegativeInt(raw, '--port');
  if (value <= 0 || value > 65535) {
    throw new Error('--port must be between 1 and 65535');
  }
  return value;
}

function parseIntervalMs(raw, flagName) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flagName} must be an integer > 0`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    protocol: DEFAULT_PROTOCOL,
    certFile: '',
    keyFile: '',
    mode: DEFAULT_MODE,
    intervalMs: DEFAULT_INTERVAL_MS,
    initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--host':
        options.host = argv[++i] || '';
        if (!options.host) throw new Error('--host requires a value');
        break;
      case '--port':
        options.port = parsePort(argv[++i]);
        break;
      case '--protocol':
        options.protocol = argv[++i] || '';
        if (!VALID_PROTOCOLS.has(options.protocol)) {
          throw new Error(`--protocol must be one of: ${Array.from(VALID_PROTOCOLS).join(', ')}`);
        }
        break;
      case '--https':
        options.protocol = 'https';
        break;
      case '--cert-file':
        options.certFile = argv[++i] || '';
        if (!options.certFile) throw new Error('--cert-file requires a value');
        break;
      case '--key-file':
        options.keyFile = argv[++i] || '';
        if (!options.keyFile) throw new Error('--key-file requires a value');
        break;
      case '--mode':
        options.mode = argv[++i] || '';
        if (!VALID_MODES.has(options.mode)) {
          throw new Error(`--mode must be one of: ${Array.from(VALID_MODES).join(', ')}`);
        }
        break;
      case '--interval-ms':
        options.intervalMs = parseIntervalMs(argv[++i], '--interval-ms');
        break;
      case '--initial-delay-ms':
        options.initialDelayMs = parseNonNegativeInt(argv[++i], '--initial-delay-ms');
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--help':
      case '-h':
        usage(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function ensureHttpsMaterial(options) {
  if (options.protocol !== 'https') {
    return null;
  }

  if (options.certFile || options.keyFile) {
    if (!options.certFile || !options.keyFile) {
      throw new Error('HTTPS mode requires both --cert-file and --key-file when either is provided');
    }
    return {
      cert: fs.readFileSync(options.certFile, 'utf8'),
      key: fs.readFileSync(options.keyFile, 'utf8'),
      generated: false,
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-492-webfetch-cert-'));
  const keyFile = path.join(tmpDir, 'localhost.key.pem');
  const certFile = path.join(tmpDir, 'localhost.cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey', 'rsa:2048',
    '-nodes',
    '-keyout', keyFile,
    '-out', certFile,
    '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { stdio: 'pipe' });
  return {
    cert: fs.readFileSync(certFile, 'utf8'),
    key: fs.readFileSync(keyFile, 'utf8'),
    generated: true,
    tmpDir,
  };
}

function parseQueryPositiveInt(searchParams, key, fallback) {
  const raw = searchParams.get(key);
  if (raw === null || raw === '') return fallback;
  return parseNonNegativeInt(raw, key);
}

function resolveMode(pathname, searchParams, defaultMode) {
  const explicit = searchParams.get('mode');
  if (explicit) {
    if (!VALID_MODES.has(explicit)) {
      throw new Error(`mode must be one of: ${Array.from(VALID_MODES).join(', ')}`);
    }
    return explicit;
  }

  if (pathname === '/hang/headers') return 'headers';
  if (pathname === '/hang/body') return 'body';
  if (pathname === '/hang/sse') return 'sse';
  return defaultMode;
}

function log(message, quiet) {
  if (quiet) return;
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function createServer(options) {
  const activeRequests = new Map();
  let nextRequestId = 1;
  const tlsMaterial = ensureHttpsMaterial(options);

  function snapshotActiveRequests() {
    return Array.from(activeRequests.values()).map((entry) => ({
      id: entry.id,
      mode: entry.mode,
      path: entry.path,
      remote: entry.remote,
      started_at: entry.startedAtIso,
      running_ms: Date.now() - entry.startedAtMs,
      interval_ms: entry.intervalMs,
      initial_delay_ms: entry.initialDelayMs,
    }));
  }

  function registerActiveRequest(req, res, context) {
    const entry = {
      id: nextRequestId,
      mode: context.mode,
      path: context.path,
      remote: req.socket.remoteAddress || null,
      startedAtMs: Date.now(),
      startedAtIso: new Date().toISOString(),
      intervalMs: context.intervalMs,
      initialDelayMs: context.initialDelayMs,
      timer: null,
      cleanupReason: null,
      res,
    };
    nextRequestId += 1;
    activeRequests.set(entry.id, entry);

    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true);

    const cleanup = (reason) => {
      if (!activeRequests.has(entry.id)) return;
      activeRequests.delete(entry.id);
      entry.cleanupReason = reason;
      if (entry.timer) {
        clearInterval(entry.timer);
        entry.timer = null;
      }
      log(
        `closed request id=${entry.id} mode=${entry.mode} path=${entry.path} reason=${reason}`,
        options.quiet
      );
    };

    req.on('aborted', () => cleanup('aborted'));
    res.on('close', () => cleanup('response_closed'));

    log(
      `accepted request id=${entry.id} mode=${entry.mode} path=${entry.path} remote=${entry.remote ?? 'unknown'}`,
      options.quiet
    );

    return entry;
  }

  function startBodyHang(res, entry) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Zylos-Hang-Mode', 'body');
    res.flushHeaders?.();
    res.write('<!doctype html><html><head><title>zylos-webfetch-hang</title></head><body>\n');
    res.write(`<p>request ${entry.id} connected</p>\n`);
    res.write('<p>response intentionally never ends</p>\n');
    entry.timer = setInterval(() => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`<!-- keepalive ${new Date().toISOString()} request=${entry.id} -->\n`);
    }, entry.intervalMs);
  }

  function startSseHang(res, entry) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Zylos-Hang-Mode', 'sse');
    res.flushHeaders?.();
    res.write(`event: connected\ndata: request ${entry.id}\n\n`);
    entry.timer = setInterval(() => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`: keepalive ${new Date().toISOString()} request=${entry.id}\n\n`);
    }, entry.intervalMs);
  }

  function scheduleStreamingStart(entry) {
    const start = () => {
      if (entry.res.destroyed || entry.res.writableEnded || !activeRequests.has(entry.id)) {
        return;
      }

      if (entry.mode === 'body') {
        startBodyHang(entry.res, entry);
        return;
      }

      if (entry.mode === 'sse') {
        startSseHang(entry.res, entry);
      }
    };

    if (entry.initialDelayMs > 0) {
      setTimeout(start, entry.initialDelayMs).unref();
      return;
    }

    start();
  }

  const createImpl = options.protocol === 'https'
    ? (handler) => https.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, handler)
    : (handler) => http.createServer(handler);

  const server = createImpl((req, res) => {
    const host = req.headers.host || `${options.host}:${options.port}`;
    const url = new URL(req.url || '/', `http://${host}`);

    if (req.method !== 'GET') {
      writeJson(res, 405, {
        ok: false,
        error: 'method_not_allowed',
      });
      return;
    }

    if (url.pathname === '/healthz') {
      writeJson(res, 200, {
        ok: true,
        default_mode: options.mode,
        active_requests: activeRequests.size,
      });
      return;
    }

    if (url.pathname === '/active') {
      writeJson(res, 200, {
        ok: true,
        active_requests: snapshotActiveRequests(),
      });
      return;
    }

    if (!url.pathname.startsWith('/hang')) {
      writeJson(res, 404, {
        ok: false,
        error: 'not_found',
        endpoints: ['/healthz', '/active', '/hang', '/hang/headers', '/hang/body', '/hang/sse'],
      });
      return;
    }

    let mode;
    try {
      mode = resolveMode(url.pathname, url.searchParams, options.mode);
    } catch (err) {
      writeJson(res, 400, {
        ok: false,
        error: err.message,
      });
      return;
    }

    let intervalMs;
    let initialDelayMs;
    try {
      intervalMs = parseIntervalMs(url.searchParams.get('interval_ms') ?? options.intervalMs, 'interval_ms');
      initialDelayMs = parseQueryPositiveInt(url.searchParams, 'initial_delay_ms', options.initialDelayMs);
    } catch (err) {
      writeJson(res, 400, {
        ok: false,
        error: err.message,
      });
      return;
    }
    const entry = registerActiveRequest(req, res, {
      mode,
      path: `${url.pathname}${url.search}`,
      intervalMs,
      initialDelayMs,
    });

    if (mode === 'headers') {
      return;
    }

    entry.intervalMs = intervalMs;
    entry.initialDelayMs = initialDelayMs;
    scheduleStreamingStart(entry);
  });

  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 0;
  server.setTimeout(0);

  server.on('clientError', (err, socket) => {
    log(`client error: ${err.message}`, options.quiet);
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  function shutdown(signal) {
    log(`received ${signal}, shutting down`, options.quiet);
    for (const entry of activeRequests.values()) {
      if (entry.timer) {
        clearInterval(entry.timer);
      }
      entry.res.destroy();
    }
    activeRequests.clear();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, activeRequests, tlsMaterial };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    usage(1);
    return;
  }

  const { server, tlsMaterial } = createServer(options);
  server.listen(options.port, options.host, () => {
    const address = server.address();
    const host = typeof address === 'object' && address ? address.address : options.host;
    const port = typeof address === 'object' && address ? address.port : options.port;
    log(`webfetch hang server listening on ${options.protocol}://${host}:${port}`, options.quiet);
    log(`default endpoint: ${options.protocol}://${host}:${port}/hang/${options.mode}`, options.quiet);
    log(`health endpoint:  ${options.protocol}://${host}:${port}/healthz`, options.quiet);
    if (options.protocol === 'https' && tlsMaterial?.generated) {
      log('TLS mode: generated a temporary self-signed certificate for 127.0.0.1 / localhost', options.quiet);
    }
  });
}

main();
