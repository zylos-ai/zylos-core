import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { loadCoreModule } from './core-modules.js';

const execute = promisify(execFile);
const isTargetError = code => code === 'STALE_TARGET' || String(code || '').startsWith('TARGET_');
function envelope(text) {
  try { const value = JSON.parse(text.trim()); return typeof value?.ok === 'boolean' ? value : null; } catch { return null; }
}

function restartDashboard() {
  const child = spawn('pm2', ['restart', 'zylos-dashboard'], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

export function buildRestartStatus(requestId, completion, current = {}) {
  return {
    requestId,
    completion: completion === 'deadline_exceeded' ? 'unknown' : completion || 'unknown',
    origin: {
      runId: current.runId ?? null,
      sessionId: current.sessionId ?? null,
      ready: current.ready === true,
      state: current.state || 'UNKNOWN',
    },
  };
}

async function command(file, args, { timeout = 10000 } = {}) {
  try {
    const { stdout } = await execute(file, args, { timeout, maxBuffer: 1024 * 1024 });
    return envelope(stdout || '') || { ok: false, unknown: true, error: { code: 'RESULT_UNKNOWN' } };
  } catch (error) {
    return envelope(error.stdout || '') || { ok: false, unknown: true, error: { code: 'RESULT_UNKNOWN', message: error.message } };
  }
}

async function control(content, target, zylosDir) {
  const script = path.join(zylosDir, '.claude/skills/comm-bridge/scripts/c4-control.js');
  const args = [script, 'enqueue', '--content', content, '--priority', '0', '--bypass-state', '--no-ack-suffix', '--target-run', target.runId, '--json'];
  if (target.sessionGroup !== null) args.push('--group', 'origin');
  if (target.sessionId) args.push('--expected-session', target.sessionId);
  const reply = await command(process.execPath, args);
  if (reply.ok && !Number.isSafeInteger(reply.data?.id)) return { ok: false, unknown: true, error: { code: 'RESULT_UNKNOWN' } };
  return { ...reply, controlId: reply.data?.id ?? null, submission: reply.ok ? 'submitted' : reply.unknown ? 'unknown' : 'rejected', rejectionCode: reply.error?.code ?? null, targetChanged: isTargetError(reply.error?.code), currentRunId: reply.error?.runId ?? null };
}

export async function handleCoreAction(action, body, config) {
  const { readSessionMode } = await loadCoreModule('config.js');
  const { mode } = readSessionMode();
  const sessionGroup = mode === 'multi' ? 'origin' : null;
  if (body?.sessionGroup !== undefined && body.sessionGroup !== sessionGroup) return { ok: false, error: 'TARGET_SCOPE_MISMATCH', message: 'Refresh the Origin target before submitting.' };
  const target = Object.freeze({ sessionGroup, runId: body?.runId, sessionId: body?.sessionId || null });
  if (['interrupt', 'chop-chop'].includes(action)) {
    if (typeof target.runId !== 'string' || !target.runId) return { ok: false, error: 'TARGET_REQUIRED', message: 'Refresh and confirm the current Origin run.' };
    const first = await control('[KEYSTROKE]Escape', target, config.zylosDir);
    first.control = 'escape';
    if (action === 'interrupt' || !first.ok) return { ...first, steps: [first], messageKey: first.ok ? 'result.interrupt_submitted' : first.unknown ? 'result.control_unknown' : 'result.control_rejected', messageParams: { code: first.rejectionCode || 'unknown' } };
    await delay(500);
    const second = await control('continue', target, config.zylosDir);
    second.control = 'continue';
    return { ...second, steps: [first, second], messageKey: second.ok ? 'result.controls_submitted' : second.targetChanged ? 'result.control_target_changed' : second.unknown ? 'result.control_unknown' : 'result.control_rejected', messageParams: { code: second.rejectionCode || 'unknown', runId: second.currentRunId || 'unknown' }, refreshState: second.targetChanged };
  }
  if (action === 'restart-session') {
    const { submit, lookupRestartRequest } = await loadCoreModule('am-sock-client.js');
    const requestId = crypto.randomUUID();
    const deadlineAt = Date.now() + 10000;
    const request = { version: 1, type: 'manual_restart', requestId, ...(target.runId ? { expectedRunId: target.runId } : {}), ...(target.sessionId ? { expectedSessionId: target.sessionId } : {}) };
    const result = await submit(request, { deadlineAt });
    if (result.kind === 'accepted' || result.kind === 'rejected') return { ok: result.kind === 'accepted', requestId, submission: result.kind, ...result.reply, message: `Restart ${result.reply.result || result.reply.code || result.reply.reason}; old-run completion and new Origin readiness are separate.` };
    const notSubmitted = result.kind === 'connect_failed' || (result.kind === 'deadline_exceeded' && !result.sent);
    let completion = 'unknown';
    if (!notSubmitted) { try { completion = await lookupRestartRequest(requestId, { deadlineAt }); } catch {} }
    if (completion === 'deadline_exceeded') completion = 'unknown';
    return { ok: false, requestId, submission: notSubmitted ? 'not_submitted' : 'unknown', completion, error: result.kind, messageKey: notSubmitted ? 'result.restart_not_submitted' : 'result.restart_unknown' };
  }
  if (action === 'switch-mode') {
    if (!['single', 'multi'].includes(body?.mode)) return { ok: false, error: 'INVALID_MODE' };
    return command('zylos', ['session-mode', 'switch', body.mode, '--json'], { timeout: 30000 });
  }
  if (action === 'switch-runtime') {
    if (!['claude', 'codex'].includes(body?.runtime)) return { ok: false, error: 'INVALID_RUNTIME' };
    const result = await command('zylos', ['runtime', body.runtime, '--json'], { timeout: 65000 });
    const saved = result.ok && result.data?.result === 'saved';
    const unchanged = result.ok && result.data?.result === 'unchanged';
    if (saved) {
      setTimeout(() => {
        restartDashboard();
      }, 1000).unref?.();
    }
    return { ...result, detached: saved, messageKey: saved ? 'result.runtime_saved' : unchanged ? 'result.runtime_unchanged' : 'result.runtime_unknown', messageParams: { value: body.runtime } };
  }
  return { ok: false, error: 'UNKNOWN_ACTION' };
}
