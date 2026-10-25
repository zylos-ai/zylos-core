import { openTmuxConnection } from '../../../../cli/lib/runtime/tmux-connection.js';
import { resolveSessionTarget, revalidateSessionTarget } from '../../../../cli/lib/runtime/session-target.js';
import { PeriodicEnter } from '../periodic-enter.js';
import { sanitizeMessage } from '../c4-utils.js';
import { findPromptY, isUsageOverlayCapture } from '../tmux-input-state.js';
import { saveEnterCapture } from '../c4-diagnostic.js';
import { DELIVERY_DELAY_BASE, DELIVERY_DELAY_PER_KB, DELIVERY_DELAY_MAX, MAX_RETRIES, RETRY_BASE_MS,
  CONTROL_MAX_RETRIES, ENTER_VERIFY_MAX_RETRIES, ENTER_VERIFY_WAIT_MS, PERIODIC_ENTER_ENABLED,
  PERIODIC_ENTER_INTERVAL_MS, PERIODIC_ENTER_MAX_ATTEMPTS, ENTER_CAPTURE_ENABLED, BRACKETED_PASTE_ENABLED, REQUIRE_IDLE_MIN_SECONDS,
  REQUIRE_IDLE_POST_SEND_HOLD_MS, REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS, REQUIRE_IDLE_EXECUTION_POLL_MS } from '../c4-config.js';

const mismatches = new Set(['TARGET_GONE', 'GENERATION_CHANGED', 'RUNID_MISMATCH']);
const failure = code => Object.assign(new Error(code), { code });
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
    idlePollMs: REQUIRE_IDLE_EXECUTION_POLL_MS, retryBaseMs: RETRY_BASE_MS, ...configuration };
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const open = deps.openTmuxConnection ?? openTmuxConnection;
  const resolve = deps.resolveSessionTarget ?? resolveSessionTarget;
  const revalidate = deps.revalidateSessionTarget ?? revalidateSessionTarget;
  const active = new Set();
  let stopped = false;
  const diagnostic = (event, fields) => {
    try { Promise.resolve(deps.diagnostic?.(event, fields)).catch(() => {}); } catch {}
  };

  async function deliver(row, type) {
    const group = deps.getSessionMode() === 'single' ? null : row.session_group;
    const fields = { session_group: group, [type === 'control' ? 'control_id' : 'conversation_id']: row.id };
    const emit = (event, details = {}) => diagnostic(event, { ...fields, ...details });
    const periodic = new PeriodicEnter({ enabled: options.periodicEnabled, intervalMs: options.periodicIntervalMs,
      maxAttempts: options.periodicMaxAttempts, now, emit });
    let connection, target, adapter, timer, draining = false, queue = Promise.resolve(), periodicError;
    let result = 'blocked', gateCode, error, state = { state: 'offline' }, initial = true, sessionId = null, entered = false;
    const bound = () => ({ target, connection });
    function io(action) {
      const work = queue.then(() => { if (periodicError) throw periodicError; return action(); });
      queue = work.catch(() => {});
      return work;
    }
    async function capture(phase, details) {
      if (!options.captureEnabled) return;
      try {
        const text = await adapter.captureScreen(bound());
        await revalidate(bound());
        const geometry = await connection.command(['display-message', '-p', '-t', target.paneId,
          '#{cursor_x},#{cursor_y},#{pane_width},#{pane_height}']);
        const status = saveEnterCapture(text, phase, { ...fields, ...details, geometry: geometry.trim() });
        if (status === 'capacity' || status === 'failed') emit('capture_skipped', { reason: status });
      } catch (cause) {
        if (mismatches.has(cause.code)) throw cause;
        emit('capture_failed', { phase });
      }
    }
    async function enter(kind) {
      emit('enter_attempt', { kind });
      await adapter.sendKeys({ ...bound(), keys: ['Enter'] });
      entered = true; periodic.entered(); emit('enter_sent', { kind });
    }
    function schedulePeriodic() {
      if (draining || stopped || !periodic.pending || periodic.pending.attempts >= options.periodicMaxAttempts) return;
      timer = setTimeout(() => {
        if (draining || stopped) return;
        io(() => periodic.tick({ eligible: !draining && !stopped, send: async () => {
          try {
            await capture('before', { kind: 'periodic' });
            await enter('periodic');
            await sleep(options.verifyWaitMs);
            await capture('after', { kind: 'periodic' });
          } catch (cause) { periodicError ??= cause; throw cause; }
        } })).finally(schedulePeriodic).catch(() => {});
      }, options.periodicIntervalMs);
    }
    async function readState() {
      let sample;
      try { sample = await deps.readSessionState(group, { freshnessMs: 5000 }); }
      catch (cause) { emit('state_unavailable', { reason: cause.code ?? cause.message }); return { state: 'offline' }; }
      if (sample?.identity?.runId !== target.runId || sample?.identity?.runtime !== target.runtime ||
          !sample.identity.ready || !sample.status?.valid) return { state: 'offline' };
      return sample.status.value;
    }
    async function inputState() {
      await revalidate(bound());
      const rawX = await connection.command(['display-message', '-p', '-t', target.paneId, '#{cursor_x}']);
      const x = Number.parseInt(rawX.trim(), 10);
      let verdict = 'indeterminate';
      if (Number.isInteger(x) && x >= 0) {
        if (x > 2) verdict = 'has_content';
        else {
          await revalidate(bound());
          const y = Number.parseInt((await connection.command(['display-message', '-p', '-t', target.paneId, '#{cursor_y}'])).trim(), 10);
          const prompt = findPromptY(await adapter.captureScreen(bound()));
          if (Number.isInteger(y) && y >= 0 && prompt >= 0) verdict = y === prompt ? 'empty' : 'has_content';
        }
      }
      if (verdict === 'has_content' && target.runtime === 'claude') {
        try {
          const fallback = checkClaudeFallbackInputBox(await adapter.captureScreen(bound()));
          if (fallback !== 'indeterminate') verdict = fallback;
        } catch (cause) { if (mismatches.has(cause.code)) throw cause; }
      }
      emit('input_check', { verdict });
      return verdict;
    }
    async function verify() {
      await io(() => enter('initial'));
      for (let attempt = 0; attempt < options.verifyAttempts; attempt++) {
        await sleep(options.verifyWaitMs);
        let verdict = 'indeterminate';
        try {
          verdict = await io(async () => { await capture('after', { kind: 'normal_verify', attempt }); return inputState(); });
        } catch (cause) { if (mismatches.has(cause.code)) throw cause; }
        if (verdict === 'empty') return true;
        if (verdict === 'has_content') await io(() => enter('verify_retry'));
        else {
          try {
            await io(async () => {
              if (isUsageOverlayCapture(await adapter.captureScreen(bound()))) await adapter.sendKeys({ ...bound(), keys: ['Escape'] });
            });
          } catch (cause) { if (mismatches.has(cause.code)) throw cause; }
        }
      }
      return false;
    }
    async function idleSettlement() {
      await sleep(options.idleHoldMs);
      const deadline = now() + options.idleWaitMs;
      for (;;) {
        const current = await readState();
        if (current.state === 'idle' || offline(current.state) || now() >= deadline || stopped) return;
        await sleep(options.idlePollMs);
      }
    }
    const controller = { cancel: () => { draining = true; clearTimeout(timer); periodic.reset('stop'); } };
    active.add(controller);
    try {
      if (stopped) return { delivered: false, blocked: true };
      try { connection = await open(options.tmux ?? {}); }
      catch (cause) { if (cause.code === 'TMUX_NO_SERVER') throw failure('TARGET_GONE'); throw cause; }
      target = await resolve({ sessionGroup: group, connection });
      initial = false;
      Object.assign(fields, { runId: target.runId, runtime: target.runtime });
      if (type === 'control' && row.target_binding != null) {
        const binding = typeof row.target_binding === 'string' ? JSON.parse(row.target_binding) : row.target_binding;
        if (binding.expectedRunId !== target.runId ||
          ['serverGeneration', 'sessionId', 'paneId'].some(key => binding.tmuxTarget[key] !== target[key]) ||
          (binding.expectedSessionId != null && binding.expectedSessionId !== target.runtimeSessionId)) throw failure('RUNID_MISMATCH');
      }
      if (!target.ready) { gateCode = 'wait_ready'; emit('wait_ready'); }
      else if (!['claude', 'codex'].includes(target.runtime)) { gateCode = 'runtime_unknown'; emit('runtime_unknown'); try { deps.alert?.('runtime_unknown', fields); } catch {} }
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
        } else {
          adapter = deps.getSessionAdapter(target.runtime);
          const content = row.content || '';
          if (bypass && shouldAutoAckHeartbeat({ item, agentState: { state: state.state, healthy: !offline(state.state) }, procState: state.proc,
            confirmedActive: state.active_tools > 0 && Number.isFinite(state.last_api_activity) && now() / 1000 - state.last_api_activity < 60 })) {
            result = 'ack';
          } else if (isKeystrokeControl(item)) {
            await io(() => adapter.sendKeys({ ...bound(), keys: [parseKeystrokeKey(content)] }));
            result = 'ack';
          } else {
            const message = type === 'conversation' ? deps.formatConversation(row) : content.startsWith('/') ? content : `Meanwhile, ${content}`;
            const sanitized = sanitizeMessage(message);
            await io(() => adapter.sendText({ ...bound(), text: sanitized, bracketedPaste: BRACKETED_PASTE_ENABLED }));
            const pastedAt = now();
            if (type === 'conversation') {
              try { Promise.resolve(deps.notifyDelivered({ conversationId: row.id, channel: row.channel,
                sessionGroup: group, runId: target.runId, runtime: target.runtime, pastedAt })).catch(() => {}); } catch {}
            }
            if (type === 'conversation' || !content.startsWith('/')) { periodic.arm(row.id, type); schedulePeriodic(); }
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
            result = type === 'conversation' ? 'delivered' : content.includes('---- ack via:') ? 'submitted' : 'ack';
            if (row.require_idle === 1) await idleSettlement();
          }
        }
      }
    } catch (cause) { error = cause; }
    finally {
      controller.cancel();
      await queue;
      error ??= periodicError;
      try { await connection?.close(); } catch (cause) { error ??= cause; }
      active.delete(controller);
    }
    // No bound I/O may run beyond this point. A DB error propagates rather than
    // entering another transition and risking a replay of a successful paste.
    if (error) {
      const code = error.code ?? 'ENTER_UNVERIFIED';
      emit('delivery_failed', { reason: code });
      if (mismatches.has(code) || (initial && code === 'TMUX_UNAVAILABLE')) {
        if (type === 'control' && row.target_binding != null && mismatches.has(code)) deps.db.failStaleTargetControl(row.id);
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
      emit('release', { code: gateCode, reason: gateCode });
    } else if (result === 'delivered') {
      const current = await deps.readCurrentSession(group);
      if (current?.runId === target.runId && typeof current.sessionId === 'string' && current.sessionId) sessionId = current.sessionId;
      else { emit('delivery_identity_lost', { reason: 'READY_IDENTITY_LOST' }); throw failure('READY_IDENTITY_LOST'); }
      if (!deps.db.markDelivered(row.id, { sessionId })) emit('mark_delivered_stale', { sessionId });
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
  return { deliverConversation: row => run(row, 'conversation'), deliverControl: row => run(row, 'control'),
    async stop() { stopped = true; for (const controller of active) controller.cancel(); await Promise.allSettled([...tasks]); } };
}
