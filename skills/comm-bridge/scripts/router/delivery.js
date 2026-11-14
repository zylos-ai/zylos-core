import { setTimeout as delay } from 'node:timers/promises';
import { loadCoreModule } from './core-modules.js';
import { TMUX_COMMAND as C, TMUX_FORMAT as F, isIdentityError, adapterError } from '../tmux-protocol.js';
const { openTmuxConnection } = await loadCoreModule('runtime/tmux-connection.js');
const { resolveSessionTarget, revalidateSessionTarget } = await loadCoreModule('runtime/session-target.js');
import { PeriodicEnter } from '../periodic-enter.js';
import { sanitizeMessage } from '../c4-utils.js';
import { findPromptY, isUsageOverlayCapture } from '../tmux-input-state.js';
import { saveEnterCapture } from '../c4-diagnostic.js';
import { DELIVERY_DELAY_BASE, DELIVERY_DELAY_PER_KB, DELIVERY_DELAY_MAX, MAX_RETRIES, RETRY_BASE_MS,
  CONTROL_MAX_RETRIES, ENTER_VERIFY_MAX_RETRIES, ENTER_VERIFY_WAIT_MS, PERIODIC_ENTER_ENABLED,
  PERIODIC_ENTER_INTERVAL_MS, PERIODIC_ENTER_MAX_ATTEMPTS, ENTER_CAPTURE_ENABLED, BRACKETED_PASTE_ENABLED, REQUIRE_IDLE_MIN_SECONDS,
  REQUIRE_IDLE_POST_SEND_HOLD_MS, REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS, REQUIRE_IDLE_EXECUTION_POLL_MS } from '../c4-config.js';

const failure = adapterError;
const offline = state => state === 'offline' || state === 'stopped';
export function getDeliveryDelay(bytes) {
  return Math.min(DELIVERY_DELAY_BASE + Math.floor(bytes / 1024) * DELIVERY_DELAY_PER_KB, DELIVERY_DELAY_MAX);
}
export function getClaudeInputBoxText(capture) {
  const lines = capture.split('\n');
  const separators = lines.flatMap((line, index) => /^─{10,}/.test(line) ? [index] : []);
  if (separators.length < 2) return null;
  return lines.slice(separators.at(-2) + 1, separators.at(-1)).join('\n');
}
export function checkClaudeFallbackInputBox(capture) {
  const text = getClaudeInputBoxText(capture);
  if (text === null) return 'indeterminate';
  const right = Array.from((text.split('\n')[0] || '').replace(/^\s*[›❯]/, '')).slice(0, 10).join('');
  return right.replace(/[\p{C}\p{Z}]+/gu, '').length ? 'has_content' : 'empty';
}
export function getHeartbeatPhase(content) { return String(content || '').match(/\[phase=([a-z_-]+)\]/i)?.[1]?.toLowerCase() ?? 'unknown'; }
export function isRecoveryHeartbeatPhase(phase) { return phase === 'recovery' || phase === 'post_restart'; }
export function isBypassState(item) { return item.type === 'control' && item.bypass_state === 1; }
export function isKeystrokeControl(item) { return item.type === 'control' && (item.content || '').startsWith('[KEYSTROKE]'); }
export function parseKeystrokeKey(content) { return (content || '').slice('[KEYSTROKE]'.length).trim(); }
export function isCodexExitLifecycleControl(item, runtime) { return item.type === 'control' && runtime === 'codex' && item.content === '/exit'; }
export function shouldAutoAckHeartbeat({ item, agentState, procState, confirmedActive }) {
  return Boolean(item?.content?.includes('Heartbeat check') && !isRecoveryHeartbeatPhase(getHeartbeatPhase(item.content)) &&
    agentState?.healthy === true && !offline(agentState.state) && procState?.alive === true && confirmedActive);
}

/** A claimed row owns its bound executor until every delayed send has drained.
 * Scheduler lane serialization remains the authority for one claim per group. */
export function createDelivery(deps, configuration = {}) {
  const options = { verifyWaitMs: ENTER_VERIFY_WAIT_MS, verifyAttempts: ENTER_VERIFY_MAX_RETRIES,
    periodicEnabled: PERIODIC_ENTER_ENABLED, periodicIntervalMs: PERIODIC_ENTER_INTERVAL_MS,
    periodicMaxAttempts: PERIODIC_ENTER_MAX_ATTEMPTS, captureEnabled: ENTER_CAPTURE_ENABLED,
    idleHoldMs: REQUIRE_IDLE_POST_SEND_HOLD_MS, idleWaitMs: REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS,
    idlePollMs: REQUIRE_IDLE_EXECUTION_POLL_MS, retryBaseMs: RETRY_BASE_MS,
    gateBackoffBaseMs: 1000, gateBackoffMaxMs: 30000, ...configuration };
  const now = deps.now ?? Date.now;
  const periodicNow = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const open = deps.openTmuxConnection ?? openTmuxConnection;
  const resolve = deps.resolveSessionTarget ?? resolveSessionTarget;
  const revalidate = deps.revalidateSessionTarget ?? revalidateSessionTarget;
  const active = new Set();
  const periodicGroups = new Map();
  const waits = new Map();
  let stopped = false;
  const diagnostic = (event, fields) => {
    try { Promise.resolve(deps.diagnostic?.(event, fields)).catch(() => {}); } catch {}
  };
  function groupPeriodic(group, fields) {
    let entry = periodicGroups.get(group);
    if (!entry) {
      entry = { fields };
      entry.timer = new PeriodicEnter({ enabled: options.periodicEnabled, intervalMs: options.periodicIntervalMs,
        maxAttempts: options.periodicMaxAttempts, now: periodicNow,
        emit: (event, details) => diagnostic(event, { ...entry.fields, ...details }) });
      if (options.periodicEnabled && !stopped) periodicGroups.set(group, entry);
    }
    return entry.timer;
  }
  function clearPeriodicEnter(group, reason = 'lane_stopped') {
    periodicGroups.get(group)?.timer.reset(reason);
    periodicGroups.delete(group);
  }
  async function captureBound({ target, connection, adapter }, fields, phase, details = {}) {
    if (!options.captureEnabled) return;
    try {
      const text = await adapter.captureScreen({ target, connection });
      await revalidate({ target, connection });
      const geometry = await connection.command([C.displayMessage, '-p', '-t', target.paneId, F.geometry]);
      const status = saveEnterCapture(text, phase, { ...fields, ...details, geometry: geometry.trim() });
      if (status === 'capacity' || status === 'failed') diagnostic('capture_skipped', { ...fields, reason: status });
    } catch (cause) {
      if (isIdentityError(cause)) throw cause;
      diagnostic('capture_failed', { ...fields, phase });
    }
  }
  async function supplement(group) {
    const entry = periodicGroups.get(group), periodic = entry?.timer;
    if (stopped || !periodic?.pending) return;
    if (periodic.pending.attempts >= options.periodicMaxAttempts) return clearPeriodicEnter(group, 'exhausted');
    if (periodicNow() - periodic.pending.lastAt < options.periodicIntervalMs) return;
    // A supplementary operation owns a fresh bound executor in the same lane.
    // It never reuses a settled claim's connection or changes its ledger.
    let connection;
    await periodic.tick({ eligible: !stopped, send: async () => {
      try {
        connection = await open(options.tmux ?? {});
        const target = await resolve({ sessionGroup: group, connection });
        if (stopped || !target.ready || !['claude', 'codex'].includes(target.runtime)) throw failure('ENTER_UNVERIFIED');
        entry.fields = { ...entry.fields, runId: target.runId, runtime: target.runtime };
        const adapter = deps.getSessionAdapter(target.runtime);
        await captureBound({ target, connection, adapter }, entry.fields, 'before', { kind: 'periodic' });
        await revalidate({ target, connection });
        await adapter.sendKeys({ target, connection, keys: ['Enter'] });
        await sleep(options.verifyWaitMs);
        await captureBound({ target, connection, adapter }, entry.fields, 'after', { kind: 'periodic' });
      } finally { await connection?.close(); }
    } });
    if (periodic.pending?.attempts >= options.periodicMaxAttempts) clearPeriodicEnter(group, 'exhausted');
  }

  const waitKey = (row, type) => `${type}:${row.id}`;
  function waitFields(wait) {
    return { ...wait.fields, code: wait.code, reason: wait.reason, attempts: wait.attempts,
      deferredChecks: wait.deferredChecks, durationMs: Math.max(0, now() - wait.startedAt),
      phaseDurationMs: Math.max(0, now() - wait.changedAt) };
  }
  function finishWait(row, type, outcome = 'resumed', fields) {
    const key = waitKey(row, type), wait = waits.get(key);
    if (!wait) return;
    if (fields) wait.fields = fields;
    waits.delete(key);
    diagnostic(outcome === 'expired' ? 'delivery_expired' : outcome === 'resumed' ? 'delivery_resumed' : 'delivery_wait_ended',
      { ...waitFields(wait), ...(outcome === 'expired' || outcome === 'resumed' ? {} : { outcome }) });
  }
  function defer(row, type, code, reason, fields) {
    const key = waitKey(row, type);
    let wait = waits.get(key);
    if (!wait) {
      wait = { fields, row, type, code, reason, attempts: 1, deferredChecks: 0, startedAt: now(), changedAt: now() };
      waits.set(key, wait);
      diagnostic('delivery_deferred', waitFields(wait));
    } else {
      wait.fields = fields;
      wait.attempts++;
      if (wait.code !== code || wait.reason !== reason) {
        diagnostic('delivery_wait_changed', { ...waitFields(wait), previousCode: wait.code, previousReason: wait.reason, code, reason });
        wait.code = code; wait.reason = reason; wait.changedAt = now();
      }
    }
    wait.retryAt = now() + Math.min(options.gateBackoffBaseMs * 2 ** Math.min(wait.attempts - 1, 10), options.gateBackoffMaxMs);
  }
  function canAttempt(row, type) {
    const wait = waits.get(waitKey(row, type));
    if (!wait || now() >= wait.retryAt) return true;
    wait.deferredChecks++;
    return false;
  }
  function sweepWaits() {
    for (const wait of waits.values()) {
      if (wait.type === 'conversation' && typeof deps.db.getConversationsByRange !== 'function') continue;
      const row = wait.type === 'control' ? deps.db.getControlById?.(wait.row.id)
        : deps.db.getConversationsByRange(wait.row.id, wait.row.id)[0];
      if (row?.status === 'pending' || row?.status === 'running') continue;
      // Expiration and cancellation can settle a row before its lane sees it
      // again. Diagnostic memory follows the same authoritative row lifetime.
      const expired = wait.type === 'control' ? row?.status === 'timeout' && row.last_error === 'ACK_DEADLINE_EXCEEDED'
        : row?.delivery_action === 'pending_expired';
      const outcome = wait.type === 'control' ? row?.last_error ?? row?.status : row?.status;
      finishWait(wait.row, wait.type, expired ? 'expired' : outcome ?? 'removed');
    }
  }

  async function deliver(row, type) {
    const group = deps.getSessionMode() === 'single' ? null : row.session_group;
    const fields = { session_group: group, [type === 'control' ? 'control_id' : 'conversation_id']: row.id };
    const emit = (event, details = {}) => diagnostic(event, { ...fields, ...details });
    const periodic = groupPeriodic(group, fields);
    let connection, target, adapter, timer, draining = false, queue = Promise.resolve();
    let result = 'blocked', gateCode, gateReason, error, state = { state: 'offline' }, initial = true, sessionId = null, entered = false;
    // A control typed into the session as a message (not a key, a slash command or an auto-acknowledged heartbeat) is
    // input the agent works on, delivered like a conversation message.
    let typed = false;
    const bound = () => ({ target, connection });
    function io(action) {
      const work = queue.then(action);
      queue = work.catch(() => {});
      return work;
    }
    async function capture(phase, details) {
      return captureBound({ target, connection, adapter }, fields, phase, details);
    }
    async function enter(kind) {
      emit('enter_attempt', { kind });
      await adapter.sendKeys({ ...bound(), keys: ['Enter'] });
      entered = true; emit('enter_sent', { kind });
    }
    function schedulePeriodic() {
      if (draining || stopped || !periodic.pending || periodic.pending.attempts >= options.periodicMaxAttempts) return;
      timer = setTimeout(() => {
        if (draining || stopped) return;
        io(() => periodic.tick({ eligible: !draining && !stopped, send: async () => {
          await capture('before', { kind: 'periodic' });
          await enter('periodic');
          await sleep(options.verifyWaitMs);
          await capture('after', { kind: 'periodic' });
        } })).finally(schedulePeriodic).catch(() => {});
      }, Math.max(0, options.periodicIntervalMs - (periodicNow() - periodic.pending.lastAt)));
    }
    async function readState() {
      let sample;
      try { sample = await deps.readSessionState(group, { freshnessMs: 5000 }); }
      catch (cause) { emit('state_unavailable', { reason: cause.code ?? cause.message }); return { state: 'offline' }; }
      if (sample?.identity?.runId !== target.runId || sample?.identity?.runtime !== target.runtime ||
          !sample.identity.ready) return { state: 'offline' };
      if (sample.status?.valid) return sample.status.value;
      if (sample.status?.reason === 'stale') {
        emit('state_stale', { sampledAt: sample.status.sampledAt, health: sample.status.lastValue?.health ?? null });
        // Old health is useful, but old idle/activity evidence cannot pace a lane
        // or acknowledge a heartbeat on behalf of the live runtime.
        return { state: 'unknown', health: sample.status.lastValue?.health ?? null };
      }
      if (['missing', 'unparseable'].includes(sample.status?.reason)) return { state: 'unknown' };
      return { state: 'offline' };
    }
    async function inputState() {
      await revalidate(bound());
      const rawX = await connection.command([C.displayMessage, '-p', '-t', target.paneId, F.cursorX]);
      const x = Number.parseInt(rawX.trim(), 10);
      let verdict = 'indeterminate';
      if (Number.isInteger(x) && x >= 0) {
        if (x > 2) verdict = 'has_content';
        else {
          await revalidate(bound());
          const y = Number.parseInt((await connection.command([C.displayMessage, '-p', '-t', target.paneId, F.cursorY])).trim(), 10);
          const prompt = findPromptY(await adapter.captureScreen(bound()));
          if (Number.isInteger(y) && y >= 0 && prompt >= 0) verdict = y === prompt ? 'empty' : 'has_content';
        }
      }
      if (verdict === 'has_content' && target.runtime === 'claude') {
        try {
          const fallback = checkClaudeFallbackInputBox(await adapter.captureScreen(bound()));
          if (fallback !== 'indeterminate') verdict = fallback === 'empty' ? 'disputed_empty' : fallback;
        } catch (cause) { if (isIdentityError(cause)) throw cause; }
      }
      emit('input_check', { verdict });
      return verdict;
    }
    async function verify() {
      await io(() => enter('initial'));
      let disputeRetried = false, lastVerdict;
      for (let attempt = 0; attempt < options.verifyAttempts; attempt++) {
        await sleep(options.verifyWaitMs);
        let verdict = 'indeterminate';
        try {
          verdict = await io(async () => { await capture('after', { kind: 'normal_verify', attempt }); return inputState(); });
        } catch (cause) { if (isIdentityError(cause)) throw cause; }
        lastVerdict = verdict;
        if (verdict === 'empty') return true;
        if (verdict === 'disputed_empty') {
          if (disputeRetried) return true;
          disputeRetried = true;
          await io(() => enter('dispute_retry'));
          continue;
        }
        if (verdict === 'has_content') await io(() => enter('verify_retry'));
        else {
          try {
            await io(async () => {
              if (isUsageOverlayCapture(await adapter.captureScreen(bound()))) await adapter.sendKeys({ ...bound(), keys: ['Escape'] });
            });
          } catch (cause) { if (isIdentityError(cause)) throw cause; }
        }
      }
      return lastVerdict === 'disputed_empty';
    }
    const idleWait = new AbortController();
    async function waitForIdle(ms) {
      if (stopped || draining) return;
      try { await sleep(ms, idleWait.signal); }
      catch (error) { if (error.name !== 'AbortError' || !idleWait.signal.aborted) throw error; }
    }
    async function idleSettlement() {
      // Router stop already blocks the next message. Only this queue pacing
      // wait may be cancelled; paste, Enter and verification still drain.
      if (stopped || draining) return;
      await waitForIdle(options.idleHoldMs);
      const deadline = now() + options.idleWaitMs;
      for (;;) {
        if (stopped || draining) return;
        const current = await readState();
        if (current.state === 'idle' || offline(current.state) || now() >= deadline || stopped) return;
        await waitForIdle(options.idlePollMs);
      }
    }
    const controller = { cancel: () => { draining = true; idleWait.abort(); clearTimeout(timer); } };
    active.add(controller);
    try {
      if (stopped) gateCode = 'delivery_stopped';
      else {
        connection = await open(options.tmux ?? {});
        target = await resolve({ sessionGroup: group, connection });
        initial = false;
        Object.assign(fields, { runId: target.runId, runtime: target.runtime });
        if (type === 'control' && row.target_binding != null) {
          const binding = typeof row.target_binding === 'string' ? JSON.parse(row.target_binding) : row.target_binding;
          if (binding.expectedRunId !== target.runId ||
            ['serverGeneration', 'sessionId', 'paneId'].some(key => binding.tmuxTarget[key] !== target[key]) ||
            (binding.expectedSessionId != null && binding.expectedSessionId !== target.runtimeSessionId)) throw failure('RUNID_MISMATCH');
        }
        if (!target.ready) { gateCode = 'wait_ready'; }
        else if (!['claude', 'codex'].includes(target.runtime)) { gateCode = 'runtime_unknown'; try { deps.alert?.('runtime_unknown', fields); } catch {} }
        else {
        state = await readState();
        const item = { ...row, type };
        const bypass = isBypassState(item);
        const health = deps.readRuntimeHealth(target.runtime);
        const publicHealth = health.missing ? 'ok' : health.unreadable ? 'unavailable' : (health.publicHealth ?? health.health);
        if ((!bypass && (offline(state.state) || (state.health ?? 'ok') !== 'ok' || publicHealth !== 'ok')) ||
          (row.require_idle === 1 && (state.state !== 'idle' || !(Number.isFinite(state.idle_seconds) && state.idle_seconds >= REQUIRE_IDLE_MIN_SECONDS)))) {
          gateCode = !bypass && offline(state.state) ? 'session_offline'
            : !bypass && (state.health ?? 'ok') !== 'ok' ? 'session_unhealthy'
            : !bypass && publicHealth !== 'ok' ? 'runtime_unavailable' : 'require_idle';
          gateReason = gateCode === 'session_unhealthy' ? `session_${state.health}`
            : gateCode === 'runtime_unavailable' ? `runtime_${publicHealth}` : gateCode;
        } else {
          finishWait(row, type, 'resumed', { ...fields });
          adapter = deps.getSessionAdapter(target.runtime);
          const content = row.content || '';
          if (bypass && shouldAutoAckHeartbeat({ item, agentState: { state: state.state, healthy: !offline(state.state) }, procState: state.proc,
            confirmedActive: state.active_tools > 0 && Number.isFinite(state.last_api_activity) && now() / 1000 - state.last_api_activity < 60 })) {
            result = 'ack';
          } else if (isKeystrokeControl(item)) {
            periodic.reset('keystroke');
            await io(() => adapter.sendKeys({ ...bound(), keys: [parseKeystrokeKey(content)] }));
            result = 'ack';
          } else {
            if (type === 'control' && content.startsWith('/')) periodic.reset('slash_control');
            const message = type === 'conversation' ? deps.formatConversation(row) : content.startsWith('/') ? content : `Meanwhile, ${content}`;
            const sanitized = sanitizeMessage(message);
            await io(() => adapter.sendText({ ...bound(), text: sanitized, bracketedPaste: BRACKETED_PASTE_ENABLED }));
            const pastedAt = now();
            try { Promise.resolve(deps.notifyDelivered({
              ...(type === 'conversation' ? { conversationId: row.id, channel: row.channel } : { controlId: row.id }),
              sessionGroup: group, runId: target.runId, runtime: target.runtime, pastedAt })).catch(() => {}); } catch {}
            if (type === 'conversation' || !content.startsWith('/')) {
              const entry = periodicGroups.get(group);
              if (entry) entry.fields = fields;
              periodic.arm(row.id, type);
            }
            await sleep(getDeliveryDelay(Buffer.byteLength(sanitized, 'utf8')));
            let verified;
            try { verified = await verify(); }
            catch (cause) {
              // Exact Codex lifecycle command may remove its own pane after Enter.
              // A replacement server/run is never accepted as shutdown.
              if (isCodexExitLifecycleControl(item, target.runtime) && entered && cause.code === 'TARGET_GONE') verified = true;
              else throw cause;
            }
            if (!verified) {
              const after = await readState();
              if (type === 'conversation' || ((after.proc?.alive === false || offline(after.state)) &&
                !(isCodexExitLifecycleControl(item, target.runtime)))) throw failure('ENTER_UNVERIFIED');
            }
            schedulePeriodic();
            result = type === 'conversation' ? 'delivered' : content.includes('---- ack via:') ? 'submitted' : 'ack';
            typed = type === 'control' && !content.startsWith('/');
            if (row.require_idle === 1) await idleSettlement();
          }
        }
        }
      }
    } catch (cause) { error = cause; }
    finally {
      controller.cancel();
      await queue;
      try { await connection?.close(); } catch (cause) { error ??= cause; }
      active.delete(controller);
    }
    // No bound I/O may run beyond this point. A DB error propagates rather than
    // entering another transition and risking a replay of a successful paste.
    if (error) {
      const code = error.code ?? 'ENTER_UNVERIFIED';
      emit('delivery_failed', { reason: code });
      if (isIdentityError(code) || (initial && code === 'TMUX_UNAVAILABLE')) {
        if (type === 'control' && row.target_binding != null && isIdentityError(code)) deps.db.failStaleTargetControl(row.id);
        else if (type === 'control') deps.db.requeueControl(row.id, code);
        else deps.db.requeueConversation(row.id);
      } else if (type === 'control') deps.db.retryOrFailControl(row.id, code, CONTROL_MAX_RETRIES);
      else {
        const transition = deps.db.failDelivery(row.id, { maxRetries: MAX_RETRIES });
        if (!transition.changed) emit('conditional_write_lost', { operation: 'failDelivery' });
        else if (transition.status === 'pending') await sleep(options.retryBaseMs * 2 ** (transition.retryCount - 1));
      }
      return { delivered: false, blocked: true, state: state.state };
    }
    if (result === 'blocked') {
      if (type === 'control') deps.db.requeueControl(row.id);
      else deps.db.requeueConversation(row.id);
      defer(row, type, gateCode, gateReason ?? gateCode, { ...fields });
    } else if (result === 'delivered' || typed) {
      if (result === 'ack') deps.db.ackControl(row.id);
      // The body is already verified. Missing final identity only affects attribution.
      try {
        const current = await deps.readCurrentSession(group);
        if (current?.runId === target.runId && typeof current.sessionId === 'string' && current.sessionId) sessionId = current.sessionId;
        else emit('delivery_identity_lost', { reason: current && current.runId !== target.runId ? 'run_mismatch' : 'missing' });
      } catch {
        emit('delivery_identity_lost', { reason: 'read_failed' });
      }
      if (type === 'control') emit('deliver', { sessionId });
      else if (!deps.db.markDelivered(row.id, { sessionId })) emit('mark_delivered_stale', { sessionId });
      else emit('deliver', { sessionId });
    } else if (result === 'ack') deps.db.ackControl(row.id);
    return { delivered: result !== 'blocked', blocked: result === 'blocked', state: state.state };
  }
  const tasks = new Set();
  function run(row, type) {
    const task = deliver(row, type); tasks.add(task);
    task.finally(() => tasks.delete(task)).catch(() => {});
    return task;
  }
  return { canAttempt, finishWait, sweepWaits, clearPeriodicEnter,
    maybePeriodicEnter(group) {
      const task = supplement(group); tasks.add(task);
      task.finally(() => tasks.delete(task)).catch(() => {}); return task;
    },
    deliverConversation: row => run(row, 'conversation'), deliverControl: row => run(row, 'control'),
    async stop() { stopped = true; for (const controller of active) controller.cancel(); await Promise.allSettled([...tasks]);
      for (const group of periodicGroups.keys()) clearPeriodicEnter(group); waits.clear(); } };
}
