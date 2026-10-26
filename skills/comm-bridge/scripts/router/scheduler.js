import { tmuxNameForGroup, groupFromTmuxName } from '../../../../cli/lib/session-group-paths.js';
import { createLane } from './lane.js';
import { createActivationManager } from './activation.js';
import { initializeRouter } from './startup.js';
import { PENDING_MAX_AGE_SECONDS, RECOVER_MAX_AGE_SECONDS, MAX_RETRIES,
  CONTROL_CLEANUP_INTERVAL_MS, CONTROL_RETENTION_DAYS } from '../c4-config.js';

/** Injectable router entry; the production dispatcher is connected separately.
 * All DB calls use the shared store. Terminal I/O lives in the supplied delivery
 * functions, which settle their claimed row only after all callbacks finish.
 * readyTimeoutMs is mandatory until real-runtime measurements set a default. */
export function createRouter(dependencies, configuration = {}) {
  const required = ['readSessionMode','readLiveIdentity','readCurrentSession','listGroupTmuxSessions','readRuntimeHealth',
    'getSessionAdapter','submit','deliverControl','deliverConversation','handleExpired','prepareSingle','findLegacySessions','advanceLegacy'];
  for (const name of required) if (typeof dependencies[name] !== 'function') throw new TypeError(`Router dependency ${name} is required`);
  if (!dependencies.db) throw new TypeError('Router database is required');
  const options = { pendingMaxAgeSeconds: PENDING_MAX_AGE_SECONDS, recoverMaxAgeSeconds: RECOVER_MAX_AGE_SECONDS,
    maxRetries: MAX_RETRIES, cleanupIntervalMs: CONTROL_CLEANUP_INTERVAL_MS, retentionDays: CONTROL_RETENTION_DAYS,
    diagnosticsIntervalMs: 60000, mismatchIntervalMs: 60000, pollIntervalMs: 1000, ...configuration };
  for (const name of ['readyTimeoutMs','poolSize','pendingMaxAgeSeconds','recoverMaxAgeSeconds']) {
    if (!Number.isSafeInteger(options[name]) || options[name] <= 0) throw new TypeError(`${name} must be a positive integer`);
  }
  const deps = dependencies;
  const now = deps.now ?? Date.now;
  const state = { mode: null, inert: false, ready: false, stopped: false, round: 0, sceneObservable: false,
    live: new Map(), activations: new Map(), lanes: new Map(), listed: new Set(), legacy: [],
    resident: { failures: 0, absentSince: null, readySince: null, fenced: false } };
  const tasks = new Set();
  const observations = new Map();
  const opportunities = new Set();
  const attemptedRound = new Map();
  let sceneTask = null, legacyTask = null, maintenanceTask = null, timer = null, initialization = null;
  let lastCleanup = -Infinity, lastDiagnostics = -Infinity, lastMismatch = -Infinity;
  const diagnostic = (event, fields = {}) => {
    try { Promise.resolve(deps.diagnostic?.(event, fields)).catch(error => deps.log?.(`Router diagnostic: ${error.message}`)); }
    catch (error) { deps.log?.(`Router diagnostic: ${error.message}`); }
  };
  function track(promise) { tasks.add(promise); promise.finally(() => tasks.delete(promise)).catch(() => {}); return promise; }
  const context = { deps, options, state, diagnostic, now, tmuxName: group => tmuxNameForGroup(group ?? 'origin') };
  context.availableCapacity = () => {
    if (!state.sceneObservable || [...state.listed].some(group => !state.live.has(group))) return 0;
    const occupied = new Set([...state.listed].filter(group => group !== 'origin' && group !== null));
    for (const [group, live] of state.live) if (group !== 'origin' && group !== null && live?.present) occupied.add(group);
    for (const group of state.activations.keys()) if (group !== 'origin' && group !== null) occupied.add(group);
    return Math.max(0, options.poolSize - occupied.size);
  };
  // Capacity opportunities are ordered before asynchronous preflight. They are
  // not pool occupancy: no message is claimed and no launch is reserved yet.
  // A rejected preflight releases its opportunity to the next head this round.
  context.acquireOpportunity = (group, candidate) => {
    if (attemptedRound.get(group) === state.round) return false;
    const slots = context.availableCapacity() - opportunities.size;
    if (slots <= 0) return false;
    const eligible = deps.db.listPendingSessionGroups().filter(row => row.sessionGroup !== 'origin' &&
      !state.live.get(row.sessionGroup)?.present && !state.activations.has(row.sessionGroup) && !opportunities.has(row.sessionGroup) &&
      attemptedRound.get(row.sessionGroup) !== state.round);
    const selected = eligible.slice(0, slots).some(row => row.sessionGroup === group && row.headId === candidate.id);
    if (!selected) return false;
    opportunities.add(group); attemptedRound.set(group, state.round); return true;
  };
  context.releaseOpportunity = group => {
    opportunities.delete(group);
    // Run the next candidate without awaiting or replaying the completed lane.
    queueMicrotask(() => {
      if (state.stopped || !state.ready || state.mode !== 'multi') return;
      try {
        for (const row of deps.db.listPendingSessionGroups()) {
          if (attemptedRound.get(row.sessionGroup) === state.round) continue;
          const current = state.lanes.get(row.sessionGroup);
          if (current && !current.working) track(current.kick());
        }
      } catch (error) { diagnostic('scheduler_error', { reason: error.code ?? error.message }); }
    });
  };
  function observe(group) {
    if (observations.has(group)) return observations.get(group);
    const task = Promise.resolve().then(() => deps.readLiveIdentity(group)).then(live => {
      state.live.set(group, live);
      if (group === null || group === 'origin') {
        if (live.present) state.resident.absentSince = null;
        if (live.ready) {
          state.resident.readySince ??= now();
          if (now() - state.resident.readySince >= 60000) state.resident.failures = 0;
        } else state.resident.readySince = null;
      }
    }).catch(error => {
      state.live.delete(group);
      diagnostic('scene_unobservable', { session_group: group, reason: error.code ?? error.message });
    }).finally(() => observations.delete(group));
    observations.set(group, task); return track(task);
  }
  context.refreshScene = async () => {
    try {
      if (state.mode === 'single') {
        state.listed = new Set([null]); state.sceneObservable = true;
        observe(null); return;
      }
      const sessions = await deps.listGroupTmuxSessions();
      const groups = new Set(sessions.filter(row => groupFromTmuxName(row.tmuxName) === row.sessionGroup).map(row => row.sessionGroup));
      // Retain last known identities until an explicit per-group observation;
      // a failed listing never turns existing sessions into free capacity.
      state.listed = groups; state.sceneObservable = true;
      for (const group of new Set([...groups, ...state.live.keys(), 'origin'])) observe(group);
    } catch (error) {
      state.sceneObservable = false;
      diagnostic('scene_unobservable', { reason: error.code ?? error.message });
    }
  };
  context.handleUnowned = async (group, live) => {
    if (!live.runId || now() - live.createdAt * 1000 >= options.readyTimeoutMs) {
      try {
        const last = await deps.readLiveIdentity(group);
        state.live.set(group, last);
        if (!last.present || last.ready || last.runId !== live.runId) return;
        if (last.runtime === 'unknown') {
          diagnostic('stop_unconfirmed', { session_group: group, reason: 'runtime_unknown' });
          deps.alert?.('stop_unconfirmed', { sessionGroup: group, reason: 'runtime_unknown' }); return;
        }
        await deps.getSessionAdapter(last.runtime).stop({ tmuxName: last.tmuxName, expectedRunId: last.runId });
        state.live.delete(group);
        diagnostic(last.runId ? 'unowned_start_stopped' : 'tmux_runid_missing', { session_group: group, runId: last.runId });
        if (!last.runId) deps.alert?.('tmux_runid_missing', { sessionGroup: group });
      } catch (error) {
        diagnostic('stop_unconfirmed', { session_group: group, reason: error.code ?? error.message });
        deps.alert?.('stop_unconfirmed', { sessionGroup: group });
      }
    }
  };
  context.activation = createActivationManager(context);
  function lane(group) {
    if (!state.lanes.has(group)) state.lanes.set(group, createLane(context, group));
    return state.lanes.get(group);
  }
  function tick() {
    if (!state.ready || state.inert || state.stopped) return;
    state.round++;
    const seconds = Math.floor(now() / 1000);
    deps.db.expireTimedOutControls(seconds);
    if (now() - lastCleanup >= options.cleanupIntervalMs) {
      deps.db.cleanupControlQueue(seconds - options.retentionDays * 86400); lastCleanup = now();
    }
    if (!maintenanceTask && deps.maintainDiagnostics && now() - lastDiagnostics >= options.diagnosticsIntervalMs) {
      lastDiagnostics = now();
      maintenanceTask = track(Promise.resolve().then(deps.maintainDiagnostics)
        .catch(error => diagnostic('maintenance_error', { reason: error.message })).finally(() => { maintenanceTask = null; }));
    }
    if (now() - lastMismatch >= options.mismatchIntervalMs) {
      const counts = deps.db.countNonTerminalControls(state.mode === 'multi' ? { machine: true } : { allSessionGroups: true });
      if (counts.pending) { diagnostic('mode_mismatch', { count: counts.pending, mode: state.mode }); deps.alert?.('mode_mismatch', counts); }
      lastMismatch = now();
    }
    if (!sceneTask) sceneTask = track(context.refreshScene().finally(() => { sceneTask = null; }));
    if (state.mode === 'single' && !legacyTask) {
      legacyTask = track(Promise.resolve().then(() => deps.advanceLegacy(state.legacy))
        .catch(error => diagnostic('legacy_error', { reason: error.message })).finally(() => { legacyTask = null; }));
    }
    const pending = state.mode === 'multi' ? deps.db.listPendingSessionGroups() : [];
    const wanted = new Set(state.mode === 'single' ? [null] : ['origin', ...state.listed,
      ...pending.map(row => row.sessionGroup), ...state.activations.keys()]);
    const ordered = state.mode === 'single' ? [null] : ['origin', ...pending.sort((a,b) => a.headPriority-b.headPriority || a.headId-b.headId).map(row => row.sessionGroup), ...wanted];
    for (const group of new Set(ordered)) {
      if (!state.live.has(group)) observe(group);
      const active = state.activations.get(group);
      if (active && !active.launchSettled && now() - active.startedAt >= options.readyTimeoutMs && !active.warned) {
        active.warned = true; diagnostic('stop_unconfirmed', { session_group: group, runId: active.runId, reason: 'launch_pending' });
        deps.alert?.('launch_pending', { sessionGroup: group, runId: active.runId });
      }
      const work = lane(group).kick(); if (work) track(work);
    }
    for (const [group, current] of state.lanes) if (!wanted.has(group) && !current.working) { current.stop(); state.lanes.delete(group); state.live.delete(group); }
  }
  function initialize() { initialization ??= initializeRouter(context); return initialization; }
  async function start() {
    await initialize();
    if (timer || state.stopped) return;
    timer = setInterval(() => { try { tick(); } catch (error) { diagnostic('scheduler_error', { reason: error.code ?? error.message }); } }, options.pollIntervalMs);
  }
  async function stop() {
    state.stopped = true; clearInterval(timer); timer = null;
    for (const current of state.lanes.values()) current.stop();
    await Promise.allSettled([...tasks]);
    await deps.flushDiagnostics?.();
  }
  return { initialize, start, tick, stop, state, availableCapacity: context.availableCapacity,
    async idle() { await Promise.allSettled([...tasks]); } };
}
