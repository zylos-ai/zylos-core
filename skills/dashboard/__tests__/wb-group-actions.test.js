import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupActions } from '../src/lib/workbench/group-actions.js';
import * as sessionNudge from '../../../cli/lib/session-nudge.js';

function fixture({ results = [{ ok: true, data: { id: 1 } }], mode = 'multi', reply = { kind: 'accepted', reply: { result: 'accepted' } }, completion = 'accepted', coreRoot } = {}) {
  let clock = 1000;
  const calls = [], sleeps = [], submissions = [], lookups = [], origin = [], interrupts = [];
  const config = { zylosDir: '/isolated/instance', extra: 'retained' };
  const action = createGroupActions({ zylosDir: config.zylosDir, config,
    env: { HOME: '/isolated/home', ZYLOS_SESSION_GROUP: 'wrong-group', RETAIN: 'yes' },
    now: () => clock, uuid: () => 'request-fixture', onInterrupt: record => interrupts.push(record),
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    handleCoreAction: async (...args) => { origin.push(args); return { ok: true, messageKey: 'existing_core_reply' }; },
    loadCoreModule: async name => {
      if (name === 'config.js') return { readSessionMode: () => ({ mode }), ZYLOS_DIR: coreRoot };
      if (name === 'session-nudge.js') return sessionNudge;
      assert.equal(name, 'am-sock-client.js');
      return { submit: async (...args) => { submissions.push(args); return reply; },
        lookupRestartRequest: async (...args) => { lookups.push(args); return completion; } };
    },
    execute: async (file, argv, options) => {
      calls.push({ file, argv, options, at: clock });
      const result = results[calls.length - 1] ?? results[results.length - 1];
      if (result instanceof Error) throw result;
      return { stdout: typeof result === 'string' ? result : JSON.stringify(result) };
    } });
  return { action, calls, sleeps, submissions, lookups, origin, config, interrupts };
}
const target = { runId: 'snapshot-run', sessionId: 'snapshot-session' };

test('ordinary group adapter takes scope only from the path and preserves the confirmed private run', async () => {
  const f = fixture();
  const body = Object.freeze({ sessionGroup: 'telegram:foreign', runId: 'private-selected-run', sessionId: 'private-selected-session' });
  await f.action('telegram:selected', 'interrupt', body);
  const args = f.calls[0].argv;
  assert.equal(args[args.indexOf('--group') + 1], 'telegram:selected');
  assert.equal(args[args.indexOf('--target-run') + 1], 'private-selected-run');
  assert.equal(args[args.indexOf('--expected-session') + 1], 'private-selected-session');
  assert.equal(args.includes('telegram:foreign'), false);
  assert.equal(f.origin.length, 0, 'ordinary controls never reach the Origin adapter');
  assert.deepEqual(f.interrupts.map(record => [record.sessionGroup, record.runId, record.sessionId]),
    [['telegram:selected', 'private-selected-run', 'private-selected-session']]);
  assert.equal(body.sessionGroup, 'telegram:foreign');
});

for (const reply of [
  { kind: 'accepted', reply: { result: 'accepted' } },
  { kind: 'accepted', reply: { result: 'already_stopped' } },
  { kind: 'rejected', reply: { result: 'stale_target', currentRunId: 'current-run' } },
  { kind: 'rejected', reply: { result: 'rejected', reason: 'identity_unavailable' } },
]) test(`restart preserves ${reply.reply.result} and sends only the selected target`, async () => {
  const f = fixture({ reply }); const result = await f.action('telegram:A', 'restart', target);
  assert.equal(result.submission, reply.kind); assert.equal(result.result, reply.reply.result);
  assert.equal(result.currentRunId, reply.reply.currentRunId); assert.equal(result.reason, reply.reply.reason);
  assert.equal(f.submissions.length, 1); assert.equal(f.lookups.length, 0); assert.equal(f.calls.length, 0);
  assert.deepEqual(f.submissions[0][0], { version: 1, type: 'manual_restart', requestId: 'request-fixture',
    sessionGroup: 'telegram:A', expectedRunId: target.runId, expectedSessionId: target.sessionId });
  assert.deepEqual(f.submissions[0][1], { deadlineAt: 11000, socketPath: '/isolated/instance/activity-monitor/am.sock' });
});

test('an instance root mismatch is definitely not submitted and never contacts the supervisor', async () => {
  const f = fixture({ coreRoot: '/isolated/another-instance' });
  const result = await f.action('telegram:A', 'restart', target);
  assert.equal(result.ok, false);
  assert.equal(result.submission, 'not_submitted');
  assert.notEqual(result.unknown, true);
  assert.equal(result.error.code, 'INSTANCE_ROOT_MISMATCH');
  assert.equal(f.submissions.length, 0);
  assert.equal(f.lookups.length, 0);
});
