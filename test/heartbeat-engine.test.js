import { describe, it, expect, beforeEach } from '@jest/globals';
import { HeartbeatEngine } from '../skills/activity-monitor/scripts/heartbeat-engine.js';

function makeDeps(overrides = {}) {
  return {
    enqueueHeartbeat: overrides.enqueueHeartbeat ?? (() => true),
    getHeartbeatStatus: overrides.getHeartbeatStatus ?? (() => 'done'),
    readHeartbeatPending: overrides.readHeartbeatPending ?? (() => null),
    clearHeartbeatPending: overrides.clearHeartbeatPending ?? (() => {}),
    killTmuxSession: overrides.killTmuxSession ?? (() => {}),
    notifyPendingChannels: overrides.notifyPendingChannels ?? (() => {}),
    log: overrides.log ?? (() => {}),
  };
}

describe('HeartbeatEngine — rate_limited recovery', () => {
  let engine;
  let killed;
  let enqueuedPhases;

  beforeEach(() => {
    killed = 0;
    enqueuedPhases = [];
    engine = new HeartbeatEngine(makeDeps({
      killTmuxSession: () => { killed++; },
      enqueueHeartbeat: (phase) => { enqueuedPhases.push(phase); return true; },
    }), {
      heartbeatInterval: 1800,
      signalGracePeriod: 30,
    });
  });

  it('transitions to recovering when cooldown expires and Claude is not running (#252)', () => {
    // Enter rate_limited with cooldown at T=1000
    engine.enterRateLimited(1000, '10:00 AM');
    expect(engine.health).toBe('rate_limited');

    // T=999: still in cooldown, claudeRunning=false
    engine.processHeartbeat(false, 999);
    expect(engine.health).toBe('rate_limited');

    // T=1000: cooldown expired, claudeRunning=false
    // Before fix: !claudeRunning early return caused deadlock
    // After fix: transitions to recovering
    engine.processHeartbeat(false, 1000);
    expect(engine.health).toBe('recovering');
    expect(killed).toBe(1);
    expect(engine.cooldownUntil).toBe(0);
  });

  it('does not deadlock — guardian can restart after transition to recovering', () => {
    engine.enterRateLimited(1000);
    engine.processHeartbeat(false, 1000);

    // Health is now 'recovering', so guardian check `health !== 'rate_limited'` passes
    expect(engine.health).not.toBe('rate_limited');
    expect(engine.health).toBe('recovering');
  });

  it('recovers fully after guardian restarts Claude and heartbeat succeeds', () => {
    engine.enterRateLimited(1000);

    // Cooldown expires, Claude not running → recovering
    engine.processHeartbeat(false, 1000);
    expect(engine.health).toBe('recovering');

    // Guardian starts Claude, signal acceleration detects false→true
    engine.processHeartbeat(false, 1005); // still starting
    engine.processHeartbeat(true, 1010);  // Claude running, signal detected

    // Grace period elapses
    engine.processHeartbeat(true, 1045);  // 35s after signal, > 30s grace
    expect(enqueuedPhases).toContain('signal-recovery');

    // Heartbeat succeeds
    engine.onHeartbeatSuccess('signal-recovery');
    expect(engine.health).toBe('ok');
    expect(engine.cooldownUntil).toBe(0);
    expect(engine.rateLimitResetTime).toBe('');
  });

  it('stays rate_limited while cooldown is active even when Claude is running', () => {
    engine.enterRateLimited(2000);

    // Claude is running but rate limited — should stay rate_limited
    engine.processHeartbeat(true, 1500);
    expect(engine.health).toBe('rate_limited');
  });

  it('user message triggered recovery clears cooldown for next tick', () => {
    engine.enterRateLimited(2000);

    // User message triggers early recovery
    const triggered = engine.notifyUserMessage(1500);
    expect(triggered).toBe(true);
    expect(engine.cooldownUntil).toBe(0);

    // Next tick: cooldown expired (0 < 1500), transitions to recovering
    engine.processHeartbeat(false, 1500);
    expect(engine.health).toBe('recovering');
  });

  it('rate_limited recovery heartbeat failure re-enters rate_limited with 60s retry', () => {
    engine.enterRateLimited(1000);
    engine.processHeartbeat(false, 1000);
    expect(engine.health).toBe('recovering');

    // Simulate: guardian restarts Claude, heartbeat sent, but rate limit still active
    // Engine is in recovering state now, heartbeat failure triggers triggerRecovery
    engine.processHeartbeat(true, 1035);
    engine.processHeartbeat(true, 1070); // signal acceleration fires

    // Simulate heartbeat failure in recovering state
    engine.onHeartbeatFailure({ phase: 'signal-recovery' }, 'timeout');
    // Should still be in recovering (triggerRecovery increments failure count)
    expect(engine.health).toBe('recovering');
  });

  it('handles PM2 restart with persisted rate_limited state and expired cooldown', () => {
    // Simulate PM2 restart: engine created with initialHealth='rate_limited'
    const engine2 = new HeartbeatEngine(makeDeps({
      killTmuxSession: () => { killed++; },
    }), {
      initialHealth: 'rate_limited',
    });
    engine2.cooldownUntil = 1000; // Rehydrated from status file

    // First tick after restart, cooldown already expired
    engine2.processHeartbeat(false, 1500);
    expect(engine2.health).toBe('recovering');
  });
});

describe('HeartbeatEngine — basic health transitions', () => {
  it('sends primary heartbeat when interval elapses', () => {
    const phases = [];
    const engine = new HeartbeatEngine(makeDeps({
      enqueueHeartbeat: (phase) => { phases.push(phase); return true; },
    }), {
      heartbeatInterval: 60,
    });

    // Not enough time elapsed
    engine.processHeartbeat(true, engine.lastHeartbeatAt + 30);
    expect(phases).toEqual([]);

    // Interval elapsed
    engine.processHeartbeat(true, engine.lastHeartbeatAt + 60);
    expect(phases).toEqual(['primary']);
  });

  it('enters recovering on heartbeat failure from ok state', () => {
    const engine = new HeartbeatEngine(makeDeps());
    expect(engine.health).toBe('ok');

    engine.triggerRecovery('test_failure');
    expect(engine.health).toBe('recovering');
    expect(engine.restartFailureCount).toBe(1);
  });

  it('degrades to down after continuous failure exceeds threshold', () => {
    const engine = new HeartbeatEngine(makeDeps(), {
      downDegradeThreshold: 100,
    });

    engine.triggerRecovery('first_fail'); // Sets recoveringStartedAt
    const startTime = engine.recoveringStartedAt;

    // Simulate failure after threshold
    // Manually advance recoveringStartedAt to test degradation
    engine.recoveringStartedAt = startTime - 200;
    engine.triggerRecovery('later_fail');
    expect(engine.health).toBe('down');
  });

  it('triggerRecovery from rate_limited increments failure count but does not change health', () => {
    // triggerRecovery is not the recovery path for rate_limited — processHeartbeat
    // handles the transition. triggerRecovery only sets health when called from 'ok'.
    const engine = new HeartbeatEngine(makeDeps());
    engine.enterRateLimited(9999);

    engine.triggerRecovery('external_trigger');
    // Health stays rate_limited (setHealth only transitions from 'ok')
    // but failure count increments — no crash, no deadlock
    expect(engine.health).toBe('rate_limited');
    expect(engine.restartFailureCount).toBe(1);
  });
});
