import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { supervisorDiagnosticPath } from './session-group-paths.js';
import { EventLogReader } from './event-log.js';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ZYLOS_DIR, readSessionMode } from './config.js';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonempty = x => typeof x === 'string' && x.length > 0;
const integer = Number.isSafeInteger;
const oneOf = (x, values) => values.includes(x);
const absent = (x, keys) => keys.every(k => !Object.hasOwn(x, k));
const publicCodes = ['invalid_request', 'entry_not_open'];
const configReasons = ['not_multi', 'transition_open', 'run_changed', 'not_ready', 'snapshot_unavailable', 'other_fence', 'manual_restart_pending'];
const manualReasons = ['target_required', 'transition_open', 'restart_all_pending', 'fence_conflict', 'manual_restart_pending', 'identity_unavailable', 'not_ready', 'requests_unreadable', 'request_conflict'];

/** Validate the first reply line, including branch relationships rather than types alone. */
export function validateReply(request, reply) {
  if (!object(reply)) return false;
  if (reply.ok === false && reply.code === 'invalid_request'
      && !Object.hasOwn(reply, 'type') && !Object.hasOwn(reply, 'requestId')) return true;
  if (reply.version !== 1 || reply.type !== request.type || reply.requestId !== request.requestId || typeof reply.ok !== 'boolean') return false;
  if (request.type === 'start_attempt') {
    if (reply.ok) {
      if (reply.result === 'not_restricted') return absent(reply, ['reason', 'code', 'notBefore']);
      return reply.result === 'registered' && oneOf(reply.reason, ['user_message', 'recovery_due'])
        && absent(reply, ['code', 'notBefore']);
    }
    if (!absent(reply, ['result', 'reason'])) return false;
    if (oneOf(reply.code, ['rate_limit_cooldown', 'probe_cache', 'attempt_backoff', 'down_retry_interval'])) return integer(reply.notBefore) && reply.notBefore >= 1e12;
    return oneOf(reply.code, ['invalid_request', 'auth_blocked', 'scene_present', 'probe_inflight', 'health_write_failed']) && absent(reply, ['notBefore']);
  }
  if (!reply.ok && publicCodes.includes(reply.code)) return true;
  switch (request.type) {
    case 'restart_all':
      return reply.ok
        ? oneOf(reply.result, ['accepted', 'already_accepted', 'done_empty']) && integer(reply.runCount)
          && (reply.result === 'done_empty' ? reply.runCount === 0 : reply.runCount >= 1)
        : oneOf(reply.code, ['single_mode', 'manual_restart_pending', 'requests_unreadable', 'request_conflict']);
    case 'ready_for_config_reclaim':
      return reply.ok ? oneOf(reply.result, ['accepted', 'already_accepted', 'unchanged'])
        : reply.result === 'rejected' && oneOf(reply.reason, configReasons);
    case 'manual_restart':
      return reply.ok ? oneOf(reply.result, ['accepted', 'already_accepted', 'already_stopped'])
        : (reply.result === 'stale_target' && nonempty(reply.currentRunId)) || (reply.result === 'rejected' && oneOf(reply.reason, manualReasons));
    case 'mode_switch':
      return reply.ok ? reply.result === 'noop' || (reply.result === 'accepted' && nonempty(reply.runId))
        : (reply.code === 'transition_open' && nonempty(reply.runId) && oneOf(reply.target, ['single', 'multi']))
          || oneOf(reply.code, ['config_unreadable', 'legacy_session_present', 'manual_restart_pending', 'requests_unreadable']);
    default: return false;
  }
}

/** A connected failure is always uncertain, even if write completion was not observed. */
export function submit(request, { deadlineAt, replyMaxMs = 10000, connectRetryEveryMs,
  socketPath = path.join(ZYLOS_DIR, 'activity-monitor', 'am.sock'),
  connect = options => net.createConnection(options), now = (() => { const wall = Date.now(); const mono = performance.now(); return () => wall + performance.now() - mono; })(),
} = {}) {
  if (!object(request) || !oneOf(request.type, ['start_attempt', 'restart_all', 'ready_for_config_reclaim', 'manual_restart', 'mode_switch'])) throw new TypeError('Unsupported supervisor request');
  if (!Number.isFinite(replyMaxMs) || replyMaxMs <= 0 || (deadlineAt !== undefined && !integer(deadlineAt))
      || (connectRetryEveryMs !== undefined && (!Number.isFinite(connectRetryEveryMs) || connectRetryEveryMs <= 0))) throw new TypeError('Invalid supervisor deadline');
  const deadline = deadlineAt ?? now() + replyMaxMs;
  const line = `${JSON.stringify(request)}\n`;
  return new Promise(resolve => {
    let socket, timer, retryTimer, done = false, sent = false, lastErrno, buffer = '';
    const finish = (kind, reply) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(retryTimer); socket?.destroy();
      resolve({ kind, ...(reply ? { reply } : {}), sent });
    };
    const arm = (at, kind) => { clearTimeout(timer); timer = setTimeout(() => finish(kind), Math.max(0, at - now())); };
    const failedConnect = error => {
      if (done) return;
      if (sent) return finish('no_reply');
      if (error?.code) lastErrno = error.code;
      socket?.destroy();
      if (connectRetryEveryMs === undefined || now() + connectRetryEveryMs >= deadline) return finish(lastErrno ? 'connect_failed' : 'deadline_exceeded');
      retryTimer = setTimeout(attempt, connectRetryEveryMs);
    };
    const attempt = () => {
      if (done) return;
      if (now() >= deadline) return finish(lastErrno ? 'connect_failed' : 'deadline_exceeded');
      try { socket = connect({ path: socketPath }); } catch (error) { failedConnect(error); return; }
      const current = socket; const decoder = new StringDecoder('utf8'); let connectFailed = false;
      const failOnce = error => { if (connectFailed) return; connectFailed = true; failedConnect(error); };
      current.once('connect', () => {
        if (done || current !== socket) return;
        sent = true;
        try {
          current.write(line, error => {
            if (done) return;
            if (error) return finish('no_reply');
            const replyDeadline = now() + replyMaxMs;
            arm(Math.min(deadline, replyDeadline), replyDeadline <= deadline ? 'timeout' : 'deadline_exceeded');
          });
        } catch { finish('no_reply'); }
      });
      current.on('data', chunk => {
        if (done || current !== socket) return;
        buffer += decoder.write(chunk);
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        let reply;
        try { reply = JSON.parse(buffer.slice(0, end)); } catch { return finish('invalid_reply'); }
        if (!validateReply(request, reply)) return finish('invalid_reply');
        finish(reply.ok ? 'accepted' : 'rejected', reply);
      });
      current.once('error', error => { if (current === socket) failOnce(error); });
      current.once('end', () => { if (current === socket && !done) sent ? finish('no_reply') : failOnce(); });
      current.once('close', hadError => { if (current === socket && !done && !hadError) sent ? finish('no_reply') : failOnce(); });
    };
    if (now() >= deadline) return finish('deadline_exceeded');
    timer = setTimeout(() => finish(!sent && lastErrno ? 'connect_failed' : 'deadline_exceeded'), Math.max(0, deadline - now()));
    attempt();
  });
}

export async function lookupRestartRequest(requestId, { deadlineAt, now = Date.now, readRequests, readCompleted } = {}) {
  if (now() >= deadlineAt) return 'deadline_exceeded';
  if (!readRequests) {
    const { RestartRequestStore } = await import('../../skills/activity-monitor/scripts/restart-request-store.js');
    readRequests = () => new RestartRequestStore().read();
  }
  if (now() >= deadlineAt) return 'deadline_exceeded';
  if ((await readRequests()).some(row => row.requestId === requestId)) return 'accepted';
  if (now() >= deadlineAt) return 'deadline_exceeded';
  if (!readCompleted) readCompleted = id => {
    const reader = new EventLogReader(supervisorDiagnosticPath());
    try { return reader.read().some(row => row.requestId === id && ['restart_done', 'manual_restart_done'].includes(row.event)); }
    finally { reader.close(); }
  };
  return await readCompleted(requestId) ? 'done' : 'unknown';
}

export async function lookupModeSwitch(target, { deadlineAt, now = Date.now, getModeTransition, readMode = readSessionMode } = {}) {
  if (now() >= deadlineAt) return 'deadline_exceeded';
  if (!getModeTransition) {
    ({ getModeTransition } = await import('../../skills/comm-bridge/scripts/c4-db.js'));
  }
  if (now() >= deadlineAt) return 'deadline_exceeded';
  const transition = await getModeTransition(); // The shared DB reader uses its ordinary lock budget.
  if (transition && transition.target_mode === target) return 'accepted';
  if (now() >= deadlineAt) return 'deadline_exceeded';
  return (await readMode()).mode === target ? 'done' : 'unknown';
}
