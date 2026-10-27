import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { loadCoreModule } from './core-modules.js';

const execute = promisify(execFile);
const targetErrors = new Set(['TARGET_MISMATCH', 'STALE_TARGET', 'TARGET_NOT_RUNNING']);
function envelope(text) {
  try { const value = JSON.parse(text.trim()); return typeof value?.ok === 'boolean' ? value : null; } catch { return null; }
}

export function createCoreActions({ exec = execute, sleep = delay, load = loadCoreModule, now = Date.now } = {}) {
  async function command(file, args) {
    try {
      const { stdout } = await exec(file, args, { timeout: 10000, maxBuffer: 1024 * 1024 });
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
    return { ...reply, submission: reply.ok ? 'submitted' : reply.unknown ? 'unknown' : 'rejected', targetChanged: targetErrors.has(reply.error?.code) };
  }
  return async function coreAction(action, body, config) {
    const { readSessionMode } = await load('config.js');
    const { mode } = readSessionMode();
    const sessionGroup = mode === 'multi' ? 'origin' : null;
    if (body?.sessionGroup !== undefined && body.sessionGroup !== sessionGroup) return { ok: false, error: 'TARGET_SCOPE_MISMATCH', message: 'Refresh the Origin target before submitting.' };
    const target = Object.freeze({ sessionGroup, runId: body?.runId, sessionId: body?.sessionId || null });
    if (['interrupt', 'chop-chop'].includes(action)) {
      if (typeof target.runId !== 'string' || !target.runId) return { ok: false, error: 'TARGET_REQUIRED', message: 'Refresh and confirm the current Origin run.' };
      const first = await control('[KEYSTROKE]Escape', target, config.zylosDir);
      if (action === 'interrupt' || !first.ok) return { ...first, steps: [first], message: first.ok ? 'Interrupt submitted; delivery is pending.' : first.unknown ? 'Submission result unknown. Do not retry automatically.' : 'Control rejected.' };
      await sleep(500);
      const second = await control('continue', target, config.zylosDir);
      return { ...second, steps: [first, second], message: second.ok ? 'Both controls submitted; delivery and recovery are not confirmed.' : second.targetChanged ? 'Origin changed; the second control was not submitted. Refresh the current run.' : 'Second submission result unknown. Do not retry automatically.' };
    }
    if (action === 'restart-session') {
      const { submit, lookupRestartRequest } = await load('am-sock-client.js');
      const requestId = crypto.randomUUID();
      const deadlineAt = now() + 10000;
      const request = { version: 1, type: 'manual_restart', requestId, ...(target.runId ? { expectedRunId: target.runId } : {}), ...(target.sessionId ? { expectedSessionId: target.sessionId } : {}) };
      const result = await submit(request, { deadlineAt });
      if (result.kind === 'accepted' || result.kind === 'rejected') return { ok: result.kind === 'accepted', requestId, submission: result.kind, ...result.reply, message: `Restart ${result.reply.result || result.reply.code || result.reply.reason}; old-run completion and new Origin readiness are separate.` };
      const notSubmitted = result.kind === 'connect_failed' || (result.kind === 'deadline_exceeded' && !result.sent);
      let completion = 'unknown';
      if (!notSubmitted) { try { completion = await lookupRestartRequest(requestId, { deadlineAt }); } catch {} }
      return { ok: false, requestId, submission: notSubmitted ? 'not_submitted' : 'unknown', completion, error: result.kind, message: notSubmitted ? 'Restart was not submitted.' : 'Restart result unknown; no automatic retry.' };
    }
    if (action === 'switch-mode') {
      if (!['single', 'multi'].includes(body?.mode)) return { ok: false, error: 'INVALID_MODE' };
      return command('zylos', ['session-mode', 'switch', body.mode, '--json']);
    }
    if (action === 'switch-runtime') {
      if (!['claude', 'codex'].includes(body?.runtime)) return { ok: false, error: 'INVALID_RUNTIME' };
      const result = await command('zylos', ['runtime', body.runtime, '--json']);
      return { ...result, message: result.ok ? 'Runtime configuration saved. Inspect current Origin state for actual runtime.' : 'Runtime command returned an error or unknown result; inspect current configuration.' };
    }
    return { ok: false, error: 'UNKNOWN_ACTION' };
  };
}
export const handleCoreAction = createCoreActions();
