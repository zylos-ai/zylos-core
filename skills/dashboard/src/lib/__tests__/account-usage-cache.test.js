import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountUsageCache } from '../account-usage-cache.js';

test('a failed shared account read retries before the cache TTL expires', async () => {
  let calls = 0;
  let now = 0;
  const failure = new Error('temporary read failure');
  const snapshot = { live: { seven_day: { used_percentage: 7 } },
    recorded: { value: { seven_day: { used_percentage: 12 } }, live: false, recordedAt: 123 } };
  const reader = { readAccountUsageSnapshot: async () => {
    calls++;
    if (calls === 1) throw failure;
    return snapshot;
  } };
  const cache = new AccountUsageCache({ now: () => now });
  await Promise.all([
    assert.rejects(cache.read('claude', undefined, reader), error => error === failure),
    assert.rejects(cache.read('claude', { allowRecorded: true }, reader), error => error === failure),
  ]);
  assert.equal(calls, 1, 'concurrent readers share the failed attempt');
  now = 1;
  const [live, recorded] = await Promise.all([
    cache.read('claude', undefined, reader),
    cache.read('claude', { allowRecorded: true }, reader),
  ]);
  assert.equal(calls, 2, 'the next attempt retries within the 30-second TTL');
  assert.deepEqual(live, snapshot.live);
  assert.deepEqual(recorded, snapshot.recorded);
  now = 2;
  assert.deepEqual(await cache.read('claude', undefined, reader), snapshot.live);
  assert.equal(calls, 2, 'successful results remain cached');
});

test('account reads share a pending scan even after its cache TTL has elapsed', async () => {
  let now = 0;
  let calls = 0;
  let release;
  const snapshot = { live: { seven_day: { used_percentage: 7 } },
    recorded: { value: { seven_day: { used_percentage: 12 } }, live: false, recordedAt: 123 } };
  const pending = new Promise(resolve => { release = resolve; });
  const reader = { readAccountUsageSnapshot: () => { calls++; return pending; } };
  const cache = new AccountUsageCache({ now: () => now });
  const reads = [cache.read('claude', { allowRecorded: true }, reader)];
  try {
    await Promise.resolve();
    assert.equal(calls, 1);
    now = 30_001;
    reads.push(cache.read('claude', undefined, reader));
    await Promise.resolve();
    assert.equal(calls, 1, 'TTL expiry must not start a second scan while the first is pending');
    release(snapshot);
    const [recorded, live] = await Promise.all(reads);
    assert.deepEqual(recorded, snapshot.recorded);
    assert.deepEqual(live, snapshot.live);
  } finally {
    release(snapshot);
    await Promise.allSettled(reads);
  }
});
