import assert from 'node:assert/strict';
import test from 'node:test';
import { EventLoopMonitor } from '../event-loop-monitor.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('warning uses the actual elapsed sample window and drains task attribution', () => {
  let now = 0;
  const lines = [];
  const histogram = { max: 1_200e6, percentile: () => 20e6, reset() {}, enable() {}, disable() {} };
  const monitor = new EventLoopMonitor({ now: () => now, histogram, log: line => lines.push(line) });
  monitor.runTask('collectors.collect', () => { now += 1_200; });
  now = 8_300;
  const first = monitor.sample();
  assert.equal(first.window_ms, 8_300);
  assert.equal(first.longest_tasks[0].name, 'collectors.collect');
  assert.equal(first.longest_tasks[0].max_ms, 1_200);
  assert.match(lines[0], /last 8300ms window.*collectors\.collect 1200ms sync/);
  now = 13_300;
  const second = monitor.sample();
  assert.equal(second.window_ms, 5_000);
  assert.deepEqual(second.longest_tasks, []);
  assert.doesNotMatch(lines[1], /collectors\.collect/);
});

test('real monitor warning identifies an artificial synchronous block over one second', async () => {
  const lines = [];
  const monitor = new EventLoopMonitor({ sampleIntervalMs: 60_000, log: line => lines.push(line) }).start();
  try {
    await sleep(60);
    monitor.runTask('artificial-periodic-blocker', () => {
      const until = performance.now() + 1_100;
      while (performance.now() < until) { /* intentional test-only event-loop block */ }
    });
    await sleep(60);
    const sample = monitor.sample();
    assert.ok(sample.max_ms >= 1_000, `expected >1s event-loop delay, got ${sample.max_ms}`);
    assert.ok(sample.longest_tasks[0].max_ms >= 1_000);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /artificial-periodic-blocker/);
  } finally {
    monitor.stop();
  }
});
