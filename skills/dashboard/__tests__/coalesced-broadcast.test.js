import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoalescedBroadcast } from '../src/lib/coalesced-broadcast.js';

test('broadcasts run off-ingest and a slow broadcast starts a new full window', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  let calls = 0;
  const schedule = createCoalescedBroadcast(() => {
    calls++;
    t.mock.timers.setTime(Date.now() + 2500);
  });
  schedule(); schedule();
  assert.equal(calls, 0);
  t.mock.timers.tick(0);
  assert.equal(calls, 1);
  schedule(); schedule();
  t.mock.timers.tick(999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal(calls, 2);
});

test('an asynchronous broadcast holds its coalescing window until collection finishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  let calls = 0, finish;
  const schedule = createCoalescedBroadcast(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  });
  schedule(); t.mock.timers.tick(0);
  schedule(); t.mock.timers.tick(5000);
  assert.equal(calls, 1, 'a slow collection does not overlap a second publication');
  finish(); await Promise.resolve();
  schedule(); t.mock.timers.tick(999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal(calls, 2, 'the next full window starts after collection finishes');
  finish(); await Promise.resolve();
});
