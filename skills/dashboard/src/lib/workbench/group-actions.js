import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { loadCoreModule as defaultLoadCoreModule } from '../core-modules.js';
import { handleCoreAction as defaultHandleCoreAction } from '../core-actions.js';
import { parseSessionGroup } from '../../../../comm-bridge/scripts/c4-session-group.js';

function parse(text) {
  try {
    const value = JSON.parse(text);
    return typeof value?.ok === 'boolean' ? value : null;
  } catch { return null; }
}
const invalid = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const uncertain = message => ({ ok: false, unknown: true, error: { code: 'RESULT_UNKNOWN', message } });

/** Submit a snapshot-bound operation once; admission remains owned by Core. */
export function createGroupActions({ zylosDir, config = { zylosDir },
  loadCoreModule = defaultLoadCoreModule, handleCoreAction = defaultHandleCoreAction,
  execute = promisify(execFile), env = process.env, now = Date.now,
  sleep = setTimeout, uuid = crypto.randomUUID } = {}) {
  const childEnv = { ...env, ZYLOS_DIR: zylosDir };
  delete childEnv.ZYLOS_SESSION_GROUP;
  async function control(content, target) {
    const script = path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');
    const argv = [script, 'enqueue', '--content', content, '--priority', '0', '--bypass-state',
      '--no-ack-suffix', '--group', target.sessionGroup, '--target-run', target.runId,
      ...(target.sessionId ? ['--expected-session', target.sessionId] : []), '--json'];
    let reply;
    try {
      const { stdout } = await execute(process.execPath, argv,
        { env: childEnv, timeout: 15000, maxBuffer: 1024 * 1024 });
      reply = parse(stdout) ?? uncertain('Core returned no result envelope');
    } catch (error) {
      reply = parse(error.stdout) ?? uncertain(error.message ?? 'Core command failed');
    }
    if (reply.ok && !Number.isSafeInteger(reply.data?.id)) reply = uncertain('Core returned no control identifier');
    return { ...reply, controlId: reply.data?.id ?? null,
      submission: reply.ok ? 'submitted' : reply.unknown ? 'unknown' : 'rejected',
      rejectionCode: reply.error?.code ?? null,
      currentRunId: reply.error?.runId ?? null };
  }
  return async function groupAction(key, action, body = {}) {
    if (!['interrupt', 'chop-chop', 'restart'].includes(action)) throw invalid('UNKNOWN_ACTION', 'Unknown group action');
    if (!parseSessionGroup(key)) throw invalid('SESSION_GROUP_INVALID', 'Invalid session group');
    if (key === 'origin') return handleCoreAction(action === 'restart' ? 'restart-session' : action, body, config);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('INVALID_ARGUMENT', 'A target object is required');
    if (body.sessionId !== undefined && body.sessionId !== null &&
        (typeof body.sessionId !== 'string' || !body.sessionId)) throw invalid('INVALID_ARGUMENT', 'Invalid session target');
    const coreConfig = await loadCoreModule('config.js');
    if (coreConfig.readSessionMode().mode !== 'multi') throw invalid('not_multi', 'Group actions require multi mode', 409);
    if (typeof body.runId !== 'string' || !body.runId) throw invalid('TARGET_REQUIRED', 'Refresh and confirm the current group run');
    const target = { sessionGroup: key, runId: body.runId, sessionId: body.sessionId ?? null };
    if (action !== 'restart') {
      const first = { ...await control('[KEYSTROKE]Escape', target), control: 'escape' };
      if (action === 'interrupt' || !first.ok) return { ...first, steps: [first] };
      await sleep(500);
      const second = { ...await control('continue', target), control: 'continue' };
      return { ...second, steps: [first, second] };
    }
    if (coreConfig.ZYLOS_DIR && path.resolve(coreConfig.ZYLOS_DIR) !== path.resolve(zylosDir)) {
      return { ...uncertain('Core instance root does not match this Dashboard'), submission: 'not_submitted' };
    }
    const { submit, lookupRestartRequest } = await loadCoreModule('am-sock-client.js');
    const requestId = uuid(), deadlineAt = now() + 10000;
    const request = { version: 1, type: 'manual_restart', requestId, sessionGroup: key,
      expectedRunId: target.runId, ...(target.sessionId ? { expectedSessionId: target.sessionId } : {}) };
    let result;
    try { result = await submit(request, { deadlineAt, socketPath: path.join(zylosDir, 'activity-monitor', 'am.sock') }); }
    catch (error) { return { ...uncertain(error.message ?? 'Supervisor reply unavailable'), requestId, submission: 'unknown' }; }
    if (result.kind === 'accepted' || result.kind === 'rejected') {
      return { ...result.reply, ok: result.kind === 'accepted', requestId, submission: result.kind };
    }
    const notSubmitted = result.kind === 'connect_failed' || (result.kind === 'deadline_exceeded' && !result.sent);
    let completion = 'unknown';
    if (!notSubmitted) {
      try { completion = await lookupRestartRequest(requestId, { deadlineAt }); }
      catch { completion = 'unknown'; }
    }
    if (completion === 'deadline_exceeded') completion = 'unknown';
    return { ok: false, requestId, submission: notSubmitted ? 'not_submitted' : 'unknown',
      completion, unknown: !notSubmitted, error: result.kind };
  };
}
