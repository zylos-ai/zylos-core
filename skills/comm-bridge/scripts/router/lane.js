/** One in-memory execution slot per group. No waiting lane owns another lane. */
export function createLane(context, group) {
  const { state, deps, options, diagnostic, now } = context;
  const filter = group === null ? undefined : { sessionGroups: [group] };
  let working = null;
  let startupIdentity = null;
  let startupIds = [];
  let startupLoaded = false;
  let stopped = false;

  async function nextMessage() {
    for (;;) {
      const row = deps.db.getNextPending(filter);
      if (!row) return null;
      if (!deps.db.expirePending(row.id, options.pendingMaxAgeSeconds)) return row;
      await deps.handleExpired(row, { sessionMode: state.mode, identity: state.live.get(group) });
      if (stopped) return null;
    }
  }
  function releaseActivation(reason) {
    const activation = state.activations.get(group);
    if (!activation) return;
    if (activation.message) deps.db.requeueConversation(activation.message.id);
    state.activations.delete(group);
    diagnostic(reason, { session_group: group, runId: activation.runId, conversation_id: activation.message?.id ?? null });
  }
  async function sendControl(row, live, startup = false) {
    if (!deps.db.claimControl(row.id)) {
      if (startup && deps.db.getControlById(row.id)?.status === 'pending') releaseActivation('fenced_during_launch');
      return { claimed: false, blocked: true };
    }
    const result = await deps.deliverControl(row, live);
    if (startup && result?.blocked) releaseActivation('release');
    return { claimed: true, blocked: result?.blocked ?? false };
  }
  async function ready(live) {
    const key = `${live.runId}\0${live.sessionId}`;
    if (startupIdentity !== key) { startupIdentity = key; startupLoaded = false; startupIds = []; }
    if (!startupLoaded) {
      const current = await deps.readCurrentSession(group);
      if (!current || current.runId !== live.runId || current.sessionId !== live.sessionId || !Array.isArray(current.startupControlIds)) return;
      startupIds = [...current.startupControlIds];
      startupLoaded = true;
      diagnostic('adopt_ready', { session_group: group, runId: live.runId, session_id: live.sessionId });
      if (!startupIds.length) diagnostic('startup_prompt_missing', { session_group: group, runId: live.runId, session_id: live.sessionId });
    }
    const control = deps.db.getNextPendingControl(Math.floor(now() / 1000), filter);
    // Recovery controls are already priority-zero and bypass-gated by their
    // producers. They must not wait behind a health-blocked startup prompt.
    if (control?.bypass_state && !startupIds.includes(control.id)) {
      await sendControl(control, live); return;
    }
    while (startupIds.length) {
      const id = startupIds[0];
      const row = deps.db.getControlById(id);
      if (!row || row.status !== 'pending') { startupIds.shift(); continue; }
      if (row.session_group !== group || (row.available_at !== null && row.available_at > Math.floor(now() / 1000))) return;
      const result = await sendControl(row, live, true);
      if (result.claimed && !result.blocked) startupIds.shift();
      return;
    }
    if (control) { await sendControl(control, live); return; }
    const activation = state.activations.get(group);
    if (activation) {
      // A settled delivery failure must not replay an already-pasted trigger.
      // If its DB write threw, the row remains running for startup recovery.
      try { if (activation.message) await deps.deliverConversation(activation.message, live); }
      finally { state.activations.delete(group); }
      return;
    }
    const row = await nextMessage();
    if (row && deps.db.claimConversation(row.id)) await deps.deliverConversation(row, live);
  }
  async function step() {
    const activation = state.activations.get(group);
    if (activation) {
      await context.activation.advance(group);
      if (!state.activations.has(group)) return;
    }
    const live = state.live.get(group);
    if (!live) return; // Unobservable is not absent.
    if (live.present) {
      if (live.ready && live.runId) return ready(live);
      if (activation) return;
      return context.handleUnowned(group, live);
    }
    startupIdentity = null; startupLoaded = false;
    if (group === null || group === 'origin') {
      state.resident.readySince = null;
      state.resident.absentSince ??= now();
      const delay = Math.min(5 * 2 ** Math.min(state.resident.failures, 4), 60) * 1000;
      if (now() - state.resident.absentSince >= delay) await context.activation.begin(group, null);
      return;
    }
    const row = await nextMessage();
    if (!row) return;
    if (context.availableCapacity() <= 0) {
      diagnostic('wait_capacity', { session_group: group, conversation_id: row.id });
      return;
    }
    if (!context.acquireOpportunity(group, row)) return;
    try { await context.activation.begin(group, row); }
    finally { context.releaseOpportunity(group); }
  }
  function kick() {
    if (working || stopped) return working;
    working = Promise.resolve().then(step).catch(error => {
      diagnostic('lane_error', { session_group: group, reason: error.code ?? error.message });
    }).finally(() => { working = null; });
    return working;
  }
  return { kick, get working() { return working; }, stop() { stopped = true; }, nextMessage };
}
