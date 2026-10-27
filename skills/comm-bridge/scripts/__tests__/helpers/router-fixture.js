import { fixture } from '../c4-v2-test-helpers.js';
import { tmuxNameForGroup } from '../../../../../cli/lib/session-group-paths.js';
import { createRouter } from '../../router/scheduler.js';
export const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
export const flush = () => new Promise(resolve => setImmediate(resolve));
export function routerFixture(t, { mode = 'multi', poolSize = 2, readyTimeoutMs = 1000 } = {}) {
  let clock = 1800000000000;
  const f = fixture(t, { now: () => clock, readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: mode } }) });
  const events = [], calls = [], scene = new Map(), current = new Map(), health = new Map();
  const db = { ...f.store,
    getControlById: id => f.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id),
    expireTimedOutControls: now => { calls.push(['expire', now]); return f.db.prepare("UPDATE control_queue SET status='timeout' WHERE status IN ('pending','running') AND ack_deadline_at<?").run(now).changes; },
    cleanupControlQueue: cutoff => calls.push(['cleanup', cutoff]),
  };
  const identity = (group, values = {}) => ({ present: true, tmuxName: tmuxNameForGroup(group ?? 'origin'), runId: `run-${group}`, createdAt: Math.floor(clock / 1000),
    runtime: 'claude', launchConfig: { runtime: 'claude', mode: 'default' }, ready: true, sessionId: `session-${group}`, ...values });
  function put(group, values) {
    const live = identity(group, values); scene.set(group, live);
    if (live.ready) current.set(group, { runId: live.runId, sessionId: live.sessionId, startupControlIds: [], ts: clock });
    return live;
  }
  const deps = { db, now: () => clock, readSessionMode: () => { calls.push(['mode']); return { mode, keyPresent: true }; },
    readLiveIdentity: async group => scene.get(group) ?? { present: false, ready: false, tmuxName: tmuxNameForGroup(group ?? 'origin') },
    readCurrentSession: async group => current.get(group),
    listGroupTmuxSessions: async () => [...scene].filter(([,v]) => v.present).map(([sessionGroup,v]) => ({ sessionGroup, tmuxName: v.tmuxName, createdAt: v.createdAt })),
    readRuntimeHealth: runtime => health.get(runtime) ?? { health: 'ok', publicHealth: 'ok' },
    getSessionAdapter: runtime => ({ launch: async input => { calls.push(['launch', input]); put(input.sessionGroup, { runId: input.runId, runtime, launchConfig: input.launchConfig }); },
      stop: async input => { calls.push(['stop', input]); for (const [group,v] of scene) if (v.tmuxName === input.tmuxName) scene.delete(group); } }),
    submit: async request => { calls.push(['submit', request]); return { kind: 'accepted', sent: true, reply: { ...request, ok: true, result: 'registered', reason: 'recovery_due' } }; },
    deliverControl: async row => { calls.push(['control', row.id]); f.db.prepare("UPDATE control_queue SET status='done' WHERE id=? AND status='running'").run(row.id); },
    deliverConversation: async (row, live) => { calls.push(['conversation', row.id]); db.markDelivered(row.id, { sessionId: live.sessionId }); },
    handleExpired: async row => calls.push(['expired', row.id]), prepareSingle: async () => calls.push(['prepare']),
    findLegacySessions: async () => [], advanceLegacy: async () => {}, diagnostic: (event, fields) => events.push({ event, ...fields }),
    alert: (event, fields) => calls.push(['alert', event, fields]), log: line => calls.push(['log', line]),
  };
  const recover = db.recoverOrphanRunning;
  db.recoverOrphanRunning = options => { calls.push(['recover']); return recover(options); };
  const options = { poolSize, readyTimeoutMs };
  let router;
  const create = () => router = createRouter(deps, options);
  const rounds = async (n = 1) => { for (let i = 0; i < n; i++) { router.tick(); await router.idle(); await flush(); } };
  const add = (group = 'a', opts) => { const row = db.insertConversation('in', group, 'endpoint', 'body', opts); f.db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(clock / 1000, row.id); return row; };
  t.after(async () => { await router?.stop(); });
  return { ...f, sqlite: f.db, db, deps, options, create, rounds, scene, current, health, calls, events, identity, put, add,
    get router() { return router; }, now: () => clock, advance: ms => { clock += ms; }, row: id => f.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) };
}
