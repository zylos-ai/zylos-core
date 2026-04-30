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

  it('transitions to unavailable when cooldown expires and Claude is not running (#252)', () => {
    // Enter rate_limited with cooldown at T=1000
    engine.enterRateLimited(1000, '10:00 AM');
    expect(engine.health).toBe('rate_limited');

    // T=999: still in cooldown, agentRunning=false
    engine.processHeartbeat(false, 999);
    expect(engine.health).toBe('rate_limited');

    // T=1000: cooldown expired, agentRunning=false
    // Before fix: !agentRunning early return caused deadlock
    // After fix: transitions out of rate_limited so Guardian can restart.
    engine.processHeartbeat(false, 1000);
    expect(engine.health).toBe('unavailable');
    expect(killed).toBe(1);
    expect(engine.cooldownUntil).toBe(0);
  });

  it('does not deadlock — guardian can restart after transition to unavailable', () => {
    engine.enterRateLimited(1000);
    engine.processHeartbeat(false, 1000);

    // Health is now 'unavailable', so Guardian process liveness is no longer blocked by rate_limited.
    expect(engine.health).not.toBe('rate_limited');
    expect(engine.health).toBe('unavailable');
  });

  it('recovers fully after guardian restarts Claude and heartbeat succeeds', () => {
    engine.enterRateLimited(1000);

    // Cooldown expires, Claude not running → unavailable
    engine.processHeartbeat(false, 1000);
    expect(engine.health).toBe('unavailable');

    // Guardian starts Claude, signal acceleration detects false→true
    engine.processHeartbeat(false, 1005); // still starting
    engine.processHeartbeat(true, 1010);  // Claude running, signal detected

    // Grace period elapses
    engine.processHeartbeat(true, 1045);  // 35s after signal, > 30s grace
    expect(enqueuedPhases).toContain('post_restart');

    // Heartbeat succeeds
    engine.onHeartbeatSuccess('post_restart');
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

    // Next tick: cooldown expired (0 < 1500), transitions to unavailable
    engine.processHeartbeat(false, 1500);
    expect(engine.health).toBe('unavailable');
  });

  it('rate_limited recovery heartbeat failure stays unavailable', () => {
    engine.enterRateLimited(1000);
    engine.processHeartbeat(false, 1000);
    expect(engine.health).toBe('unavailable');

    // Simulate: guardian restarts Claude, heartbeat sent, but rate limit still active
    // Engine is in unavailable state now, heartbeat failure triggers triggerRecovery
    engine.processHeartbeat(true, 1035);
    engine.processHeartbeat(true, 1070); // signal acceleration fires

    // Simulate heartbeat failure in unavailable state
    engine.onHeartbeatFailure({ phase: 'post_restart' }, 'timeout');
    // Should still be unavailable (triggerRecovery increments failure count)
    expect(engine.health).toBe('unavailable');
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
    expect(engine2.health).toBe('unavailable');
  });
});

describe('HeartbeatEngine — user message recovery across all states', () => {
  it('unavailable: resets backoff for immediate retry', () => {
    const phases = [];
    const engine = new HeartbeatEngine(makeDeps({
      enqueueHeartbeat: (phase) => { phases.push(phase); return true; },
    }), { heartbeatInterval: 1800 });

    // Enter unavailable with high failure count (long backoff)
    engine.triggerRecovery('test_fail');
    engine.triggerRecovery('test_fail_2');
    engine.triggerRecovery('test_fail_3');
    expect(engine.health).toBe('unavailable');
    expect(engine.restartFailureCount).toBe(3);
    const backoffBefore = engine.getBackoffDelay(); // 60 * 5^2 = 1500s

    // User message resets backoff
    const triggered = engine.notifyUserMessage(5000);
    expect(triggered).toBe(true);
    expect(engine.restartFailureCount).toBe(0);
    expect(engine.lastRecoveryAt).toBe(0);

    // Next processHeartbeat with agentRunning should immediately send recovery heartbeat
    phases.length = 0;
    engine.processHeartbeat(true, 5001);
    expect(phases).toContain('recovery');
  });

  it('down: triggers immediate probe by resetting lastDownCheckAt', () => {
    const phases = [];
    const engine = new HeartbeatEngine(makeDeps({
      enqueueHeartbeat: (phase) => { phases.push(phase); return true; },
    }), {
      downDegradeThreshold: 10,
      downRetryInterval: 3600,
    });

    // Restore a legacy down state. New AM v3 recovery paths remain public unavailable,
    // but persisted down is still readable during transition.
    engine.setHealth('down', 'legacy_restored_down');
    expect(engine.health).toBe('down');

    // Without user message, would need to wait downRetryInterval (3600s)
    engine.lastDownCheckAt = 5000;
    phases.length = 0;
    engine.processHeartbeat(true, 5100); // Only 100s since last check, < 3600
    expect(phases).toEqual([]);

    // User message resets lastDownCheckAt
    const triggered = engine.notifyUserMessage(5100);
    expect(triggered).toBe(true);
    expect(engine.lastDownCheckAt).toBe(0);

    // Now processHeartbeat should immediately send a probe
    engine.processHeartbeat(true, 5101);
    expect(phases).toContain('down-check');
  });

  it('ok state: no-op', () => {
    const engine = new HeartbeatEngine(makeDeps());
    expect(engine.health).toBe('ok');

    const triggered = engine.notifyUserMessage(1000);
    expect(triggered).toBe(false);
  });

  it('respects cooldown across all states', () => {
    const engine = new HeartbeatEngine(makeDeps(), {
      userMessageRecoveryCooldown: 300,
    });

    engine.triggerRecovery('fail');
    expect(engine.health).toBe('unavailable');

    // First message triggers
    expect(engine.notifyUserMessage(1000)).toBe(true);

    // Second message within cooldown is rejected
    expect(engine.notifyUserMessage(1200)).toBe(false);

    // After cooldown, triggers again
    expect(engine.notifyUserMessage(1301)).toBe(true);
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

  it('enters unavailable on heartbeat failure from ok state', () => {
    const engine = new HeartbeatEngine(makeDeps());
    expect(engine.health).toBe('ok');

    engine.triggerRecovery('test_failure');
    expect(engine.health).toBe('unavailable');
    expect(engine.restartFailureCount).toBe(1);
  });

  it('keeps new continuous failures unavailable after threshold', () => {
    const engine = new HeartbeatEngine(makeDeps(), {
      downDegradeThreshold: 100,
    });

    engine.triggerRecovery('first_fail'); // Sets recoveringStartedAt
    const startTime = engine.recoveringStartedAt;

    // Simulate failure after threshold
    // Manually advance recoveringStartedAt to test degradation
    engine.recoveringStartedAt = startTime - 200;
    engine.triggerRecovery('later_fail');
    expect(engine.health).toBe('unavailable');
    expect(engine.healthReason).toMatch(/^continuous_failure_for_/);
  });

  it('triggerRecovery from rate_limited is a no-op (health and failure count unchanged)', () => {
    // triggerRecovery returns early in rate_limited state — the recovery path for
    // rate_limited is processHeartbeat() once the cooldown expires, not triggerRecovery.
    // So neither health nor restartFailureCount should change.
    const engine = new HeartbeatEngine(makeDeps());
    engine.enterRateLimited(9999);

    engine.triggerRecovery('external_trigger');
    // Health stays rate_limited, failure count stays 0 (early return before increment)
    expect(engine.health).toBe('rate_limited');
    expect(engine.restartFailureCount).toBe(0);
  });
});
