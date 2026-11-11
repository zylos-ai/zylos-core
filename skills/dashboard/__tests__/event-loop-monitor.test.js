import assert from 'node:assert/strict';
import test from 'node:test';
import { EventLoopMonitor } from '../src/lib/event-loop-monitor.js';

function blockFor(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* deliberately starve the loop */ }
}

test('event loop monitor measures a synchronous block and reports it in the snapshot (#260)', async () => {
  const monitor = new EventLoopMonitor({ sampleIntervalMs: 60_000, blockWarnMs: 60_000, log: () => {} });
  monitor.start();
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    blockFor(150);
    await new Promise(resolve => setTimeout(resolve, 50));
    const sampled = monitor.sample();
    assert.ok(sampled.max_ms >= 100, `expected max_ms >= 100, got ${sampled.max_ms}`);
    const snap = monitor.snapshot();
    assert.equal(snap.max_ms, sampled.max_ms);
    assert.equal(snap.window_max_ms, sampled.max_ms);
    assert.ok(snap.sampled_at);
  } finally {
    monitor.stop();
  }
});

test('event loop monitor warns when a window exceeds the block threshold (#260)', async () => {
  const lines = [];
  const monitor = new EventLoopMonitor({ sampleIntervalMs: 60_000, blockWarnMs: 100, log: line => lines.push(line) });
  monitor.start();
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    blockFor(150);
    await new Promise(resolve => setTimeout(resolve, 20));
    monitor.sample();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[event-loop\] blocked ~\d+(\.\d+)?ms/);

    // A quiet window after the reset must not warn again.
    await new Promise(resolve => setTimeout(resolve, 30));
    monitor.sample();
    assert.equal(lines.length, 1);
  } finally {
    monitor.stop();
  }
});

test('event loop monitor keeps a rolling window max across samples (#260)', async () => {
  const monitor = new EventLoopMonitor({ sampleIntervalMs: 60_000, blockWarnMs: 60_000, log: () => {} });
  monitor.start();
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    blockFor(120);
    await new Promise(resolve => setTimeout(resolve, 20));
    const busy = monitor.sample();
    await new Promise(resolve => setTimeout(resolve, 30));
    const quiet = monitor.sample();
    assert.ok(quiet.max_ms < busy.max_ms);
    // Snapshot reflects the latest sample but the window keeps the worst case.
    const snap = monitor.snapshot();
    assert.equal(snap.max_ms, quiet.max_ms);
    assert.equal(snap.window_max_ms, busy.max_ms);
  } finally {
    monitor.stop();
  }
});
