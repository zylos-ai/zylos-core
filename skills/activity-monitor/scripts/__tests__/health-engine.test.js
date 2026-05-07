import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HealthEngine, HeartbeatEngine } from '../health-engine.js';

function createMockDeps() {
  const calls = {
    enqueueHeartbeat: [],
    getHeartbeatStatus: [],
    readHeartbeatPending: [],
    clearHeartbeatPending: 0,
    killTmuxSession: 0,
    log: []
  };

  const deps = {
    enqueueHeartbeat: (phase) => { calls.enqueueHeartbeat.push(phase); return true; },
    getHeartbeatStatus: (id) => { calls.getHeartbeatStatus.push(id); return deps._heartbeatStatus || 'pending'; },
    readHeartbeatPending: () => { calls.readHeartbeatPending.push(true); return deps._pending || null; },
    clearHeartbeatPending: () => { calls.clearHeartbeatPending++; },
    killTmuxSession: () => { calls.killTmuxSession++; },
    log: (msg) => { calls.log.push(msg); },
    // Test helpers
    _pending: null,
    _heartbeatStatus: 'pending'
  };

  return { deps, calls };
}

describe('HealthEngine', () => {
  describe('maintenance lifecycle', () => {
    it('keeps HeartbeatEngine as a compatibility alias', () => {
      assert.equal(HeartbeatEngine, HealthEngine);
    });

    it('starts an internal maintenance loop and stop clears it', async () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, {
        heartbeatInterval: 1,
        maintenanceIntervalMs: 5,
        now: () => Date.now()
      });
      engine.lastHeartbeatAt = 0;

      engine.setAgentRunning(true);
      engine.start();
      await new Promise(resolve => setTimeout(resolve, 20));
      engine.stop();
      const countAfterStop = calls.enqueueHeartbeat.length;
      await new Promise(resolve => setTimeout(resolve, 15));

      assert.ok(countAfterStop >= 1);
      assert.equal(calls.enqueueHeartbeat.length, countAfterStop);
      assert.equal(engine.maintenanceTimer, null);
    });

    it('destroy clears maintenance and recovery timers', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps, {
        maintenanceIntervalMs: 100,
        now: () => 1000
      });

      engine.start();
      engine.enterRateLimited(2000, 'later');
      engine.onProcessRestarted(1000);
      assert.ok(engine.maintenanceTimer);
      assert.ok(engine.cooldownTimer);
      assert.ok(engine.postRestartProbeTimer);

      engine.destroy();

      assert.equal(engine.maintenanceTimer, null);
      assert.equal(engine.cooldownTimer, null);
      assert.equal(engine.postRestartProbeTimer, null);
    });

    it('keeps processHeartbeat as a compatibility alias for runMaintenanceCycle', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HealthEngine(deps, { heartbeatInterval: 1 });
      engine.lastHeartbeatAt = 0;

      engine.processHeartbeat(true, 10);

      assert.deepEqual(calls.enqueueHeartbeat, ['primary']);
    });
  });

  describe('primary heartbeat', () => {
    it('enqueues after HEARTBEAT_INTERVAL elapsed', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { heartbeatInterval: 7200 });
      const currentTime = Math.floor(Date.now() / 1000);
      engine.lastHeartbeatAt = currentTime - 7201;

      engine.processHeartbeat(true, currentTime);

      assert.deepStrictEqual(calls.enqueueHeartbeat, ['primary']);
    });

    it('does not enqueue before interval', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { heartbeatInterval: 7200 });
      const currentTime = Math.floor(Date.now() / 1000);
      engine.lastHeartbeatAt = currentTime - 100;

      engine.processHeartbeat(true, currentTime);

      assert.deepStrictEqual(calls.enqueueHeartbeat, []);
    });

    it('does not enqueue when agent is not running', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { heartbeatInterval: 7200 });
      const currentTime = Math.floor(Date.now() / 1000);
      engine.lastHeartbeatAt = currentTime - 7201;

      engine.processHeartbeat(false, currentTime);

      assert.deepStrictEqual(calls.enqueueHeartbeat, []);
    });

    it('updates lastHeartbeatAt on primary enqueue', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { heartbeatInterval: 7200 });
      const currentTime = Math.floor(Date.now() / 1000);
      engine.lastHeartbeatAt = currentTime - 7201;

      engine.processHeartbeat(true, currentTime);

      const diff = Math.abs(engine.lastHeartbeatAt - Math.floor(Date.now() / 1000));
      assert.ok(diff <= 1, `lastHeartbeatAt should be updated to current time, diff=${diff}`);
    });

    it('does not enqueue primary heartbeat when disabled', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { heartbeatInterval: 7200, heartbeatEnabled: false });
      const currentTime = Math.floor(Date.now() / 1000);
      engine.lastHeartbeatAt = currentTime - 7201;

      engine.processHeartbeat(true, currentTime);

      assert.deepStrictEqual(calls.enqueueHeartbeat, []);
    });
  });

  describe('heartbeat success', () => {
    it('clears pending and resets failure count on done', () => {
      const { deps, calls } = createMockDeps();
      deps._pending = { control_id: 1, phase: 'primary' };
      deps._heartbeatStatus = 'done';
      const engine = new HeartbeatEngine(deps);
      engine.restartFailureCount = 2;

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.equal(calls.clearHeartbeatPending, 1);
      assert.equal(engine.restartFailureCount, 0);
    });

    it('transitions recovering to ok', () => {
      const { deps, calls } = createMockDeps();
      deps._pending = { control_id: 1, phase: 'recovery' };
      deps._heartbeatStatus = 'done';
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.equal(engine.health, 'ok');
    });

    it('keeps ok health on primary heartbeat success', () => {
      const { deps, calls } = createMockDeps();
      deps._pending = { control_id: 1, phase: 'primary' };
      deps._heartbeatStatus = 'done';
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.equal(engine.health, 'ok');
    });

    it('updates lastHeartbeatAt for non-primary success', () => {
      const { deps } = createMockDeps();
      deps._pending = { control_id: 1, phase: 'recovery' };
      deps._heartbeatStatus = 'done';
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });
      engine.lastHeartbeatAt = 0;

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.ok(engine.lastHeartbeatAt > 0);
    });

    it('resets recoveringStartedAt on success', () => {
      const { deps } = createMockDeps();
      deps._pending = { control_id: 1, phase: 'recovery' };
      deps._heartbeatStatus = 'done';
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });
      engine.recoveringStartedAt = 1000;

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.equal(engine.recoveringStartedAt, 0);
    });
  });

  describe('primary failure triggers direct recovery (no verify)', () => {
    it('triggers recovery when primary fails in ok state', () => {
      const { deps, calls } = createMockDeps();
      deps._pending = { control_id: 1, phase: 'primary' };
      deps._heartbeatStatus = 'timeout';
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.equal(calls.clearHeartbeatPending, 1);
      assert.equal(calls.killTmuxSession, 1);
      assert.equal(engine.health, 'unavailable');
    });

    it('does not enqueue verify phase', () => {
      const { deps, calls } = createMockDeps();
      deps._pending = { control_id: 1, phase: 'primary' };
      deps._heartbeatStatus = 'timeout';
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.ok(!calls.enqueueHeartbeat.includes('verify'));
    });
  });

  describe('exponential backoff', () => {
    it('calculates correct backoff delays', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.restartFailureCount = 0;
      assert.equal(engine.getBackoffDelay(), 0);

      engine.restartFailureCount = 1;
      assert.equal(engine.getBackoffDelay(), 60); // 60 * 5^0 = 60

      engine.restartFailureCount = 2;
      assert.equal(engine.getBackoffDelay(), 300); // 60 * 5^1 = 300

      engine.restartFailureCount = 3;
      assert.equal(engine.getBackoffDelay(), 1500); // 60 * 5^2 = 1500

      engine.restartFailureCount = 4;
      assert.equal(engine.getBackoffDelay(), 3600); // min(3600, 60 * 5^3) = 3600

      engine.restartFailureCount = 10;
      assert.equal(engine.getBackoffDelay(), 3600); // capped
    });

    it('delays recovery heartbeat during exponential backoff period', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });
      const now = Math.floor(Date.now() / 1000);
      engine.restartFailureCount = 2; // backoff = 300s
      engine.lastRecoveryAt = now - 60; // only 60s ago

      engine.processHeartbeat(true, now);

      assert.deepStrictEqual(calls.enqueueHeartbeat, []);
    });

    it('allows recovery heartbeat after backoff period', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });
      const now = Math.floor(Date.now() / 1000);
      engine.restartFailureCount = 2; // backoff = 300s
      engine.lastRecoveryAt = now - 301;

      engine.processHeartbeat(true, now);

      assert.deepStrictEqual(calls.enqueueHeartbeat, ['recovery']);
    });

    it('caps backoff at 3600 seconds', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });
      const now = Math.floor(Date.now() / 1000);
      engine.restartFailureCount = 10;
      engine.lastRecoveryAt = now - 3601;

      engine.processHeartbeat(true, now);

      assert.deepStrictEqual(calls.enqueueHeartbeat, ['recovery']);
    });

    it('retries indefinitely in recovering state (no max failures)', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering', downDegradeThreshold: 999999 });

      // Simulate 20 failures — should stay in recovering (not down)
      for (let i = 0; i < 20; i++) {
        engine.triggerRecovery(`fail_${i}`);
      }

      assert.equal(engine.health, 'recovering');
      assert.equal(engine.restartFailureCount, 20);
      assert.equal(calls.killTmuxSession, 20);
    });
  });

  describe('continuous failure while unavailable', () => {
    it('stays unavailable after downDegradeThreshold and updates the reason', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { downDegradeThreshold: 100 });

      // First failure: sets recoveringStartedAt
      engine.triggerRecovery('fail_1');
      assert.equal(engine.health, 'unavailable');
      assert.ok(engine.recoveringStartedAt > 0);

      // Simulate time passing beyond threshold by backdating recoveringStartedAt
      engine.recoveringStartedAt = Math.floor(Date.now() / 1000) - 101;

      engine.triggerRecovery('fail_late');
      assert.equal(engine.health, 'unavailable');
      assert.match(engine.healthReason, /^continuous_failure_for_10[1-9]s$/);
    });

    it('initializes recoveringStartedAt when resuming in recovering state', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering', downDegradeThreshold: 100 });

      // recoveringStartedAt should be set to ~now, not 0
      assert.ok(engine.recoveringStartedAt > 0);
      const diff = Math.abs(engine.recoveringStartedAt - Math.floor(Date.now() / 1000));
      assert.ok(diff <= 1);
    });

    it('stays unavailable when within downDegradeThreshold', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { downDegradeThreshold: 3600 });

      engine.triggerRecovery('fail_1');
      engine.triggerRecovery('fail_2');
      engine.triggerRecovery('fail_3');
      engine.triggerRecovery('fail_4');

      // All within same second, well under 3600s threshold
      assert.equal(engine.health, 'unavailable');
    });
  });

  describe('down state behavior', () => {
    it('enqueues down-check after retry interval', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'down', downRetryInterval: 3600 });
      const now = Math.floor(Date.now() / 1000);
      engine.lastDownCheckAt = now - 3601;

      engine.processHeartbeat(true, now);

      assert.deepStrictEqual(calls.enqueueHeartbeat, ['down-check']);
    });

    it('skips down-check during retry cooldown', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'down', downRetryInterval: 3600 });
      const now = Math.floor(Date.now() / 1000);
      engine.lastDownCheckAt = now - 60;

      engine.processHeartbeat(true, now);

      assert.deepStrictEqual(calls.enqueueHeartbeat, []);
    });

    it('recovers to ok when pending heartbeat succeeds', () => {
      const { deps, calls } = createMockDeps();
      deps._pending = { control_id: 1, phase: 'down-check' };
      deps._heartbeatStatus = 'done';
      const engine = new HeartbeatEngine(deps, { initialHealth: 'down' });

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.equal(engine.health, 'ok');
    });

    it('stays down when pending heartbeat fails (no kill)', () => {
      const { deps, calls } = createMockDeps();
      deps._pending = { control_id: 1, phase: 'down-check' };
      deps._heartbeatStatus = 'failed';
      const engine = new HeartbeatEngine(deps, { initialHealth: 'down' });

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.equal(engine.health, 'down');
      assert.equal(calls.killTmuxSession, 0);
    });
  });

  describe('triggerRecovery', () => {
    it('calls killTmuxSession', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.triggerRecovery('test_reason');

      assert.equal(calls.killTmuxSession, 1);
    });

    it('increments restartFailureCount', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.triggerRecovery('test');
      assert.equal(engine.restartFailureCount, 1);

      engine.triggerRecovery('test');
      assert.equal(engine.restartFailureCount, 2);
    });

    it('transitions ok to unavailable', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps);
      assert.equal(engine.health, 'ok');

      engine.triggerRecovery('test_reason');

      assert.equal(engine.health, 'unavailable');
    });

    it('sets recoveringStartedAt on first recovery', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps);
      assert.equal(engine.recoveringStartedAt, 0);

      engine.triggerRecovery('test');

      assert.ok(engine.recoveringStartedAt > 0);
    });

    it('sets lastRecoveryAt on recovery', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps);
      assert.equal(engine.lastRecoveryAt, 0);

      engine.triggerRecovery('test');

      assert.ok(engine.lastRecoveryAt > 0);
    });

    it('does nothing in down state', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'down' });

      engine.triggerRecovery('should_skip');

      assert.equal(calls.killTmuxSession, 0);
      assert.equal(engine.restartFailureCount, 0);
      assert.equal(engine.health, 'down');
    });

    it('logs skip message in down state', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'down' });

      engine.triggerRecovery('my_reason');

      assert.ok(calls.log.some(m => m.includes('DOWN') && m.includes('my_reason')));
    });

    it('logs backoff delay in recovery message', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.triggerRecovery('test');

      assert.ok(calls.log.some(m => m.includes('next backoff')));
    });
  });

  describe('process signal acceleration', () => {
    it('sends immediate probe after grace period when agentRunning transitions false→true', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering', signalGracePeriod: 30 });
      const now = Math.floor(Date.now() / 1000);
      engine.restartFailureCount = 3;
      engine.lastRecoveryAt = now; // just recovered, backoff would be 1500s

      // First tick: agentRunning = false (establishes baseline)
      engine.processHeartbeat(false, now);

      // Second tick: agentRunning = true (transition detected)
      engine.processHeartbeat(true, now + 1);
      assert.ok(engine.signalDetectedAt > 0);
      // Should NOT have sent probe yet (grace period not elapsed)
      assert.ok(!calls.enqueueHeartbeat.includes('post_restart'));

      // Third tick: grace period elapsed
      engine.processHeartbeat(true, now + 31);
      assert.ok(calls.enqueueHeartbeat.includes('post_restart'));
    });

    it('does not trigger on null→true (first tick)', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering', signalGracePeriod: 5 });
      const now = Math.floor(Date.now() / 1000);

      // First tick ever: null→true should NOT trigger
      engine.processHeartbeat(true, now);
      assert.equal(engine.signalDetectedAt, 0);
    });

    it('does not trigger when health is ok', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { signalGracePeriod: 5 });
      const now = Math.floor(Date.now() / 1000);

      engine.processHeartbeat(false, now);
      engine.processHeartbeat(true, now + 1);

      // Health is ok, signal should not be recorded
      assert.equal(engine.signalDetectedAt, 0);
    });

    it('works in DOWN state too', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'down', signalGracePeriod: 10 });
      const now = Math.floor(Date.now() / 1000);
      engine.lastDownCheckAt = now; // prevent regular down-check from firing

      engine.processHeartbeat(false, now);
      engine.processHeartbeat(true, now + 1);
      assert.ok(engine.signalDetectedAt > 0);

      engine.processHeartbeat(true, now + 15); // grace elapsed
      assert.ok(calls.enqueueHeartbeat.includes('post_restart'));
    });

    it('consumes signal after acceleration fires', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering', signalGracePeriod: 5 });
      const now = Math.floor(Date.now() / 1000);

      engine.processHeartbeat(false, now);
      engine.processHeartbeat(true, now + 1);
      engine.processHeartbeat(true, now + 10); // grace elapsed, fires

      assert.equal(engine.signalDetectedAt, 0); // consumed
    });

    it('resets signalDetectedAt on heartbeat success', () => {
      const { deps } = createMockDeps();
      deps._pending = { control_id: 1, phase: 'post_restart' };
      deps._heartbeatStatus = 'done';
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });
      engine.signalDetectedAt = 1000;

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.equal(engine.signalDetectedAt, 0);
    });
  });

  describe('runRecoveryProbe', () => {
    it('returns recovered immediately when health is ok', async () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      const result = await engine.runRecoveryProbe();

      assert.equal(result.recovered, true);
    });

    it('enqueues recovery heartbeat and transitions to ok on done', async () => {
      const { deps, calls } = createMockDeps();
      const pending = { control_id: 7, phase: 'recovery' };
      deps._pending = pending;
      deps._heartbeatStatus = 'done';
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });

      const result = await engine.runRecoveryProbe({ timeoutMs: 100, pollIntervalMs: 1 });

      assert.equal(result.recovered, true);
      assert.equal(engine.health, 'ok');
      assert.deepStrictEqual(calls.enqueueHeartbeat, []);
      assert.equal(calls.clearHeartbeatPending, 1);
    });

    it('returns enqueueFailed when no pending heartbeat can be created', async () => {
      const { deps } = createMockDeps();
      deps.enqueueHeartbeat = () => false;
      deps._pending = null;
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });

      const result = await engine.runRecoveryProbe({ timeoutMs: 100, pollIntervalMs: 1 });

      assert.equal(result.recovered, false);
      assert.equal(result.enqueueFailed, true);
    });

    it('restarts the session after auth_failed checkAuth succeeds', async () => {
      const { deps, calls } = createMockDeps();
      deps.checkAuth = async () => ({ ok: true });
      const engine = new HeartbeatEngine(deps, { initialHealth: 'auth_failed' });

      const result = await engine.runRecoveryProbe({ timeoutMs: 100, pollIntervalMs: 1 });

      assert.equal(result.recovered, false);
      assert.equal(result.health, 'unavailable');
      assert.equal(result.restartTriggered, true);
      assert.equal(engine.health, 'unavailable');
      assert.equal(engine.healthReason, 'auth_recovered_restart');
      assert.equal(calls.killTmuxSession, 1);
      assert.deepStrictEqual(calls.enqueueHeartbeat, []);
    });

    it('keeps auth_failed when direct auth check still fails', async () => {
      const { deps, calls } = createMockDeps();
      deps.checkAuth = async () => ({ ok: false, reason: 'auth_still_failed' });
      const engine = new HeartbeatEngine(deps, { initialHealth: 'auth_failed' });

      const result = await engine.runRecoveryProbe({ timeoutMs: 100, pollIntervalMs: 1 });

      assert.equal(result.recovered, false);
      assert.equal(result.health, 'auth_failed');
      assert.equal(result.reason, 'auth_still_failed');
      assert.equal(engine.health, 'auth_failed');
      assert.deepStrictEqual(calls.enqueueHeartbeat, []);
    });
  });

  describe('onUserMessageDelivered', () => {
    it('does nothing when health is not ok', async () => {
      const { deps, calls } = createMockDeps();
      let rateLimitScans = 0;
      deps.detectRateLimit = () => {
        rateLimitScans++;
        return { detected: true, cooldownUntil: 5000 };
      };
      const engine = new HeartbeatEngine(deps, {
        initialHealth: 'recovering',
        userMessageCheckDelayMs: 0
      });

      await engine.onUserMessageDelivered();

      assert.equal(rateLimitScans, 0);
      assert.equal(engine.health, 'recovering');
      assert.equal(calls.killTmuxSession, 0);
    });

    it('enters rate_limited after two OK-path rate-limit detections', async () => {
      const { deps } = createMockDeps();
      deps.detectRateLimit = () => ({ detected: true, cooldownUntil: 5000, resetTime: '7am' });
      const engine = new HeartbeatEngine(deps, { userMessageCheckDelayMs: 0 });

      await engine.onUserMessageDelivered();
      assert.equal(engine.health, 'ok');
      assert.equal(engine.rateLimitConsecutiveHits, 1);

      await engine.onUserMessageDelivered();
      assert.equal(engine.health, 'rate_limited');
      assert.equal(engine.cooldownUntil, 5000);
    });

    it('sets auth_failed when delivery-triggered auth check fails', async () => {
      const { deps } = createMockDeps();
      deps.detectRateLimit = () => ({ detected: false });
      deps.detectAuthFailure = () => ({ detected: true, pattern: 'authentication_error' });
      deps.checkAuth = async () => ({ ok: false, reason: 'cli_probe_authentication_error' });
      const engine = new HeartbeatEngine(deps, { userMessageCheckDelayMs: 0 });

      await engine.onUserMessageDelivered();

      assert.equal(engine.health, 'auth_failed');
      assert.equal(engine.healthReason, 'cli_probe_authentication_error');
    });

    it('kills the session after two sticky detections spaced by the debounce interval', async () => {
      const { deps, calls } = createMockDeps();
      let now = 1000;
      deps.detectRateLimit = () => ({ detected: false });
      deps.detectAuthFailure = () => ({ detected: false });
      deps.checkAuth = async () => ({ ok: true });
      deps.detectApiError = () => ({ detected: true, pattern: 'APIError: 400' });
      const engine = new HeartbeatEngine(deps, {
        userMessageCheckDelayMs: 0,
        now: () => now
      });

      await engine.onUserMessageDelivered();
      assert.equal(engine.health, 'ok');
      assert.equal(calls.killTmuxSession, 0);

      now += 30000;
      await engine.onUserMessageDelivered();

      assert.equal(engine.health, 'unavailable');
      assert.equal(engine.healthReason, 'sticky_context_restart');
      assert.equal(calls.killTmuxSession, 1);
    });

    it('resets OK-path counters after a clean delivery check', async () => {
      const { deps } = createMockDeps();
      deps.detectRateLimit = () => ({ detected: false });
      deps.detectAuthFailure = () => ({ detected: false });
      deps.checkAuth = async () => ({ ok: true });
      deps.detectApiError = () => ({ detected: false });
      const engine = new HeartbeatEngine(deps, { userMessageCheckDelayMs: 0 });
      engine.rateLimitConsecutiveHits = 1;
      engine.stickyErrorConsecutiveHits = 1;
      engine.lastStickyErrorHitAt = 1000;

      await engine.onUserMessageDelivered();

      assert.equal(engine.rateLimitConsecutiveHits, 0);
      assert.equal(engine.stickyErrorConsecutiveHits, 0);
      assert.equal(engine.lastStickyErrorHitAt, 0);
    });
  });

  describe('in-flight heartbeat handling', () => {
    it('processes stale pending normally even when primary heartbeat is disabled', () => {
      const { deps, calls } = createMockDeps();
      const now = Math.floor(Date.now() / 1000);
      deps._pending = { control_id: 1, phase: 'primary', created_at: now - 700 };
      deps._heartbeatStatus = 'timeout';
      const engine = new HeartbeatEngine(deps, { heartbeatEnabled: false });

      engine.processHeartbeat(true, now);

      // Stale pending is processed (treated as timeout), not silently cleared
      assert.deepStrictEqual(calls.getHeartbeatStatus, [1]);
      assert.equal(engine.health, 'unavailable');
    });

    it('does nothing when status is pending (fresh)', () => {
      const { deps, calls } = createMockDeps();
      const now = Math.floor(Date.now() / 1000);
      deps._pending = { control_id: 1, phase: 'primary', created_at: now - 10 };
      deps._heartbeatStatus = 'pending';
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, now);

      assert.equal(calls.clearHeartbeatPending, 0);
      assert.deepStrictEqual(calls.enqueueHeartbeat, []);
      assert.equal(calls.killTmuxSession, 0);
    });

    it('does nothing when status is running (fresh)', () => {
      const { deps, calls } = createMockDeps();
      const now = Math.floor(Date.now() / 1000);
      deps._pending = { control_id: 1, phase: 'primary', created_at: now - 10 };
      deps._heartbeatStatus = 'running';
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, now);

      assert.equal(calls.clearHeartbeatPending, 0);
    });

    it('treats stale pending as timeout', () => {
      const { deps, calls } = createMockDeps();
      const now = Math.floor(Date.now() / 1000);
      deps._pending = { control_id: 1, phase: 'primary', created_at: now - 700 };
      deps._heartbeatStatus = 'pending';
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, now);

      assert.equal(calls.clearHeartbeatPending, 1);
      assert.ok(calls.log.some(m => m.includes('pending too long')));
    });

    it('treats unexpected status as failure', () => {
      const { deps, calls } = createMockDeps();
      const now = Math.floor(Date.now() / 1000);
      deps._pending = { control_id: 1, phase: 'primary', created_at: now - 700 };
      deps._heartbeatStatus = 'bizarre';
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, now);

      assert.equal(calls.clearHeartbeatPending, 1);
      assert.ok(calls.log.some(m => m.includes('unexpected_bizarre') || m.includes('pending too long')));
    });
  });

  describe('recovering state', () => {
    it('enqueues recovery heartbeat when agent is running (no prior failures)', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.deepStrictEqual(calls.enqueueHeartbeat, ['recovery']);
    });

    it('still enqueues recovery heartbeat when primary heartbeat is disabled', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering', heartbeatEnabled: false });

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.deepStrictEqual(calls.enqueueHeartbeat, ['recovery']);
    });
  });

  describe('unavailable state', () => {
    it('enqueues recovery heartbeat when agent is running', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'unavailable' });

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.deepStrictEqual(calls.enqueueHeartbeat, ['recovery']);
    });

    it('sends post-restart probe after process signal grace', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'unavailable', signalGracePeriod: 5 });
      const now = Math.floor(Date.now() / 1000);
      engine.restartFailureCount = 3;
      engine.lastRecoveryAt = now;

      engine.processHeartbeat(false, now);
      engine.processHeartbeat(true, now + 1);
      engine.processHeartbeat(true, now + 10);

      assert.ok(calls.enqueueHeartbeat.includes('post_restart'));
    });
  });

  describe('onProcessRestarted', () => {
    it('resets recovery backoff and schedules post-restart probe for non-ok health', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'unavailable', signalGracePeriod: 5 });
      engine.restartFailureCount = 3;
      engine.lastRecoveryAt = 100;

      engine.onProcessRestarted(200);
      engine.processHeartbeat(true, 206);

      assert.equal(engine.restartFailureCount, 0);
      assert.equal(engine.lastRecoveryAt, 0);
      assert.deepStrictEqual(calls.enqueueHeartbeat, ['post_restart']);
    });

    it('runs the post-restart probe without a monitor tick', async () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'unavailable', postRestartProbeDelayMs: 0 });

      engine.onProcessRestarted(200);
      await new Promise(resolve => setTimeout(resolve, 0));

      assert.deepStrictEqual(calls.enqueueHeartbeat, ['post_restart']);
    });

    it('does not schedule a post-restart probe while health is ok', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { signalGracePeriod: 5 });

      engine.onProcessRestarted(200);
      engine.processHeartbeat(true, 206);

      assert.deepStrictEqual(calls.enqueueHeartbeat, []);
    });
  });

  describe('setHealth', () => {
    it('does nothing when state is unchanged', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps);
      assert.equal(engine.health, 'ok');

      engine.setHealth('ok', 'no change');

      assert.deepStrictEqual(calls.log, []);
    });

    it('logs transition with reason', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.setHealth('recovering', 'primary_timeout');

      assert.ok(calls.log.some(m => m.includes('OK') && m.includes('RECOVERING') && m.includes('primary_timeout')));
      assert.equal(engine.health, 'recovering');
    });

    it('tracks non-ok reasons and clears them on recovery to ok', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.setHealth('recovering', 'heartbeat_timeout');
      assert.equal(engine.healthReason, 'heartbeat_timeout');

      engine.setHealth('ok', 'heartbeat_ack phase=recovery');
      assert.equal(engine.healthReason, '');
    });

    it('tracks unavailableSince for public unavailable health and clears it on recovery', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.setHealth('unavailable', 'heartbeat_timeout');
      assert.ok(engine.unavailableSince > 0);
      const unavailableSince = engine.unavailableSince;

      engine.setHealth('down', 'continuous_failure');
      assert.equal(engine.unavailableSince, unavailableSince);

      engine.setHealth('ok', 'heartbeat_ack phase=recovery');
      assert.equal(engine.unavailableSince, 0);
    });
  });

  describe('rate_limited state', () => {
    it('enterRateLimited transitions from ok to rate_limited', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.enterRateLimited(2000, '7am');

      assert.equal(engine.health, 'rate_limited');
      assert.equal(engine.cooldownUntil, 2000);
      assert.equal(engine.rateLimitResetTime, '7am');
      assert.ok(calls.log.some(m => m.includes('RATE_LIMITED') && m.includes('7am')));
    });

    it('enterRateLimited transitions from recovering to rate_limited', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });

      engine.enterRateLimited(2000, '8am');

      assert.equal(engine.health, 'rate_limited');
      assert.equal(engine.restartFailureCount, 0);
      assert.equal(engine.recoveringStartedAt, 0);
    });

    it('enterRateLimited extends cooldown if already rate_limited with later time', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.enterRateLimited(2000, '7am');
      engine.enterRateLimited(3000, '8am');

      assert.equal(engine.cooldownUntil, 3000);
      assert.equal(engine.rateLimitResetTime, '8am');
      assert.ok(calls.log.some(m => m.includes('extended')));
    });

    it('enterRateLimited does not shorten cooldown', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.enterRateLimited(3000, '8am');
      engine.enterRateLimited(2000, '7am');

      assert.equal(engine.cooldownUntil, 3000);
      assert.equal(engine.rateLimitResetTime, '8am');
    });

    it('waits during cooldown period', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.enterRateLimited(2000, '7am');
      engine.processHeartbeat(true, 1500);

      assert.equal(calls.enqueueHeartbeat.length, 0);
      assert.equal(calls.killTmuxSession, 0);
    });

    it('keeps session alive and waits for recovery trigger when cooldown expires', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.enterRateLimited(2000, '7am');
      engine.processHeartbeat(true, 2001);

      assert.equal(calls.killTmuxSession, 0);
      assert.equal(engine.health, 'rate_limited');
      assert.equal(engine.cooldownUntil, 0);
      assert.ok(calls.log.some(m => m.includes('waiting for next recovery trigger')));
    });

    it('expires rate-limit cooldown without a monitor tick and keeps session alive', async () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { now: () => 1000 });

      engine.enterRateLimited(1, '7am');
      await new Promise(resolve => setTimeout(resolve, 0));

      assert.equal(calls.killTmuxSession, 0);
      assert.equal(engine.health, 'rate_limited');
      assert.equal(engine.cooldownUntil, 0);
    });

    it('recovers to ok on heartbeat success after rate limit', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.enterRateLimited(2000, '7am');
      deps._pending = { control_id: 1, phase: 'rate-limit-recovery', created_at: 2000 };
      deps._heartbeatStatus = 'done';
      engine.processHeartbeat(true, 2005);

      assert.equal(engine.health, 'ok');
      assert.equal(engine.cooldownUntil, 0);
      assert.equal(engine.rateLimitResetTime, '');
    });

    it('transitions rate_limited to unavailable when recovery fails without rate-limit signal', () => {
      const { deps, calls } = createMockDeps();
      deps.detectRateLimit = () => ({ detected: false });
      const engine = new HeartbeatEngine(deps);

      engine.enterRateLimited(2000, '7am');
      deps._pending = { control_id: 1, phase: 'recovery', created_at: 2000 };
      deps._heartbeatStatus = 'failed';
      engine.processHeartbeat(true, 2005);

      assert.equal(engine.health, 'unavailable');
      assert.equal(calls.killTmuxSession, 0);
      assert.ok(calls.log.some(m => m.includes('Rate limit recovery failed')));
    });

    it('stays rate_limited when recovery still sees rate-limit signal', () => {
      const { deps, calls } = createMockDeps();
      deps.detectRateLimit = () => ({ detected: true, cooldownUntil: 5000, resetTime: '8am' });
      const engine = new HeartbeatEngine(deps);

      engine.enterRateLimited(2000, '7am');
      deps._pending = { control_id: 1, phase: 'recovery', created_at: 2000 };
      deps._heartbeatStatus = 'failed';
      engine.processHeartbeat(true, 2005);

      assert.equal(engine.health, 'rate_limited');
      assert.equal(engine.cooldownUntil, 5000);
      assert.equal(engine.rateLimitResetTime, '8am');
      assert.equal(calls.killTmuxSession, 0);
    });

    it('triggerRecovery is skipped in rate_limited state', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.enterRateLimited(2000, '7am');
      engine.triggerRecovery('test_reason');

      assert.equal(engine.health, 'rate_limited');
      assert.equal(calls.killTmuxSession, 0);
      assert.ok(calls.log.some(m => m.includes('skipped in RATE_LIMITED')));
    });

    it('does not enqueue heartbeat when agentRunning is false and rate_limited', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.enterRateLimited(2000, '7am');
      engine.processHeartbeat(false, 2001);

      assert.equal(calls.enqueueHeartbeat.length, 0);
    });
  });

  describe('notifyUserMessage', () => {
    it('triggers recovery when rate_limited and cooldown elapsed', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { userMessageRecoveryCooldown: 300 });

      engine.enterRateLimited(5000, '7am');
      const result = engine.notifyUserMessage(3000);

      assert.equal(result, true);
      assert.equal(engine.cooldownUntil, 0);
      assert.ok(calls.log.some(m => m.includes('User message triggered')));
    });

    it('respects cooldown between user message triggers', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { userMessageRecoveryCooldown: 300 });

      engine.enterRateLimited(5000, '7am');
      engine.notifyUserMessage(3000);

      // Re-enter rate limited (simulate recovery failed)
      engine.enterRateLimited(6000, '8am');
      const result = engine.notifyUserMessage(3100);

      assert.equal(result, false);
      assert.ok(calls.log.some(m => m.includes('cooldown')));
    });

    it('allows trigger after cooldown period elapsed', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { userMessageRecoveryCooldown: 300 });

      engine.enterRateLimited(5000, '7am');
      engine.notifyUserMessage(3000);

      engine.enterRateLimited(6000, '8am');
      const result = engine.notifyUserMessage(3301);

      assert.equal(result, true);
    });

    it('returns false when not rate_limited', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      const result = engine.notifyUserMessage(1000);

      assert.equal(result, false);
    });

    it('clears user message recovery state on heartbeat success', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { userMessageRecoveryCooldown: 300 });

      engine.enterRateLimited(5000, '7am');
      engine.notifyUserMessage(3000);

      // Simulate heartbeat success
      deps._pending = { control_id: 1, phase: 'rate-limit-recovery', created_at: 3000 };
      deps._heartbeatStatus = 'done';
      engine.processHeartbeat(true, 3005);

      assert.equal(engine.lastUserMessageRecoveryAt, 0);
    });
  });

  describe('rate_limited initialHealth', () => {
    it('starts in rate_limited state when initialHealth is rate_limited', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'rate_limited' });

      assert.equal(engine.health, 'rate_limited');
    });
  });

  describe('behavioral rate limit detection (dual-signal)', () => {
    it('enters rate_limited when heartbeat fails and detectRateLimit returns detected', () => {
      const { deps, calls } = createMockDeps();
      deps.detectRateLimit = () => ({ detected: true, cooldownUntil: 5000, resetTime: '7am' });
      deps._pending = { control_id: 1, phase: 'primary', created_at: 1000 };
      deps._heartbeatStatus = 'timeout';
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, 1500);

      assert.equal(engine.health, 'rate_limited');
      assert.equal(engine.cooldownUntil, 5000);
      assert.equal(engine.rateLimitResetTime, '7am');
      assert.equal(calls.killTmuxSession, 0); // no kill — rate limited, not recovery
    });

    it('triggers normal recovery when heartbeat fails and detectRateLimit returns not detected', () => {
      const { deps, calls } = createMockDeps();
      deps.detectRateLimit = () => ({ detected: false });
      deps._pending = { control_id: 1, phase: 'primary', created_at: 1000 };
      deps._heartbeatStatus = 'timeout';
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, 1500);

      assert.equal(engine.health, 'unavailable');
      assert.equal(calls.killTmuxSession, 1);
    });

    it('checks rate limit on recovering heartbeat failure too', () => {
      const { deps, calls } = createMockDeps();
      deps.detectRateLimit = () => ({ detected: true, cooldownUntil: 6000, resetTime: '8am' });
      deps._pending = { control_id: 1, phase: 'recovery', created_at: 1000 };
      deps._heartbeatStatus = 'failed';
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });

      engine.processHeartbeat(true, 1500);

      assert.equal(engine.health, 'rate_limited');
      assert.equal(engine.cooldownUntil, 6000);
    });

    it('does not check rate limit when detectRateLimit dep is not provided', () => {
      const { deps, calls } = createMockDeps();
      // No detectRateLimit dep — should proceed with normal recovery
      deps._pending = { control_id: 1, phase: 'primary', created_at: 1000 };
      deps._heartbeatStatus = 'timeout';
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, 1500);

      assert.equal(engine.health, 'unavailable');
      assert.equal(calls.killTmuxSession, 1);
    });

    it('does not check rate limit in down state', () => {
      let detectCalled = false;
      const { deps, calls } = createMockDeps();
      deps.detectRateLimit = () => { detectCalled = true; return { detected: true, cooldownUntil: 5000 }; };
      deps._pending = { control_id: 1, phase: 'down-check', created_at: 1000 };
      deps._heartbeatStatus = 'failed';
      const engine = new HeartbeatEngine(deps, { initialHealth: 'down' });

      engine.processHeartbeat(true, 1500);

      assert.equal(detectCalled, false);
      assert.equal(engine.health, 'down');
    });
  });

  describe('API error fast-detection', () => {
    it('triggers recovery when API error detected and pending age > 30s', () => {
      const { deps, calls } = createMockDeps();
      const now = Math.floor(Date.now() / 1000);
      deps._pending = { control_id: 1, phase: 'primary', created_at: now - 40 };
      deps._heartbeatStatus = 'pending';
      deps.detectApiError = () => ({ detected: true, pattern: 'APIError: 400' });
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, now);

      assert.equal(calls.killTmuxSession, 1);
      assert.equal(engine.health, 'unavailable');
      assert.ok(calls.log.some(m => m.includes('API error detected') && m.includes('APIError: 400')));
    });

    it('does not scan when pending age < 30s', () => {
      let scanCalled = false;
      const { deps, calls } = createMockDeps();
      const now = Math.floor(Date.now() / 1000);
      deps._pending = { control_id: 1, phase: 'primary', created_at: now - 10 };
      deps._heartbeatStatus = 'pending';
      deps.detectApiError = () => { scanCalled = true; return { detected: false }; };
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, now);

      assert.equal(scanCalled, false);
      assert.equal(calls.killTmuxSession, 0);
    });

    it('throttles scans to once per 15 seconds', () => {
      let scanCount = 0;
      const { deps } = createMockDeps();
      const now = Math.floor(Date.now() / 1000);
      deps._pending = { control_id: 1, phase: 'primary', created_at: now - 50 };
      deps._heartbeatStatus = 'pending';
      deps.detectApiError = () => { scanCount++; return { detected: false }; };
      const engine = new HeartbeatEngine(deps);

      // First call: should scan
      engine.processHeartbeat(true, now);
      assert.equal(scanCount, 1);

      // Second call 5 seconds later: should NOT scan (throttled)
      engine.processHeartbeat(true, now + 5);
      assert.equal(scanCount, 1);

      // Third call 16 seconds later: should scan again
      engine.processHeartbeat(true, now + 16);
      assert.equal(scanCount, 2);
    });

    it('does not scan when detectApiError dep is absent', () => {
      const { deps, calls } = createMockDeps();
      const now = Math.floor(Date.now() / 1000);
      deps._pending = { control_id: 1, phase: 'primary', created_at: now - 40 };
      deps._heartbeatStatus = 'pending';
      // No detectApiError dep
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, now);

      assert.equal(calls.killTmuxSession, 0);
      assert.equal(engine.health, 'ok');
    });

    it('does not trigger when no API error detected', () => {
      const { deps, calls } = createMockDeps();
      const now = Math.floor(Date.now() / 1000);
      deps._pending = { control_id: 1, phase: 'primary', created_at: now - 40 };
      deps._heartbeatStatus = 'pending';
      deps.detectApiError = () => ({ detected: false });
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, now);

      assert.equal(calls.killTmuxSession, 0);
      assert.equal(engine.health, 'ok');
    });
  });
});
