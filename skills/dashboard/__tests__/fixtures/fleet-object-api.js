import { projectApiTimestamps } from '../../src/lib/wire-time.js';

/** Complete object-API responses for injected Fleet transports; never uses a network. */
export function objectResponse(url, { working = 0, idle = working ? 0 : 1, unknown = 0,
  instance = {}, counts = {}, rows = null, todayCost = 0, sevenDayCost = 0 } = {}) {
  const payload = url.endsWith('/api/instance')
    ? { session_mode: { sessionMode: 'single' }, default_runtime: 'claude', defaults: {}, versions: {}, resources: {},
      accounts: {}, supervisorPaused: false, autoRestarts: { count: 0 }, ...instance }
    : url.endsWith('/api/groups/counts')
      ? { listKnown: true, running: { total: working + idle + unknown,
        states: { working, idle, starting: 0, stopping: 0, unknown },
        flags: { queued: 0, blocked: 0, waitingSlot: 0, startFailed: 0, unreadable: 0 } },
        offline: { total: 0, waitingSlot: 0, startFailed: 0 }, pool: { used: working + idle, capacity: 12 }, ...counts }
      : url.endsWith('/api/groups/running') ? { rows: rows ?? [...Array.from({ length: working }, (_, i) => ({id:`work-${i}`,state:{kind:'working'}})),...Array.from({ length: idle }, (_, i) => ({id:`idle-${i}`,state:{kind:'idle'}})),...Array.from({ length: unknown }, (_, i) => ({id:`unknown-${i}`,state:{kind:'unknown'}}))], listKnown: true, readAt: 0 }
        : url.endsWith('/api/usage/summary') ? { today: { cost: todayCost }, sevenDay: { cost: sevenDayCost } }
        : null;
  if (!payload) throw new Error(`Unexpected object API URL ${url}`);
  return new Response(JSON.stringify(projectApiTimestamps(new URL(url, 'http://fixture.invalid').pathname.slice(new URL(url, 'http://fixture.invalid').pathname.lastIndexOf('/api/')), payload)), { headers: { 'content-type': 'application/json' } });
}

export const isObjectApi = url => ['/api/instance', '/api/groups/counts', '/api/groups/running', '/api/usage/summary'].some(path => url.endsWith(path));
export const flushObjectReads = () => new Promise(resolve => setImmediate(resolve));
