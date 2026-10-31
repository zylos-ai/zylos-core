import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoalescedBroadcast, createSessionCache, broadcastFleetSnapshot } from '../src/lib/coalesced-broadcast.js';

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

test('cost cache expires after 15 seconds and invalidates on session switch', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let reads = 0;
  const get = createSessionCache(() => ({ value: ++reads }));
  assert.deepEqual(get('a'), { value: 1 });
  t.mock.timers.tick(14_999);
  assert.deepEqual(get('a'), { value: 1 });
  t.mock.timers.tick(1);
  assert.deepEqual(get('a'), { value: 2 });
  assert.deepEqual(get('b'), { value: 3 });
  assert.deepEqual(get(null), { value: 4 });
});

test('no subscriber builds nothing; local and fleet events share one snapshot', () => {
  const sent = [];
  const sse = { clients: new Set(), broadcast: (kind, value) => sent.push([kind, value]) };
  let builds = 0;
  const build = () => ({ serial: ++builds });
  const fleet = value => sent.push(['fleet', value]);
  broadcastFleetSnapshot(sse, build, fleet);
  assert.equal(builds, 0);
  sse.clients.add({});
  broadcastFleetSnapshot(sse, build, fleet);
  assert.equal(builds, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0][1], sent[1][1]);
});
