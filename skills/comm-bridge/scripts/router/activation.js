import { randomBytes, randomUUID } from 'node:crypto';

const restricted = new Set(['rate_limited', 'unavailable', 'recovering', 'down']);
const timedCodes = new Set(['rate_limit_cooldown', 'probe_cache', 'attempt_backoff', 'down_retry_interval']);
const plainCodes = new Set(['invalid_request', 'auth_blocked', 'scene_present', 'probe_inflight', 'health_write_failed']);
const absent = (value, fields) => fields.every(field => !Object.hasOwn(value, field));

/** Validate the caller-specific branch, even with an injected transport. */
export function validStartAttemptReply(reply, request) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return false;
  if (reply.ok === false && reply.code === 'invalid_request' && !Object.hasOwn(reply, 'type') && !Object.hasOwn(reply, 'requestId')) return true;
  if (reply.version !== 1 || reply.type !== request.type || reply.requestId !== request.requestId || typeof reply.ok !== 'boolean') return false;
  if (reply.ok) {
    if (reply.result === 'not_restricted') return absent(reply, ['reason', 'code', 'notBefore']);
    // Provider counters and timestamps are not part of this response contract.
    return reply.result === 'registered' && ['user_message', 'recovery_due'].includes(reply.reason) &&
      absent(reply, ['code', 'notBefore']);
  }
  if (!absent(reply, ['result', 'reason'])) return false;
  if (timedCodes.has(reply.code)) return Number.isSafeInteger(reply.notBefore) && reply.notBefore >= 1e12;
  return plainCodes.has(reply.code) && !Object.hasOwn(reply, 'notBefore');
}

export function createActivationManager(context) {
  const { deps, options, state, diagnostic, now } = context;
  const requests = new Map();
  const uncertain = new Map();
  const uuid = deps.randomUUID ?? randomUUID;
  const requestId = () => `sa-${now()}-${randomBytes(6).toString('hex')}`;
  function hasRuntime(runtime) {
    return [...state.live.values()].some(live => live?.present && live.runtime === runtime) ||
      [...state.activations.values()].some(activation => activation.launchStarted && activation.launchConfig.runtime === runtime);
  }
  function wait(group, code) { diagnostic('wait_health', { session_group: group, code, reason: code }); }
  function waitOrigin(code) {
    if (state.resident.waitCode !== code) wait('origin', code);
    state.resident.waitCode = code;
  }

  async function submitStartAttempt(runtime, group) {
    if (requests.has(runtime) || uncertain.get(runtime) === state.round) return null;
    // Hold admission until the caller publishes its in-flight launch or returns.
    const token = {}; requests.set(runtime, token);
    try {
      const runId = uuid();
      const request = { version: 1, type: 'start_attempt', requestId: requestId(), runtime, sessionGroup: group, runId };
      let result;
      try { result = await deps.submit(request); }
      catch { result = { kind: 'no_reply', sent: true }; }
      if (!['accepted','rejected','connect_failed','deadline_exceeded','no_reply','invalid_reply','timeout'].includes(result?.kind)) result = { kind: 'invalid_reply', sent: true };
      if (['accepted', 'rejected'].includes(result?.kind) &&
          (!validStartAttemptReply(result.reply, request) || (result.kind === 'accepted') !== result.reply.ok)) {
        result = { kind: 'invalid_reply', sent: true };
      }
      if (result.kind !== 'accepted') {
        if (['no_reply', 'invalid_reply', 'timeout'].includes(result.kind) || (result.kind === 'deadline_exceeded' && result.sent)) {
          uncertain.set(runtime, state.round);
        }
        const code = result.kind === 'invalid_reply' ? 'start_attempt_protocol_error' : result.reply?.code ?? result.kind;
        return { runtime, token, runId, accepted: false, code };
      }
      return { runtime, token, runId, accepted: true };
    } catch (error) {
      if (requests.get(runtime) === token) requests.delete(runtime);
      throw error;
    }
  }

  async function begin(group, candidate) {
    const resident = group === null || group === 'origin';
    if (state.activations.has(group)) return;
    let requestRuntime;
    let token, slot, runId;
    try {
      if (resident) {
        if (deps.db.getDrainFence('*') !== null || (group !== null && deps.db.getDrainFence(group) !== null)) {
          if (!state.resident.fenced) diagnostic('start_skipped_fenced', { session_group: group });
          state.resident.fenced = true;
          return;
        }
        state.resident.fenced = false;
      }
      const launchConfig = deps.db.resolveSessionLaunchConfig({ sessionGroup: group, sessionMode: state.mode });
      if (group === null) await deps.prepareSingle(launchConfig.runtime);
      if (group === 'origin') {
        const waitHealth = waitOrigin;
        const health = deps.readRuntimeHealth(launchConfig.runtime);
        const known = !health.missing && !health.unreadable;
        if (known && health.health === 'auth_failed') { waitHealth('auth_blocked'); return; }
        if (known && health.health === 'rate_limited') {
          if (hasRuntime(launchConfig.runtime)) {
            waitHealth('scene_present'); return;
          } else {
            const attempt = await submitStartAttempt(launchConfig.runtime, group);
            if (!attempt) return;
            ({ runtime: requestRuntime, token, runId } = attempt);
            if (!attempt.accepted) { waitHealth(attempt.code); return; }
          }
        }
        state.resident.waitCode = null;
      }
      if (!resident) {
        const health = deps.readRuntimeHealth(launchConfig.runtime);
        if (!health.missing && !health.unreadable && health.health === 'auth_failed') { wait(group, 'auth_blocked'); return; }
        const before = await deps.readLiveIdentity(group);
        state.live.set(group, before);
        if (before.present || deps.db.getDrainFence(group) !== null || deps.db.getDrainFence('*') !== null) return;
        runId = uuid();
        slot = deps.db.takeSlot(group, { runId, k: options.poolSize() });
        context.refreshSlots();
        if (!slot.taken) return;
        if (!health.missing && !health.unreadable && restricted.has(health.health) && !hasRuntime(launchConfig.runtime)) {
          requestRuntime = launchConfig.runtime;
          if (requests.has(requestRuntime) || uncertain.get(requestRuntime) === state.round) return;
          // Claim the runtime's single-flight position before submit can yield.
          token = {}; requests.set(requestRuntime, token);
          const request = { version: 1, type: 'start_attempt', requestId: requestId(), runtime: requestRuntime, sessionGroup: group, runId };
          let result;
          try { result = await deps.submit(request); }
          catch { result = { kind: 'no_reply', sent: true }; }
          if (!['accepted','rejected','connect_failed','deadline_exceeded','no_reply','invalid_reply','timeout'].includes(result?.kind)) result = { kind: 'invalid_reply', sent: true };
          if (['accepted', 'rejected'].includes(result?.kind) &&
              (!validStartAttemptReply(result.reply, request) || (result.kind === 'accepted') !== result.reply.ok)) {
            result = { kind: 'invalid_reply', sent: true };
          }
          if (result?.kind !== 'accepted') {
            if (['no_reply', 'invalid_reply', 'timeout'].includes(result?.kind) || (result?.kind === 'deadline_exceeded' && result.sent)) {
              uncertain.set(requestRuntime, state.round);
            }
            wait(group, result?.kind === 'invalid_reply' ? 'start_attempt_protocol_error' : result?.reply?.code ?? result?.kind ?? 'start_attempt_protocol_error');
            return;
          }
        }
        // A grant belongs only to this candidate. Its occupancy is already reserved;
        // re-observe identity and the pending head before claiming.
        const live = await deps.readLiveIdentity(group);
        state.live.set(group, live);
        if (live.present) return;
        const current = deps.db.getNextPending({ sessionGroups: [group] });
        if (!current || current.id !== candidate.id) return;
        if (deps.db.expirePending(current.id, options.pendingMaxAgeSeconds)) {
          await deps.handleExpired(current, { sessionMode: state.mode, identity: live, launchConfig });
          return;
        }
        if (!deps.db.claimConversation(current.id)) return;
      } else {
        const live = await deps.readLiveIdentity(group);
        state.live.set(group, live);
        if (live.present) return;
      }
      runId ??= uuid();
      const activation = { group, runId, launchConfig, startedAt: now(), message: candidate ?? null,
        resident, slotPrior: slot?.prior, slotTaken: slot?.taken === true, launchStarted: false, launchSettled: false, launchError: null };
      state.activations.set(group, activation);
      slot = null; // The activation now owns release/convergence.
      if (!resident) context.releaseOpportunity(group);
      if (resident) { state.resident.failures++; state.resident.absentSince = null; state.resident.readySince = null; }
      try {
        if (!resident) {
          for (const row of deps.db.expirePendingControls({ sessionGroup: group })) {
            diagnostic('control_expired', { session_group: group, control_id: row.id });
          }
        }
        activation.launchStarted = true;
        diagnostic(resident ? 'start_always' : 'activate_new', { session_group: group, runId, runtime: launchConfig.runtime,
          launchConfig, conversation_id: candidate?.id ?? null, backoffCount: state.resident.failures });
        // Publish the in-flight launch before releasing runtime admission.
        if (token && requests.get(requestRuntime) === token) requests.delete(requestRuntime);
        await deps.getSessionAdapter(launchConfig.runtime).launch({ sessionGroup: group, runId, launchConfig, sessionMode: state.mode });
      } catch (error) { activation.launchError = error; }
      activation.launchSettled = true;
      if (activation.launchError?.code === 'NAME_CONFLICT') {
        if (candidate) deps.db.requeueConversation(candidate.id);
        releaseSlot(activation);
        state.activations.delete(group);
        diagnostic('launch_name_conflict', { session_group: group, runId, conversation_id: candidate?.id ?? null });
        return;
      }
      await advance(group);
    } catch (error) {
      diagnostic('activate_failed', { session_group: group, conversation_id: candidate?.id ?? null, reason: error.code ?? error.message });
      // Once claimed, the activation owns convergence and the running row.
      const activation = state.activations.get(group);
      if (activation && !activation.launchStarted) { activation.launchError = error; activation.launchSettled = true; }
    } finally {
      if (token && requests.get(requestRuntime) === token) requests.delete(requestRuntime);
      if (slot?.taken && !state.activations.has(group)) {
        deps.db.releaseSlot(group, { runId, prior: slot.prior }); context.refreshSlots();
      }
    }
  }

  async function beginContinuation(group) {
    if (state.activations.has(group) || group === null || group === 'origin') return;
    let requestRuntime, token, activation, slot, runId;
    let opportunity = false;
    try {
      if (deps.db.getDrainFence(group) !== null || deps.db.getDrainFence('*') !== null) { context.deferOpportunity(group); return; }
      if (!context.continuationRestarts.canStart(group)) { context.deferOpportunity(group); return; }
      const launchConfig = deps.db.resolveSessionLaunchConfig({ sessionGroup: group, sessionMode: state.mode });
      const health = deps.readRuntimeHealth(launchConfig.runtime);
      if (!health.missing && !health.unreadable && health.health === 'auth_failed') { wait(group, 'auth_blocked'); context.deferOpportunity(group); return; }
      const live = await deps.readLiveIdentity(group);
      state.live.set(group, live);
      if (live.present || deps.db.getDrainFence(group) !== null || deps.db.getDrainFence('*') !== null) return;
      if (deps.db.getNextPending({ sessionGroups: [group] })) return;
      const current = deps.db.listPendingContinuations().find(row => row.sessionGroup === group);
      if (!current) return;
      opportunity = context.acquireOpportunity(group, { id: group, continuation: true });
      if (!opportunity) return;
      runId = uuid();
      slot = deps.db.takeSlot(group, { runId, k: options.poolSize() });
      context.refreshSlots();
      if (!slot.taken) return;
      activation = { group, runId, launchConfig, startedAt: now(), message: null,
        resident: false, continuation: true, slotTaken: true, slotPrior: slot.prior, launchStarted: false, launchSettled: false, launchError: null };
      state.activations.set(group, activation);
      slot = null; // The activation now owns release/convergence.
      context.releaseOpportunity(group); opportunity = false;
      if (!health.missing && !health.unreadable && restricted.has(health.health) && !hasRuntime(launchConfig.runtime)) {
        requestRuntime = launchConfig.runtime;
        if (requests.has(requestRuntime) || uncertain.get(requestRuntime) === state.round) return;
        token = {}; requests.set(requestRuntime, token);
        const request = { version: 1, type: 'start_attempt', requestId: requestId(), runtime: requestRuntime, sessionGroup: group, runId };
        let result;
        try { result = await deps.submit(request); }
        catch { result = { kind: 'no_reply', sent: true }; }
        if (!['accepted','rejected','connect_failed','deadline_exceeded','no_reply','invalid_reply','timeout'].includes(result?.kind)) result = { kind: 'invalid_reply', sent: true };
        if (['accepted','rejected'].includes(result?.kind) &&
            (!validStartAttemptReply(result.reply, request) || (result.kind === 'accepted') !== result.reply.ok)) result = { kind: 'invalid_reply', sent: true };
        if (result?.kind !== 'accepted') {
          if (['no_reply', 'invalid_reply', 'timeout'].includes(result?.kind) || (result?.kind === 'deadline_exceeded' && result.sent)) uncertain.set(requestRuntime, state.round);
          wait(group, result?.kind === 'invalid_reply' ? 'start_attempt_protocol_error' : result?.reply?.code ?? result?.kind ?? 'start_attempt_protocol_error');
          return;
        }
      }
      const latest = await deps.readLiveIdentity(group);
      state.live.set(group, latest);
      if (latest.present || deps.db.getDrainFence(group) !== null || deps.db.getDrainFence('*') !== null || deps.db.getNextPending({ sessionGroups: [group] })) return;
      if (!deps.db.listPendingContinuations().some(row => row.sessionGroup === group)) return;
      for (const row of deps.db.expirePendingControls({ sessionGroup: group })) diagnostic('control_expired', { session_group: group, control_id: row.id });
      activation.launchStarted = true;
      try {
        context.continuationRestarts.started(group);
        diagnostic('activate_continuation', { session_group: group, runId, runtime: launchConfig.runtime });
        if (token && requests.get(requestRuntime) === token) requests.delete(requestRuntime);
        await deps.getSessionAdapter(launchConfig.runtime).launch({ sessionGroup: group, runId, launchConfig, sessionMode: state.mode });
      } catch (error) { activation.launchError = error; }
      activation.launchSettled = true;
      await advance(group);
    } catch (error) {
      diagnostic('activate_failed', { session_group: group, reason: error.code ?? error.message });
    } finally {
      if (token && requests.get(requestRuntime) === token) requests.delete(requestRuntime);
      if (opportunity) context.releaseOpportunity(group);
      if (slot?.taken && !activation) {
        deps.db.releaseSlot(group, { runId, prior: slot.prior }); context.refreshSlots();
      }
      if (activation && !activation.launchStarted && state.activations.get(group) === activation) {
        releaseSlot(activation); state.activations.delete(group); context.releaseOpportunity(group);
      }
    }
  }

  function releaseSlot(activation) {
    if (!activation.slotTaken) return;
    deps.db.releaseSlot(activation.group, { runId: activation.runId, prior: activation.slotPrior });
    activation.slotTaken = false; context.refreshSlots();
  }

  async function advance(group) {
    const activation = state.activations.get(group);
    if (!activation) return;
    // Failed prelaunch cleanup retains ownership so a later round can retry it.
    if (!activation.launchStarted && !activation.launchSettled) {
      releaseSlot(activation); state.activations.delete(group); return;
    }
    if (!activation.launchSettled) return;
    if (activation.launchError?.code === 'NAME_CONFLICT') {
      if (activation.message) deps.db.requeueConversation(activation.message.id);
      releaseSlot(activation);
      state.activations.delete(group);
      if (activation.continuation) context.continuationRestarts.failed(group, activation.runId, { kind: 'launch_error', code: activation.launchError.code ?? 'unknown' });
      return;
    }
    try {
      // One fresh observation after launch settles, including at the timeout boundary.
      const live = await deps.readLiveIdentity(group);
      state.live.set(group, live);
      if (live.present && live.runId === activation.runId && live.ready) {
        context.continuationRestarts.ready(group);
        return;
      }
      if (!activation.launchError && now() - activation.startedAt < options.readyTimeoutMs) return;
      await deps.getSessionAdapter(activation.launchConfig.runtime).stop({
        tmuxName: context.tmuxName(group), expectedRunId: activation.runId,
      });
    } catch (error) {
      // Before the deadline, a failed observation is only a transient read
      // failure. At convergence it means termination cannot be confirmed.
      if (!activation.launchError && now() - activation.startedAt < options.readyTimeoutMs) throw error;
      diagnostic('stop_unconfirmed', { session_group: group, runId: activation.runId, reason: error.code ?? error.message });
      deps.alert?.('stop_unconfirmed', { sessionGroup: group, runId: activation.runId });
      return;
    }
    releaseSlot(activation);
    if (activation.message) deps.db.failDelivery(activation.message.id, { maxRetries: options.maxRetries });
    state.activations.delete(group);
    state.live.delete(group); // Observation must be refreshed, never fabricate READY.
    if (activation.resident) state.resident.absentSince = now();
    if (activation.continuation) context.continuationRestarts.failed(group, activation.runId,
      activation.launchError ? { kind: 'launch_error', code: activation.launchError.code ?? 'unknown' }
        : { kind: 'timeout', seconds: Math.floor((now() - activation.startedAt) / 1000) });
    diagnostic(activation.launchError ? 'activate_failed' : 'activate_timeout', {
      session_group: group, runId: activation.runId, conversation_id: activation.message?.id ?? null,
      reason: activation.launchError?.code ?? 'ready_timeout',
    });
  }
  return { begin, beginContinuation, advance, requests, uncertain };
}
