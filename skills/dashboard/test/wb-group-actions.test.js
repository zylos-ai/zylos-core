import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupActions } from '../src/lib/workbench/group-actions.js';

function fixture({ results = [{ ok: true, data: { id: 1 } }], mode = 'multi', reply = { kind: 'accepted', reply: { result: 'accepted' } }, completion = 'accepted' } = {}) {
  let clock = 1000;
  const calls = [], sleeps = [], submissions = [], lookups = [], origin = [];
  const config = { zylosDir: '/isolated/instance', extra: 'retained' };
  const action = createGroupActions({ zylosDir: config.zylosDir, config,
    env: { HOME: '/isolated/home', ZYLOS_SESSION_GROUP: 'wrong-group', RETAIN: 'yes' },
    now: () => clock, uuid: () => 'request-fixture',
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    handleCoreAction: async (...args) => { origin.push(args); return { ok: true, messageKey: 'existing_core_reply' }; },
    loadCoreModule: async name => {
      if (name === 'config.js') return { readSessionMode: () => ({ mode }) };
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
  return { action, calls, sleeps, submissions, lookups, origin, config };
}
const target = { runId: 'snapshot-run', sessionId: 'snapshot-session' };

test('Origin actions reuse the existing handler with the same body and configuration', async () => {
  const f = fixture(), body = { ...target, sessionGroup: 'origin', extra: 'unchanged' };
  for (const [action, coreAction] of [['interrupt', 'interrupt'], ['chop-chop', 'chop-chop'], ['restart', 'restart-session']]) {
    assert.deepEqual(await f.action('origin', action, body), { ok: true, messageKey: 'existing_core_reply' });
    const call = f.origin.at(-1);
    assert.equal(call[0], coreAction); assert.equal(call[1], body); assert.equal(call[2], f.config);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.submissions.length, 0);
});

test('ordinary interruption binds the requested group and snapshot run/session instead of Origin', async () => {
  const f = fixture(); const result = await f.action('telegram:A', 'interrupt', target);
  assert.equal(result.submission, 'submitted'); assert.equal(result.controlId, 1);
  assert.equal(result.steps.length, 1); assert.equal(f.calls.length, 1);
  const { file, argv, options } = f.calls[0];
  assert.equal(file, process.execPath);
  assert.equal(argv[0], '/isolated/instance/.claude/skills/comm-bridge/scripts/c4-control.js');
  assert.deepEqual(argv.slice(1), ['enqueue', '--content', '[KEYSTROKE]Escape', '--priority', '0', '--bypass-state',
    '--no-ack-suffix', '--group', 'telegram:A', '--target-run', 'snapshot-run', '--expected-session', 'snapshot-session', '--json']);
  assert.equal(argv.includes('origin'), false);
  assert.equal(options.timeout, 15000); assert.equal(options.maxBuffer, 1024 * 1024);
  assert.equal(options.env.ZYLOS_DIR, '/isolated/instance');
  assert.equal(options.env.ZYLOS_SESSION_GROUP, undefined); assert.equal(options.env.RETAIN, 'yes');
});

test('nudge stops after the first rejection and preserves its raw target error', async () => {
  const failure = { ok: false, error: { code: 'TARGET_CHANGED', message: 'Original Core message', runId: 'new-run' } };
  const f = fixture({ results: [failure] });
  const result = await f.action('telegram:A', 'chop-chop', target);
  assert.equal(result.ok, false); assert.deepEqual(result.error, failure.error);
  assert.equal(result.rejectionCode, 'TARGET_CHANGED'); assert.equal(result.currentRunId, 'new-run');
  assert.equal(result.steps.length, 1); assert.equal(f.calls.length, 1); assert.equal(f.sleeps.length, 0);
});

test('nudge reports both bound commands with at least five hundred milliseconds between them', async () => {
  const f = fixture({ results: [{ ok: true, data: { id: 1 } }, { ok: true, data: { id: 2 } }] });
  const result = await f.action('telegram:A', 'chop-chop', target);
  assert.equal(result.ok, true); assert.equal(result.steps.length, 2);
  assert.deepEqual(result.steps.map(step => step.control), ['escape', 'continue']);
  assert.deepEqual(f.sleeps, [500]); assert.ok(f.calls[1].at - f.calls[0].at >= 500);
  assert.equal(f.calls[1].argv[f.calls[1].argv.indexOf('--content') + 1], 'continue');
  assert.equal(f.calls[1].argv[f.calls[1].argv.indexOf('--group') + 1], 'telegram:A');
  assert.equal(f.calls[1].argv[f.calls[1].argv.indexOf('--target-run') + 1], target.runId);
});

test('ordinary actions reject single mode and missing targets before writing', async () => {
  const single = fixture({ mode: 'single' });
  await assert.rejects(single.action('telegram:A', 'restart', target), { code: 'not_multi', statusCode: 409 });
  const multi = fixture();
  await assert.rejects(multi.action('telegram:A', 'interrupt', {}), { code: 'TARGET_REQUIRED', statusCode: 400 });
  await assert.rejects(multi.action('telegram:A', 'restart', {}), { code: 'TARGET_REQUIRED', statusCode: 400 });
  for (const body of [null, [], { ...target, sessionId: {} }, { ...target, sessionId: 1 }, { ...target, sessionId: '' }]) {
    await assert.rejects(multi.action('telegram:A', 'interrupt', body), { code: 'INVALID_ARGUMENT', statusCode: 400 });
  }
  assert.equal(single.calls.length + multi.calls.length, 0);
  assert.equal(single.submissions.length + multi.submissions.length, 0);
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

test('unknown control results never retry and nonzero Core errors retain their envelope', async () => {
  const timeout = fixture({ results: [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })] });
  const result = await timeout.action('telegram:A', 'interrupt', target);
  assert.equal(result.submission, 'unknown'); assert.equal(result.unknown, true); assert.equal(timeout.calls.length, 1);
  const failure = { ok: false, error: { code: 'SESSION_GROUP_INVALID', message: 'Original Core message' } };
  const rejected = fixture({ results: [Object.assign(new Error('nonzero'), { stdout: JSON.stringify(failure) })] });
  assert.deepEqual((await rejected.action('telegram:A', 'interrupt', target)).error, failure.error);
  assert.equal(rejected.calls.length, 1);
});

test('restart uncertainty reads back once while failed submission never reads back or resends', async () => {
  const f = fixture({ reply: { kind: 'no_reply', sent: true }, completion: 'deadline_exceeded' });
  const result = await f.action('telegram:A', 'restart', target);
  assert.equal(result.submission, 'unknown'); assert.equal(result.completion, 'unknown');
  assert.equal(f.submissions.length, 1); assert.equal(f.lookups.length, 1);
  assert.deepEqual(f.lookups[0], ['request-fixture', { deadlineAt: 11000 }]);
  for (const reply of [{ kind: 'connect_failed' }, { kind: 'deadline_exceeded', sent: false }]) {
    const stopped = fixture({ reply });
    assert.equal((await stopped.action('telegram:A', 'restart', target)).submission, 'not_submitted');
    assert.equal(stopped.submissions.length, 1); assert.equal(stopped.lookups.length, 0);
  }
});
