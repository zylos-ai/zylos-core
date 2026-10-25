import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { submit, validateReply } from '../am-sock-client.js';

const envelope = type => ({ version: 1, type, requestId: 'fields' });
const good = {
  restart_all: [
    { ok: true, result: 'accepted', runCount: 1 }, { ok: true, result: 'already_accepted', runCount: 2 }, { ok: true, result: 'done_empty', runCount: 0 },
    ...['single_mode', 'manual_restart_pending', 'requests_unreadable', 'request_conflict'].map(code => ({ ok: false, code })),
  ],
  ready_for_config_reclaim: [
    ...['accepted', 'already_accepted', 'unchanged'].map(result => ({ ok: true, result })),
    ...['not_multi', 'transition_open', 'run_changed', 'not_ready', 'snapshot_unavailable', 'other_fence', 'manual_restart_pending'].map(reason => ({ ok: false, result: 'rejected', reason })),
  ],
  manual_restart: [
    ...['accepted', 'already_accepted', 'already_stopped'].map(result => ({ ok: true, result })),
    { ok: false, result: 'stale_target', currentRunId: 'new-run' },
    ...['target_required', 'transition_open', 'restart_all_pending', 'fence_conflict', 'manual_restart_pending', 'identity_unavailable', 'not_ready', 'requests_unreadable', 'request_conflict'].map(reason => ({ ok: false, result: 'rejected', reason })),
  ],
  mode_switch: [
    { ok: true, result: 'noop' }, { ok: true, result: 'accepted', runId: 'switch-run' },
    { ok: false, code: 'transition_open', runId: 'switch-run', target: 'multi' },
    ...['config_unreadable', 'legacy_session_present', 'manual_restart_pending', 'requests_unreadable'].map(code => ({ ok: false, code })),
  ],
  start_attempt: [
    { ok: true, result: 'not_restricted' },
    { ok: true, result: 'registered', reason: 'recovery_due', attemptAt: 1792000000, attemptCount: 1 },
    { ok: true, result: 'registered', reason: 'user_message', attemptAt: 1792000000 },
    ...['rate_limit_cooldown', 'probe_cache', 'attempt_backoff', 'down_retry_interval'].map(code => ({ ok: false, code, notBefore: 1792000010000 })),
    ...['invalid_request', 'auth_blocked', 'scene_present', 'probe_inflight', 'health_write_failed'].map(code => ({ ok: false, code })),
  ],
};
async function transport(type, fields) {
  const response = { ...envelope(type), ...fields };
  return submit(envelope(type), { connect: () => {
    const socket = new EventEmitter(); socket.destroy = () => {};
    socket.write = (_, done) => { done(); queueMicrotask(() => { socket.emit('data', Buffer.from(JSON.stringify(response) + '\n')); socket.emit('end'); }); };
    queueMicrotask(() => socket.emit('connect')); return socket;
  } });
}
test('IF-37 complete legal branch inventory, unknown extensions and every branch required field', async () => {
  for (const [type, branches] of Object.entries(good)) {
    for (const fields of branches) {
      const reply = { ...envelope(type), ...fields };
      assert.equal(validateReply(envelope(type), reply), true, JSON.stringify(reply));
      const extended = { ...reply, futureExtension: { nested: 1 } };
      assert.equal(validateReply(envelope(type), extended), true);
      const result = await transport(type, extended); assert.equal(result.kind, fields.ok ? 'accepted' : 'rejected'); assert.equal(result.sent, true);
      assert.deepEqual(result.reply, extended);
      for (const key of Object.keys(reply)) {
        // attemptCount is absent for down; all other present fields in these
        // branch-minimal fixtures are mandatory.
        if (key === 'attemptCount') continue;
        const missing = { ...reply }; delete missing[key];
        assert.equal(validateReply(envelope(type), missing), false, `${type} missing ${key}: ${JSON.stringify(fields)}`);
      }
    }
    if (type !== 'start_attempt') {
      const result = await transport(type, { ok: false, code: 'entry_not_open' });
      assert.equal(result.kind, 'rejected'); assert.equal(result.sent, true);
    }
  }
});
test('IF-37 literal invalid reason/code, incompatible ok/result and field relationships are uncertain replies', async () => {
  const cases = [
    ['restart_all', { ok: true, result: 'unknown_result', runCount: 0 }],
    ['manual_restart', { ok: false, result: 'rejected', reason: 'unknown_reason' }],
    ['mode_switch', { ok: false, code: 'unknown_code' }],
    ['ready_for_config_reclaim', { ok: true, result: 'rejected', reason: 'not_multi' }],
    ['manual_restart', { ok: false, result: 'accepted' }],
    ['restart_all', { ok: true, result: 'done_empty', runCount: 2 }],
    ['restart_all', { ok: true, result: 'accepted', runCount: 0 }],
    ['manual_restart', { ok: false, result: 'stale_target' }],
    ['mode_switch', { ok: false, code: 'transition_open', runId: 'switch', target: 'other' }],
    ['start_attempt', { ok: true, result: 'registered', reason: 'recovery_due', attemptCount: 1 }],
    ['start_attempt', { ok: true, result: 'registered', reason: 'recovery_due', attemptAt: 1792000000000, attemptCount: 1 }],
    ['start_attempt', { ok: true, result: 'registered', reason: 'recovery_due', attemptAt: 1792000000, attemptCount: '1' }],
    ['start_attempt', { ok: true, result: 'not_restricted', attemptAt: 1792000000 }],
    ['start_attempt', { ok: false, code: 'attempt_backoff' }],
    ['start_attempt', { ok: false, code: 'attempt_backoff', notBefore: 1792000000 }],
    ['start_attempt', { ok: false, code: 'unknown_code' }],
  ];
  for (const [type, fields] of cases) assert.deepEqual(await transport(type, fields), { kind: 'invalid_reply', sent: true }, `${type}: ${JSON.stringify(fields)}`);
});
