import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from './core-config-loader.js';
import { ACTIVITY_MONITOR_DIR } from './c4-config.js';
import { getModeTransition } from './c4-db.js';
import { messageForStatus } from './status-notice-templates.js';

const { resolveTargetRuntime, readRuntimeHealth } = await import(
  pathToFileURL(path.join(path.dirname(resolveCoreConfigModule()), 'session-state-reader.js')).href);

export function validRouteResponse(response, request) {
  if (!response || response.version !== 2 || response.type !== request.type || response.requestId !== request.requestId ||
      typeof response.recovered !== 'boolean' || typeof response.runtime !== 'string' || !response.runtime ||
      !['ok', 'rate_limited', 'auth_failed', 'unavailable'].includes(response.health) ||
      typeof response.reason !== 'string' || typeof response.transitionHold !== 'boolean') return false;
  if (response.decision !== undefined && !['pending', 'auth_rejected'].includes(response.decision)) return false;
  if (response.transitionHold && response.decision !== 'pending') return false;
  if (response.decision === 'pending' && response.recovered !== true) return false;
  if (response.auth !== undefined && response.decision !== 'auth_rejected') return false;
  if (response.decision === 'auth_rejected') {
    if (response.recovered !== false || response.health !== 'auth_failed' || !['failed', 'unconfirmed'].includes(response.auth?.result) || typeof response.auth?.detail !== 'string') return false;
  }
  if (response.decision === undefined && response.recovered !== false) return false;
  if (response.decision !== 'pending' && !request.noReply && (typeof response.userMessage !== 'string' || !response.userMessage)) return false;
  return true;
}

export function ipcRoute(request, { socketPath = path.join(ACTIVITY_MONITOR_DIR, 'am.sock'), timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '', settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; socket.destroy(); fn(value); } };
    const parse = () => {
      const end = data.indexOf('\n');
      if (end < 0) return;
      try { settle(resolve, JSON.parse(data.slice(0, end))); }
      catch { settle(reject, new Error('Invalid route JSON')); }
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => { data += chunk; parse(); });
    socket.on('end', () => { parse(); if (!settled) settle(reject, new Error('Incomplete route response')); });
    socket.on('timeout', () => settle(reject, new Error('Route timeout')));
    socket.on('error', error => settle(reject, error));
  });
}

export async function fallbackFileRoute(request, dependencies = {}) {
  const transition = dependencies.getModeTransition ?? getModeTransition;
  const resolve = dependencies.resolveTargetRuntime ?? resolveTargetRuntime;
  const readHealth = dependencies.readRuntimeHealth ?? readRuntimeHealth;
  const diagnostic = dependencies.diagnostic ?? console.error;
  const pending = (runtime = 'unknown', extra = {}) => ({ decision: 'pending', recovered: true,
    runtime, health: 'unavailable', reason: 'router_unavailable', transitionHold: false, fallback: true, ...extra });
  try {
    if (transition()) return pending('unknown', { transitionHold: true });
  } catch { diagnostic('route fallback: mode transition read failed'); return pending(); }
  let runtime;
  try { runtime = await resolve(request.sessionGroup); }
  catch { runtime = 'unknown'; }
  if (runtime === 'unknown' || !runtime) {
    diagnostic('route fallback: target runtime unknown'); return pending('unknown', { observation: 'runtime_unknown' });
  }
  let status;
  try { status = await readHealth(runtime); }
  catch { status = { unreadable: true }; }
  if (!status || status.missing || status.unreadable) {
    diagnostic(`route fallback: ${runtime} health record missing or unreadable`);
    return pending(runtime, { observation: 'health_record_missing' });
  }
  const health = status.publicHealth;
  const reason = status.reason || health || 'unavailable';
  if (['ok', 'rate_limited'].includes(health)) return pending(runtime, { health, reason });
  if (health === 'auth_failed' && (request.coreSide || !request.componentName)) return pending(runtime, { health, reason });
  const route = { runtime, recovered: false, health: health || 'unavailable', reason, transitionHold: false, fallback: true };
  if (health === 'auth_failed') Object.assign(route, { decision: 'auth_rejected', reason: 'router_unavailable',
    auth: { result: 'unconfirmed', detail: 'router_unavailable: health record auth_failed' } });
  route.userMessage = messageForStatus({ health: route.health, reason: route.reason,
    noticeCode: status.health_notice?.noticeCode, resetAt: status.health_notice?.resetAt });
  return route;
}

export async function queryRoute(request, dependencies = {}) {
  try {
    const response = await (dependencies.ipcRoute ?? ipcRoute)(request);
    if (!validRouteResponse(response, request)) throw new Error('Invalid route response');
    return response;
  } catch { return (dependencies.fallbackFileRoute ?? fallbackFileRoute)(request, dependencies); }
}
