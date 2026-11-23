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
