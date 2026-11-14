import test from 'node:test';
import assert from 'node:assert/strict';
import { nudgeSession } from '../session-nudge.js';

test('nudge waits for Escape admission and the full delay before enqueueing exact continue', async () => {
  const events = [];
  let admitEscape, finishDelay;
  const escape = Object.freeze({ ok: true, controlId: 7, submission: 'submitted' });
  const continued = Object.freeze({ ok: true, controlId: 8, submission: 'submitted' });
  const resultPromise = nudgeSession({
    enqueue: content => {
      events.push(content);
      return content === '[KEYSTROKE]Escape'
        ? new Promise(resolve => { admitEscape = () => resolve(escape); }) : continued;
    },
    delay: milliseconds => {
      events.push(milliseconds);
      return new Promise(resolve => { finishDelay = resolve; });
    },
  });
  assert.deepEqual(events, ['[KEYSTROKE]Escape']);
  admitEscape();
  await Promise.resolve();
  assert.deepEqual(events, ['[KEYSTROKE]Escape', 500]);
  finishDelay();
  const result = await resultPromise;
  assert.deepEqual(events, ['[KEYSTROKE]Escape', 500, 'continue']);
  assert.deepEqual(result, { ...continued, control: 'continue', steps: [
    { ...escape, control: 'escape' }, { ...continued, control: 'continue' },
  ] });
});

for (const failed of [
  { ok: false, error: { code: 'TARGET_CHANGED', runId: 'replacement' }, submission: 'rejected' },
  { ok: false, unknown: true, error: { code: 'RESULT_UNKNOWN' }, submission: 'unknown' },
]) test(`Escape ${failed.submission} stops without delay or retries and preserves its envelope`, async () => {
  const calls = [];
  const result = await nudgeSession({ enqueue: async content => { calls.push(content); return failed; },
    delay: async () => assert.fail('failed Escape must not wait') });
  assert.deepEqual(calls, ['[KEYSTROKE]Escape']);
  assert.deepEqual(result, { ...failed, control: 'escape', steps: [{ ...failed, control: 'escape' }] });
});

test('continue rejection preserves partial success and raw target details without retrying', async () => {
  const calls = [];
  const first = { ok: true, data: { id: 1 } };
  const failure = { ok: false, error: { code: 'TARGET_CHANGED', runId: 'new-run' }, targetChanged: true };
  const result = await nudgeSession({ enqueue: async content => { calls.push(content); return calls.length === 1 ? first : failure; }, delay: async () => {} });
  assert.deepEqual(calls, ['[KEYSTROKE]Escape', 'continue']);
  assert.deepEqual(result, { ...failure, control: 'continue', steps: [
    { ...first, control: 'escape' }, { ...failure, control: 'continue' },
  ] });
});

test('enqueue exceptions propagate without attempting another insertion', async () => {
  const error = new Error('queue unavailable');
  let calls = 0;
  await assert.rejects(nudgeSession({ enqueue: async () => { calls++; throw error; },
    delay: async () => assert.fail('throwing Escape must not wait') }), error);
  assert.equal(calls, 1);
});
