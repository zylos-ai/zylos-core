import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PeriodicEnter } from '../periodic-enter.js';

function fixture(enabled = true) {
  let time = 0;
  let sends = 0;
  const events = [];
  const timer = new PeriodicEnter({ enabled, now: () => time, emit: (event, metadata) => events.push({ event, ...metadata }) });
  return { timer, events, advance: ms => { time += ms; }, count: () => sends,
    tick: (overrides = {}) => timer.tick({ eligible: true, send: async () => { sends++; }, ...overrides }) };
}

test('frequent pastes cannot defer recovery indefinitely', async () => {
  const f = fixture();
  f.timer.arm(1, 'conversation');
  for (let id = 2; id <= 5; id++) {
    f.advance(30000);
    f.timer.arm(id, 'conversation');
    await f.tick();
  }
  assert.equal(f.count(), 2, 'attempts keep firing on the interval while pastes arrive every 30s');
});
