import { loadCoreModule } from './core-modules.js';
const { tmuxNameForGroup, groupFromTmuxName } = await loadCoreModule('session-group-paths.js');
import { createLane } from './lane.js';
import { createActivationManager } from './activation.js';
import { createContinuationRestarts } from './continuation.js';
import { createCapacityWaits } from './capacity-wait.js';
import { initializeRouter } from './startup.js';
import { tmuxClientArgs, isTmuxDirectoryError } from '../tmux-client-args.js';
import { PENDING_MAX_AGE_SECONDS, RECOVER_MAX_AGE_SECONDS, MAX_RETRIES,
  CONTROL_CLEANUP_INTERVAL_MS, CONTROL_RETENTION_DAYS, READY_TIMEOUT_MS } from '../c4-config.js';

/** Shared router entry for the production dispatcher and isolated tests.
 * All DB calls use the shared store. Terminal I/O lives in the supplied delivery
 * functions, which settle their claimed row only after all callbacks finish.
 * The shared READY default can be overridden by isolated tests. */
export function createRouter(dependencies, configuration = {}) {
  const required = ['readSessionMode','readLiveIdentities','readLiveIdentity','readCurrentSession','listGroupTmuxSessions','readRuntimeHealth',
    'submit','deliverControl','deliverConversation','handleExpired','findLegacySessions','advanceLegacy'];
  for (const name of required) if (typeof dependencies[name] !== 'function') throw new TypeError(`Router dependency ${name} is required`);
  if (!dependencies.session || typeof dependencies.session !== 'object') throw new TypeError('Router dependency session is required');
  if (!dependencies.db) throw new TypeError('Router database is required');
  const options = { pendingMaxAgeSeconds: PENDING_MAX_AGE_SECONDS, recoverMaxAgeSeconds: RECOVER_MAX_AGE_SECONDS,
    maxRetries: MAX_RETRIES, cleanupIntervalMs: CONTROL_CLEANUP_INTERVAL_MS, retentionDays: CONTROL_RETENTION_DAYS,
    readyTimeoutMs: READY_TIMEOUT_MS, diagnosticsIntervalMs: 60000, mismatchIntervalMs: 60000, pollIntervalMs: 1000, ...configuration };
  if (typeof options.poolSize !== 'function') throw new TypeError('poolSize must be a function');
  for (const name of ['readyTimeoutMs','pendingMaxAgeSeconds','recoverMaxAgeSeconds','diagnosticsIntervalMs']) {
    if (!Number.isSafeInteger(options[name]) || options[name] <= 0) throw new TypeError(`${name} must be a positive integer`);
  }
  const deps = dependencies;
  const now = deps.now ?? Date.now;
  const state = { mode: null, keyPresent: false, inert: false, ready: false, stopped: false, round: 0, sceneObservable: false,
    slots: new Map(), live: new Map(), continuations: new Map(), activations: new Map(), lanes: new Map(), listed: new Set(), legacy: [],
    resident: { failures: 0, absentSince: null, readySince: null, fenced: false } };
  const tasks = new Set();
  const opportunities = new Set();
  const attemptedRound = new Map();
  let sceneTask = null, legacyTask = null, maintenanceTask = null, timer = null, initialization = null;
  let lastCleanup = -Infinity, lastDiagnostics = -Infinity, lastMismatch = -Infinity;
  let directoryFailed = false;
  function directoryAvailable() {
    if (directoryFailed) return false;
    try { tmuxClientArgs(); return true; }
    catch (error) {
      if (!isTmuxDirectoryError(error)) throw error;
      directoryFailed = true;
      state.sceneObservable = false;
      for (const current of state.lanes.values()) current.stop();
      diagnostic('tmux_directory_unavailable', { reason: error.code });
      return false;
    }
  }
  const diagnostic = (event, fields = {}) => {
    try { Promise.resolve(deps.diagnostic?.(event, fields)).catch(error => deps.log?.(`Router diagnostic: ${error.message}`)); }
    catch (error) { deps.log?.(`Router diagnostic: ${error.message}`); }
  };
  function track(promise) { tasks.add(promise); promise.finally(() => tasks.delete(promise)).catch(() => {}); return promise; }
  const context = { deps, options, state, diagnostic, now, tmuxName: group => tmuxNameForGroup(group ?? 'origin') };
  context.capacityWaits = createCapacityWaits({ ...context, track });
  context.continuationRestarts = createContinuationRestarts({ now, deps, diagnostic });
  context.refreshSlots = () => { state.slots = new Map(deps.db.listSlotOccupancy().map(row => [row.sessionGroup, row])); };
  context.availableCapacity = () => {
    if (!state.sceneObservable || [...state.listed].some(group => !state.live.has(group))) return 0;
    return options.poolSize() - state.slots.size;
  };
  // Capacity opportunities are ordered before asynchronous preflight. They are
  // not pool occupancy: no message is claimed and no launch is reserved yet.
  // A rejected preflight releases its opportunity to the next head this round.
  context.acquireOpportunity = (group, candidate) => {
    if (attemptedRound.get(group) === state.round) return false;
    const owned = state.slots.get(group);
    if (owned) {
      if (!state.sceneObservable || owned.state !== 'held') return false;
      opportunities.add(group); attemptedRound.set(group, state.round); return true;
    }
    const slots = context.availableCapacity() - [...opportunities].filter(key => !state.slots.has(key)).length;
    if (slots <= 0) {
      if (candidate.continuation) context.capacityWaits.wait(group);
      return false;
    }
    const inbound = deps.db.listPendingSessionGroups();
    const inboundGroups = new Set(inbound.map(row => row.sessionGroup));
    const candidates = [
      ...inbound.map(row => ({ ...row, candidateId: row.headId, continuation: false })),
      ...deps.db.listPendingContinuations().filter(row => !inboundGroups.has(row.sessionGroup))
        .sort((a, b) => a.endedAt - b.endedAt || (a.sessionGroup < b.sessionGroup ? -1 : a.sessionGroup > b.sessionGroup ? 1 : 0))
        .map(row => ({ ...row, candidateId: row.sessionGroup, continuation: true })),
    ];
    const eligible = candidates.filter(row => row.sessionGroup !== 'origin' && !state.slots.has(row.sessionGroup) &&
      !state.live.get(row.sessionGroup)?.present && !state.activations.has(row.sessionGroup) && !opportunities.has(row.sessionGroup) &&
      attemptedRound.get(row.sessionGroup) !== state.round);
    const selected = eligible.slice(0, slots).some(row => row.sessionGroup === group && row.candidateId === candidate.id && row.continuation === Boolean(candidate.continuation));
    if (!selected) return false;
    opportunities.add(group); attemptedRound.set(group, state.round); return true;
  };
  context.releaseOpportunity = group => {
    opportunities.delete(group);
    // Run the next candidate without awaiting or replaying the completed lane.
    queueMicrotask(() => {
      if (state.stopped || !state.ready || state.mode !== 'multi') return;
      try {
        for (const row of [...deps.db.listPendingSessionGroups(), ...deps.db.listPendingContinuations()]) {
          if (attemptedRound.get(row.sessionGroup) === state.round) continue;
          const current = state.lanes.get(row.sessionGroup);
          if (current && !current.working) track(current.kick());
        }
      } catch (error) { diagnostic('scheduler_error', { reason: error.code ?? error.message }); }
    });
  };
  context.deferOpportunity = group => { attemptedRound.set(group, state.round); context.releaseOpportunity(group); };
  context.clearContinuation = (group, live) => {
    if (!live?.present || !live.ready || !live.runId) return;
    try {
      const pending = deps.db.listRunEndings([group]).some(row => row.continuationPending);
      if (pending && deps.db.clearContinuation(group, { runId: live.runId }).cleared) {
        diagnostic('continuation_cleared', { session_group: group, runId: live.runId });
      }
    } catch (error) {
      diagnostic('continuation_clear_failed', { session_group: group, runId: live.runId, reason: error.code ?? error.message });
    }
  };
  function acceptObservation(group, live) {
    state.live.set(group, live);
    context.continuationRestarts.observe(group, live);
    context.clearContinuation(group, live);
    if (group === 'origin') {
      if (live.present) state.resident.absentSince = null;
      else state.resident.absentSince ??= now();
      if (live.ready) {
        state.resident.readySince ??= now();
        if (now() - state.resident.readySince >= 60000) state.resident.failures = 0;
      } else state.resident.readySince = null;
    }
  }
  context.refreshScene = async (requested = [], { startup = false } = {}) => {
    try {
      const sessions = state.mode === 'single' ? [] : await deps.listGroupTmuxSessions();
      const groups = state.mode === 'single' ? new Set(['origin']) :
        new Set(sessions.filter(row => groupFromTmuxName(row.tmuxName) === row.sessionGroup).map(row => row.sessionGroup));
      state.listed = groups;
      const wanted = new Set([...groups, ...state.live.keys(), ...requested, 'origin']);
      const observation = Promise.resolve().then(() => deps.readLiveIdentities([...wanted])).then(identities => {
        for (const group of wanted) {
          if (!identities.get(group)) throw new Error('Batch identity observation is incomplete');
        }
        for (const group of wanted) acceptObservation(group, identities.get(group));
        state.sceneObservable = true;
      }).catch(error => {
        state.sceneObservable = false; state.live.clear();
        diagnostic('scene_unobservable', { reason: error.code ?? error.message });
      });
      if (startup) track(observation);
      else await observation;
    } catch (error) {
      state.sceneObservable = false;
      // A failed listing retains known identities for guarded delivery, while
      // unobservable capacity prevents admitting an unseen session.
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
        await deps.session.stop({ tmuxName: last.tmuxName, expectedRunId: last.runId });
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
  function adoptReadySlots() {
    if (!state.sceneObservable) return;
    for (const group of state.listed) {
      if (group === 'origin') continue;
      const live = state.live.get(group);
      if (!live?.present || !live.ready || !live.runId) continue;
      const own = state.slots.get(group);
      if (own?.state === 'running' && own.runId === live.runId) continue;
      try {
        const result = deps.db.adoptSlot(group, { runId: live.runId });
        if (result.adopted || result.reason === 'already') {
          state.slots.set(group, { sessionGroup: group, runId: live.runId, state: 'running', heldUntil: null });
        }
      } catch (error) {
        diagnostic('slot_adoption_failed', { session_group: group, runId: live.runId, reason: error.code ?? error.message });
      }
    }
  }
  function tick() {
    if (!state.ready || state.inert || state.stopped) return;
    if (!directoryAvailable()) return;
    state.round++;
    const seconds = Math.floor(now() / 1000);
    deps.db.expireTimedOutControls(seconds);
    deps.sweepDeliveryWaits?.();
    if (now() - lastCleanup >= options.cleanupIntervalMs) {
      deps.db.cleanupControlQueue(seconds - options.retentionDays * 86400); lastCleanup = now();
    }
    if (!maintenanceTask && deps.maintainDiagnostics && now() - lastDiagnostics >= options.diagnosticsIntervalMs) {
      lastDiagnostics = now();
      maintenanceTask = track(Promise.resolve().then(deps.maintainDiagnostics)
        .catch(error => diagnostic('maintenance_error', { reason: error.message })).finally(() => { maintenanceTask = null; }));
    }
    if (now() - lastMismatch >= options.mismatchIntervalMs) {
      let counts = deps.db.countNonTerminalControls(state.mode === 'multi' ? { machine: true } : { allSessionGroups: true });
      if (state.mode === 'single' && state.keyPresent) {
        const machine = deps.db.countNonTerminalControls({ machine: true });
        const origin = deps.db.countNonTerminalControls({ sessionGroup: 'origin' });
        counts = Object.fromEntries(Object.keys(counts).map(key => [key, counts[key] + machine[key] - origin[key]]));
      }
      if (counts.pending) { diagnostic('mode_mismatch', { count: counts.pending, mode: state.mode }); deps.alert?.('mode_mismatch', counts); }
      lastMismatch = now();
    }
    if (state.mode === 'single' && !state.keyPresent) {
      if (!legacyTask) legacyTask = track(Promise.resolve().then(() => deps.advanceLegacy(state.legacy))
        .catch(error => diagnostic('legacy_error', { reason: error.message })).finally(() => { legacyTask = null; }));
      return;
    }
    if (state.mode === 'multi') { context.refreshSlots(); adoptReadySlots(); }
    const pending = state.mode === 'multi' ? deps.db.listPendingSessionGroups() : [];
    const continuations = state.mode === 'multi' ? deps.db.listPendingContinuations() : [];
    state.continuations = new Map(continuations.map(row => [row.sessionGroup, row]));
    context.capacityWaits.sweep(new Set([...pending, ...continuations].map(row => row.sessionGroup)));
    // Lifecycle reconciliation also runs without queued work: resident restart,
    // stable READY backoff reset, absence timing, unowned starts and slot adoption
    // require observation. Each round uses one batch, never per-session polling.
    if (!sceneTask) sceneTask = track(context.refreshScene([...pending, ...continuations].map(row => row.sessionGroup))
      .finally(() => { sceneTask = null; }));
    const wanted = new Set(state.mode === 'single' ? ['origin'] : ['origin', ...state.listed,
      ...pending.map(row => row.sessionGroup), ...continuations.map(row => row.sessionGroup), ...state.activations.keys()]);
    const ordered = state.mode === 'single' ? ['origin'] : ['origin', ...pending.sort((a,b) => a.headPriority-b.headPriority || a.headId-b.headId).map(row => row.sessionGroup), ...continuations.sort((a,b) => a.endedAt-b.endedAt || (a.sessionGroup < b.sessionGroup ? -1 : a.sessionGroup > b.sessionGroup ? 1 : 0)).map(row => row.sessionGroup), ...wanted];
    for (const group of new Set(ordered)) {
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
    if (directoryAvailable()) await initialize();
    if (timer || state.stopped) return;
    timer = setInterval(() => { try { tick(); } catch (error) { diagnostic('scheduler_error', { reason: error.code ?? error.message }); } }, options.pollIntervalMs);
  }
  async function stop() {
    state.stopped = true; clearInterval(timer); timer = null;
    context.capacityWaits.stop();
    for (const current of state.lanes.values()) current.stop();
    await Promise.allSettled([...tasks]);
  }
  return { initialize, start, tick, stop, state, availableCapacity: context.availableCapacity,
    // Wait for the current round only; follow-up lanes may wait on external I/O.
    async idle() { await Promise.allSettled([...tasks]); } };
}
