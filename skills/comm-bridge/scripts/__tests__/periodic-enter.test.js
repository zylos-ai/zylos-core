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

test('disabled and startup never send; exact interval is inclusive', async () => {
  const off = fixture(false);
  off.timer.arm(1, 'conversation');
  off.advance(60000);
  await off.tick();
  assert.equal(off.count(), 0);
  const f = fixture();
  f.advance(60000);
  await f.tick();
  assert.equal(f.count(), 0);
  f.timer.arm(1, 'conversation');
  f.advance(59999);
  await f.tick();
  assert.equal(f.count(), 0);
  f.advance(1);
  await f.tick();
  assert.equal(f.count(), 1);
});

test('a new paste keeps an earlier pending deadline but gets a fresh three-attempt budget (#795)', async () => {
  const f = fixture();
  f.timer.arm(1, 'conversation');
  f.advance(40000);
  f.timer.arm(2, 'conversation');
  assert.equal(f.events.at(-1).carriedFrom, 1);
  f.advance(20000);
  await f.tick();
  assert.equal(f.count(), 1, 'deadline counts from the first paste, not the second');
  assert.equal(f.timer.pending.itemId, 2);
  for (let i = 0; i < 5; i++) { f.advance(60000); await f.tick(); }
  assert.equal(f.count(), 3);
  assert.equal(f.events.filter(e => e.event === 'periodic_exhausted').length, 1);
  f.timer.arm(3, 'control');
  assert.equal(f.events.at(-1).carriedFrom, undefined, 'an exhausted budget is not carried');
  f.advance(59999);
  await f.tick();
  assert.equal(f.count(), 3);
  f.advance(1);
  await f.tick();
  assert.equal(f.count(), 4);
});

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

test('failed attempts rate limit and exhaust; shutdown defers', async () => {
  const f = fixture();
  f.timer.arm(1, 'conversation');
  f.advance(60000);
  await f.tick({ eligible: false });
  assert.equal(f.count(), 0);
  for (let i = 0; i < 5; i++) {
    await f.tick({ send: async () => { throw new Error('private payload'); } });
    await f.tick();
    f.advance(60000);
  }
  assert.equal(f.count(), 0);
  assert.equal(f.events.filter(e => e.event === 'periodic_failed').length, 3);
  assert.equal(JSON.stringify(f.events).includes('private payload'), false);
});

test('tick awaits send completion and logs the original message', async () => {
  const f = fixture();
  f.timer.arm(42, 'control');
  f.advance(60000);
  let release;
  const pending = f.tick({ send: () => new Promise(resolve => { release = resolve; }) });
  assert.equal(f.events.some(e => e.event === 'periodic_sent'), false);
  release();
  await pending;
  const event = f.events.find(e => e.event === 'periodic_sent');
  assert.equal(event.itemId, 42);
  assert.equal(event.itemType, 'control');
  assert.equal('pane' in event, false);
});

test('temporary ineligibility preserves remaining attempt budget', async () => {
  const f = fixture();
  f.timer.arm(42, 'conversation');
  f.advance(60000);
  await f.tick();
  for (let i = 0; i < 3; i++) {
    f.advance(60000);
    await f.tick({ eligible: false });
  }
  assert.equal(f.timer.pending.attempts, 1);
  await f.tick();
  f.advance(60000);
  await f.tick();
  f.advance(60000);
  await f.tick();
  assert.equal(f.count(), 3);
  assert.equal(f.timer.pending.itemId, 42);
});
