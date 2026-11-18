import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSessionMode, sessionModeCommand } from '../../commands/session-mode.js';

const pinned = { run_id: 'transition-1', kind: 'switch', phase: 'gating' };
const forbidden = () => assert.fail('unexpected operation');
for (const args of [['cancel', 'extra'], ['cancel', '--json', '--json']]) {
  test(`cancel validates before reading: ${JSON.stringify(args)}`, async () => {
    assert.equal((await executeSessionMode(args, { readTransition: forbidden, send: forbidden })).error.code, 'INVALID_ARGUMENT');
  });
}
test('no open transition never contacts supervisor and prints exact JSON with exit 1', async t => {
  const prior = process.exitCode; t.after(() => { process.exitCode = prior; });
  const lines = []; t.mock.method(console, 'log', line => lines.push(line));
  await sessionModeCommand(['cancel', '--json'], { readTransition: () => null, send: forbidden, lookupCancel: forbidden });
  assert.equal(process.exitCode, 1);
  assert.deepEqual(lines, ['{"ok":false,"code":"run_not_open"}']);
});
test('no open transition prints required text without contacting supervisor', async t => {
  const prior = process.exitCode; t.after(() => { process.exitCode = prior; });
  const lines = []; t.mock.method(console, 'error', line => lines.push(line));
  await sessionModeCommand(['cancel'], { readTransition: () => null, send: forbidden });
  assert.deepEqual(lines, ['没有进行中的切换']); assert.equal(process.exitCode, 1);
});
test('transition read failure is never treated as no open transition', async () => {
  const result = await executeSessionMode(['cancel'], { readTransition: () => { throw Object.assign(new Error('busy'), { code: 'DB_BUSY' }); }, send: forbidden });
  assert.equal(result.error.code, 'DB_BUSY'); assert.deepEqual(result.error.persisted, []);
});
test('cancel pins run, submits once, and reports committed cancellation', async () => {
  const calls = [];
  const result = await executeSessionMode(['cancel'], { readTransition: () => pinned, now: () => 1000, requestId: () => 'request-1',
    send: async (request, options) => { calls.push({ request, options }); return { kind: 'accepted', sent: true, reply: { result: 'cancelled', runId: pinned.run_id } }; }, lookupCancel: forbidden });
  assert.deepEqual(calls, [{ request: { version: 1, type: 'mode_switch_cancel', requestId: 'request-1', runId: pinned.run_id }, options: { deadlineAt: 11000 } }]);
  assert.deepEqual(result, { ok: true, data: { result: 'cancelled', runId: pinned.run_id } });
});
test('cancel rejection never retries', async () => {
  const code = 'not_cancellable';
  const result = await executeSessionMode(['cancel'], { readTransition: () => pinned,
    send: () => ({ kind: 'rejected', sent: true, reply: { code } }), lookupCancel: forbidden });
  assert.equal(result.error.code, code); assert.deepEqual(result.error.persisted, []);
});
test('unsent cancel never looks up', async () => {
  const kind = 'connect_failed';
  const result = await executeSessionMode(['cancel'], { readTransition: () => pinned, send: () => ({ kind, sent: false }), lookupCancel: forbidden });
  assert.equal(result.error.code, kind); assert.deepEqual(result.error.persisted, []);
});
// Cover each result branch once, plus send-exception normalization. Generic
// transport classifications share the same uncertain-cancel observation path.
for (const [kind, observed] of [
  ['no_reply', 'cancelled'], ['no_reply', 'unknown'],
  ['no_reply', 'throw'], ['throw', 'cancelled'],
]) test(`uncertain cancel ${kind} observes ${observed} once within original deadline`, async () => {
    let sends = 0, reads = 0;
    const result = await executeSessionMode(['cancel'], { readTransition: () => pinned, deadlineAt: 12345,
      send: (request, options) => { sends++; assert.equal(options.deadlineAt, 12345); if (kind === 'throw') throw new Error('lost'); return { kind, sent: true }; },
      lookupCancel: (runId, options) => { reads++; assert.equal(runId, pinned.run_id); assert.equal(options.deadlineAt, 12345); if (observed === 'throw') throw new Error('busy'); return observed; } });
    assert.equal(sends, 1); assert.equal(reads, 1); assert.equal(result.ok, observed === 'cancelled');
    if (!result.ok) assert.equal(result.error.persisted, null);
  });
