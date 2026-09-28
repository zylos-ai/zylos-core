import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PeriodicEnter } from '../periodic-enter.js';

function fixture(enabled = true) {
  let time = 0;
  let sends = 0;
  const events = [];
  const timer = new PeriodicEnter({ enabled, now: () => time, emit: (event) => events.push(event) });
  return { timer, events, advance: (ms) => { time += ms; }, count: () => sends,
    tick: (overrides = {}) => timer.tick({ identity: 'pane:pid', eligible: true, send: async () => { sends++; }, ...overrides }) };
}

test('disabled and startup never send; exact interval is inclusive', async () => {
  const off = fixture(false);
  off.timer.arm('pane:pid', 1);
  off.advance(60000);
  await off.tick();
  assert.equal(off.count(), 0);
  const f = fixture();
  f.advance(60000);
  await f.tick();
  assert.equal(f.count(), 0);
  f.timer.arm('pane:pid', 1);
  f.advance(59999);
  await f.tick();
  assert.equal(f.count(), 0);
  f.advance(1);
  await f.tick();
  assert.equal(f.count(), 1);
});

test('normal Enter resets interval, periodic sends retain cumulative cap', async () => {
  const f = fixture();
  f.timer.arm('pane:pid', 1);
  f.advance(59000);
  f.timer.entered();
  f.advance(1000);
  await f.tick();
  assert.equal(f.count(), 0);
  for (let i = 0; i < 5; i++) { f.advance(60000); await f.tick(); }
  assert.equal(f.count(), 3);
  assert.equal(f.events.filter(e => e === 'periodic_exhausted').length, 1);
  f.timer.arm('pane:pid', 2);
  f.advance(60000);
  await f.tick();
  assert.equal(f.count(), 4);
});

test('failed attempts rate limit and exhaust; busy defers; identity changes disarm', async () => {
  const f = fixture();
  f.timer.arm('pane:pid', 1);
  f.advance(60000);
  await f.tick({ eligible: false });
  assert.equal(f.count(), 0);
  for (let i = 0; i < 5; i++) {
    await f.tick({ send: async () => { throw new Error('private payload'); } });
    await f.tick();
    f.advance(60000);
  }
  assert.equal(f.count(), 0);
  assert.equal(f.events.filter(e => e === 'periodic_failed').length, 3);
  f.timer.arm('pane:pid', 2);
  f.advance(60000);
  await f.tick({ identity: 'replacement' });
  await f.tick();
  assert.equal(f.timer.pending, null);
});

test('tick awaits send completion', async () => {
  const f = fixture();
  f.timer.arm('pane:pid', 1);
  f.advance(60000);
  let release;
  const pending = f.tick({ send: () => new Promise(resolve => { release = resolve; }) });
  assert.equal(f.events.includes('periodic_sent'), false);
  release();
  await pending;
  assert.equal(f.events.includes('periodic_sent'), true);
});
