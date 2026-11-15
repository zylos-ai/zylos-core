import assert from 'node:assert/strict';
import test from 'node:test';
import { FleetPoller } from '../fleet-poller.js';

function fixture(names = ['remote']) {
  let now = 0;
  const timers = new Map();
  const logs = [];
  const agents = names.map(name => ({ name, base_url: `https://${name}.example.test` }));
  const poller = new FleetPoller({ fleet: { agents } }, {
    now: () => now,
    fetch: async () => { throw new Error('network must not be used'); },
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.set(timer, timer);
      return timer;
    },
    clearTimeout: timer => timers.delete(timer),
    log: (level, line) => logs.push({ level, line })
  });
  poller.running = true;
  return {
    poller, agents, logs, timers,
    flushWindow() {
      now += 60_000;
      for (const timer of [...timers.values()].filter(timer => timer.ms === 60_000)) {
        timers.delete(timer);
        timer.fn();
      }
    }
  };
}

async function failSse(poller, agent, reason) {
  poller._runSse = async () => { throw Object.assign(new Error(reason), { reason }); };
  poller._connectSse(agent);
  // Drain the catch/finally chain without running fake network/reconnect timers.
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

test('identical SSE failures and fallback toggles share one timed summary per agent', async () => {
  const f = fixture();
  const [agent] = f.agents;
  try {
    await failSse(f.poller, agent, 'timeout');
    await failSse(f.poller, agent, 'timeout');
    f.poller._stopFallbackPolling(agent, 'sse-takeover');
    f.poller._startFallbackPolling(agent, 'sse-failure');
    f.poller._stopFallbackPolling(agent, 'sse-takeover');
    assert.equal(f.logs.length, 2, 'initial fallback and initial failure log immediately');
    assert.equal(f.poller.connectionLogs.size, 1);
    assert.equal([...f.timers.values()].filter(t => t.ms === 60_000).length, 1);
    f.flushWindow();
    assert.equal(f.logs.length, 3);
    assert.match(f.logs[2].line, /window_ms=60000 sse_failure_repeats=1 fallback_started=1 fallback_stopped=2/);
    assert.equal([...f.timers.values()].filter(t => t.ms === 60_000).length, 0);
    f.flushWindow();
    assert.equal(f.logs.length, 3, 'quiet windows do not emit repeated summaries');
  } finally { f.poller.stop(); }
});

test('substantive reason changes log immediately without creating per-reason state', async () => {
  const f = fixture();
  const [agent] = f.agents;
  try {
    const reasons = ['timeout', 'auth_failed', 'conn_refused', 'bad_payload', 'version_unsupported', 'unreachable'];
    for (let i = 0; i < 120; i++) await failSse(f.poller, agent, reasons[i % reasons.length]);
    assert.equal(f.logs.filter(log => log.level === 'warn').length, 120);
    assert.match(f.logs.at(-1).line, /reason=unreachable/);
    assert.equal(f.poller.connectionLogs.size, 1);
    const state = f.poller.connectionLogs.get(agent.name);
    assert.equal(state.lastReason, 'unreachable');
    assert.equal(Object.values(state).filter(value => value instanceof Map).length, 0);
    for (let i = 0; i < 120; i++) await failSse(f.poller, agent, 'unreachable');
    assert.equal(f.logs.filter(log => log.level === 'warn').length, 120);
    f.flushWindow();
    assert.match(f.logs.at(-1).line, /sse_failure_repeats=120/);
  } finally { f.poller.stop(); }
});

test('one failure creates no summary and the next window starts with an immediate failure', async () => {
  const f = fixture();
  try {
    await failSse(f.poller, f.agents[0], 'timeout');
    const initial = f.logs.length;
    f.flushWindow();
    assert.equal(f.logs.length, initial);
    await failSse(f.poller, f.agents[0], 'timeout');
    assert.equal(f.logs.length, initial + 1);
    assert.equal(f.logs.at(-1).level, 'warn');
  } finally { f.poller.stop(); }
});

test('remove and stop flush pending repeats and release all summary state and timers', async () => {
  const f = fixture(['one', 'two']);
  for (const agent of f.agents) {
    await failSse(f.poller, agent, 'timeout');
    await failSse(f.poller, agent, 'timeout');
  }
  assert.equal(f.poller.connectionLogs.size, 2);
  f.poller.removeAgent('one');
  assert.equal(f.poller.connectionLogs.size, 1);
  assert.match(f.logs.at(-1).line, /agent=one .*sse_failure_repeats=1/);
  const afterRemoval = f.logs.length;
  await failSse(f.poller, f.agents[0], 'timeout');
  assert.equal(f.logs.length, afterRemoval, 'removed agent callbacks cannot recreate state');
  f.poller.stop();
  assert.equal(f.poller.connectionLogs.size, 0);
  assert.equal(f.timers.size, 0);
  assert.match(f.logs.at(-1).line, /agent=two .*sse_failure_repeats=1/);
  const afterStop = f.logs.length;
  f.poller.stop();
  assert.equal(f.logs.length, afterStop);
});

test('consecutive connection log windows summarize only their own repeated events', async () => {
  const f = fixture();
  const [agent] = f.agents;
  try {
    for (let i = 0; i < 3; i++) await failSse(f.poller, agent, 'timeout');
    f.poller._stopFallbackPolling(agent, 'sse-takeover');
    f.poller._startFallbackPolling(agent, 'sse-failure');
    f.poller._stopFallbackPolling(agent, 'sse-takeover');
    f.flushWindow();
    const first = f.logs.filter(log => log.line.includes('repeated connection events'));
    assert.equal(first.length, 1);
    assert.match(first[0].line, /window_ms=60000 sse_failure_repeats=2 fallback_started=1 fallback_stopped=2$/);

    for (let i = 0; i < 2; i++) await failSse(f.poller, agent, 'timeout');
    f.poller._stopFallbackPolling(agent, 'sse-takeover');
    f.flushWindow();
    const summaries = f.logs.filter(log => log.line.includes('repeated connection events'));
    assert.equal(summaries.length, 2);
    assert.match(summaries[1].line, /window_ms=60000 sse_failure_repeats=1 fallback_started=0 fallback_stopped=1$/);
  } finally { f.poller.stop(); }
  assert.equal(f.timers.size, 0);
  assert.equal(f.poller.connectionLogs.size, 0);
});
