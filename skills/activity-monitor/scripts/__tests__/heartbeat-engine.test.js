import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HeartbeatEngine } from '../heartbeat-engine.js';

function createMockDeps() {
  const calls = {
    enqueueHeartbeat: [],
    getHeartbeatStatus: [],
    readHeartbeatPending: [],
    clearHeartbeatPending: 0,
    killTmuxSession: 0,
    notifyPendingChannels: 0,
    log: []
  };

  const deps = {
    enqueueHeartbeat: (phase) => { calls.enqueueHeartbeat.push(phase); return true; },
    getHeartbeatStatus: (id) => { calls.getHeartbeatStatus.push(id); return deps._heartbeatStatus || 'pending'; },
    readHeartbeatPending: () => { calls.readHeartbeatPending.push(true); return deps._pending || null; },
    clearHeartbeatPending: () => { calls.clearHeartbeatPending++; },
    killTmuxSession: () => { calls.killTmuxSession++; },
    notifyPendingChannels: () => { calls.notifyPendingChannels++; },
    log: (msg) => { calls.log.push(msg); },
    // Test helpers
    _pending: null,
    _heartbeatStatus: 'pending'
  };

  return { deps, calls };
}

describe('HeartbeatEngine', () => {
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

    it('does not enqueue when claude is not running', () => {
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

      // lastHeartbeatAt should be updated to ~now
      const diff = Math.abs(engine.lastHeartbeatAt - Math.floor(Date.now() / 1000));
      assert.ok(diff <= 1, `lastHeartbeatAt should be updated to current time, diff=${diff}`);
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

    it('transitions recovering to ok and notifies channels', () => {
      const { deps, calls } = createMockDeps();
      deps._pending = { control_id: 1, phase: 'recovery' };
      deps._heartbeatStatus = 'done';
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.equal(engine.health, 'ok');
      assert.equal(calls.notifyPendingChannels, 1);
    });

    it('does not notify channels when already ok', () => {
      const { deps, calls } = createMockDeps();
      deps._pending = { control_id: 1, phase: 'primary' };
      deps._heartbeatStatus = 'done';
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.equal(engine.health, 'ok');
      assert.equal(calls.notifyPendingChannels, 0);
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
      assert.equal(engine.health, 'recovering');
    });

    it('does not enqueue verify phase', () => {
      const { deps, calls } = createMockDeps();
      deps._pending = { control_id: 1, phase: 'primary' };
      deps._heartbeatStatus = 'timeout';
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      // Should NOT have 'verify' in the enqueue calls
      assert.ok(!calls.enqueueHeartbeat.includes('verify'));
    });
  });

  describe('stuck probe failure triggers recovery', () => {
    it('triggers recovery when stuck probe fails in ok state', () => {
      const { deps, calls } = createMockDeps();
      deps._pending = { control_id: 1, phase: 'stuck' };
      deps._heartbeatStatus = 'timeout';
      const engine = new HeartbeatEngine(deps);

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.equal(calls.clearHeartbeatPending, 1);
      assert.equal(calls.killTmuxSession, 1);
      assert.equal(engine.health, 'recovering');
    });
  });

  describe('recovery failure leads to down', () => {
    it('transitions to down after max restart failures', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, {
        initialHealth: 'recovering',
        maxRestartFailures: 3
      });

      engine.triggerRecovery('fail_1');
      assert.equal(engine.health, 'recovering');
      assert.equal(calls.killTmuxSession, 1);

      engine.triggerRecovery('fail_2');
      assert.equal(engine.health, 'recovering');
      assert.equal(calls.killTmuxSession, 2);

      engine.triggerRecovery('fail_3');
      assert.equal(engine.health, 'down');
      assert.equal(calls.killTmuxSession, 3);
      assert.equal(engine.restartFailureCount, 3);
    });
  });

  describe('down state behavior', () => {
    it('enqueues down-check after retry interval', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'down', downRetryInterval: 1800 });
      const now = Math.floor(Date.now() / 1000);
      engine.lastDownCheckAt = now - 1801;

      engine.processHeartbeat(true, now);

      assert.deepStrictEqual(calls.enqueueHeartbeat, ['down-check']);
    });

    it('skips down-check during retry cooldown', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'down', downRetryInterval: 1800 });
      const now = Math.floor(Date.now() / 1000);
      engine.lastDownCheckAt = now - 60; // only 60s ago

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
      assert.equal(calls.notifyPendingChannels, 1);
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

    it('transitions ok to recovering', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps);
      assert.equal(engine.health, 'ok');

      engine.triggerRecovery('test_reason');

      assert.equal(engine.health, 'recovering');
    });

    it('sets lastRecoveryAt on recovery', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps);
      assert.equal(engine.lastRecoveryAt, 0);

      engine.triggerRecovery('test');

      assert.ok(engine.lastRecoveryAt > 0);
    });

    it('sets lastDownCheckAt when entering down state', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { maxRestartFailures: 1 });
      assert.equal(engine.lastDownCheckAt, 0);

      engine.triggerRecovery('test');

      assert.equal(engine.health, 'down');
      assert.ok(engine.lastDownCheckAt > 0);
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
  });

  describe('requestImmediateProbe', () => {
    it('enqueues stuck phase when health is ok and no pending', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      const result = engine.requestImmediateProbe('no_activity_for_300s');

      assert.equal(result, true);
      assert.deepStrictEqual(calls.enqueueHeartbeat, ['stuck']);
    });

    it('returns false when health is not ok', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });

      const result = engine.requestImmediateProbe('test');

      assert.equal(result, false);
      assert.deepStrictEqual(calls.enqueueHeartbeat, []);
    });

    it('returns false when another heartbeat is pending', () => {
      const { deps, calls } = createMockDeps();
      deps._pending = { control_id: 1, phase: 'primary' };
      const engine = new HeartbeatEngine(deps);

      const result = engine.requestImmediateProbe('test');

      assert.equal(result, false);
      assert.deepStrictEqual(calls.enqueueHeartbeat, []);
    });

    it('updates lastHeartbeatAt on successful stuck enqueue', () => {
      const { deps } = createMockDeps();
      const engine = new HeartbeatEngine(deps);
      engine.lastHeartbeatAt = 0;

      engine.requestImmediateProbe('test');

      assert.ok(engine.lastHeartbeatAt > 0);
    });

    it('logs stuck detection reason', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps);

      engine.requestImmediateProbe('no_activity_for_600s');

      assert.ok(calls.log.some(m => m.includes('Stuck detection') && m.includes('no_activity_for_600s')));
    });
  });

  describe('in-flight heartbeat handling', () => {
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
    it('enqueues recovery heartbeat when claude is running (no prior failures)', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });

      engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

      assert.deepStrictEqual(calls.enqueueHeartbeat, ['recovery']);
    });

    it('delays recovery heartbeat during backoff period', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });
      const now = Math.floor(Date.now() / 1000);
      engine.restartFailureCount = 2; // backoff = min(2*60, 300) = 120s
      engine.lastRecoveryAt = now - 60; // only 60s ago

      engine.processHeartbeat(true, now);

      assert.deepStrictEqual(calls.enqueueHeartbeat, []);
    });

    it('allows recovery heartbeat after backoff period', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });
      const now = Math.floor(Date.now() / 1000);
      engine.restartFailureCount = 2; // backoff = 120s
      engine.lastRecoveryAt = now - 121; // 121s ago > 120s

      engine.processHeartbeat(true, now);

      assert.deepStrictEqual(calls.enqueueHeartbeat, ['recovery']);
    });

    it('caps backoff at 300 seconds', () => {
      const { deps, calls } = createMockDeps();
      const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });
      const now = Math.floor(Date.now() / 1000);
      engine.restartFailureCount = 10; // backoff = min(10*60, 300) = 300s
      engine.lastRecoveryAt = now - 301;

      engine.processHeartbeat(true, now);

      assert.deepStrictEqual(calls.enqueueHeartbeat, ['recovery']);
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
  });

  describe('rate_limited state', () => {
    describe('enterRateLimited', () => {
      it('transitions from ok to rate_limited', () => {
        const { deps, calls } = createMockDeps();
        const engine = new HeartbeatEngine(deps);

        engine.enterRateLimited();

        assert.equal(engine.health, 'rate_limited');
        assert.ok(calls.log.some(m => m.includes('RATE_LIMITED') && m.includes('api_rate_limit')));
      });

      it('sets rateLimitResetAt when resetSeconds provided', () => {
        const { deps } = createMockDeps();
        const engine = new HeartbeatEngine(deps);
        const before = Math.floor(Date.now() / 1000);

        engine.enterRateLimited(120);

        assert.equal(engine.health, 'rate_limited');
        assert.ok(engine.rateLimitResetAt >= before + 120);
        assert.ok(engine.rateLimitResetAt <= before + 121);
      });

      it('resets restartFailureCount', () => {
        const { deps } = createMockDeps();
        const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });
        engine.restartFailureCount = 2;

        engine.enterRateLimited();

        assert.equal(engine.restartFailureCount, 0);
      });

      it('is idempotent when already rate_limited', () => {
        const { deps, calls } = createMockDeps();
        const engine = new HeartbeatEngine(deps);

        engine.enterRateLimited(60);
        const firstResetAt = engine.rateLimitResetAt;
        calls.log.length = 0; // Clear logs

        engine.enterRateLimited(); // No new reset time

        assert.equal(engine.health, 'rate_limited');
        assert.equal(engine.rateLimitResetAt, firstResetAt); // Unchanged
        assert.deepStrictEqual(calls.log, []); // No transition logged
      });

      it('updates resetAt when called again with new value', () => {
        const { deps } = createMockDeps();
        const engine = new HeartbeatEngine(deps);

        engine.enterRateLimited(60);
        const firstResetAt = engine.rateLimitResetAt;

        engine.enterRateLimited(300);

        assert.ok(engine.rateLimitResetAt > firstResetAt);
      });

      it('transitions from recovering to rate_limited', () => {
        const { deps } = createMockDeps();
        const engine = new HeartbeatEngine(deps, { initialHealth: 'recovering' });

        engine.enterRateLimited();

        assert.equal(engine.health, 'rate_limited');
      });

      it('transitions from down to rate_limited', () => {
        const { deps } = createMockDeps();
        const engine = new HeartbeatEngine(deps, { initialHealth: 'down' });

        engine.enterRateLimited();

        assert.equal(engine.health, 'rate_limited');
      });
    });

    describe('processHeartbeat in rate_limited', () => {
      it('probes after rateLimitedProbeInterval', () => {
        const { deps, calls } = createMockDeps();
        const engine = new HeartbeatEngine(deps, {
          initialHealth: 'rate_limited',
          rateLimitedProbeInterval: 300
        });
        const now = Math.floor(Date.now() / 1000);
        engine.lastRateLimitedCheckAt = now - 301;

        engine.processHeartbeat(true, now);

        assert.deepStrictEqual(calls.enqueueHeartbeat, ['rate-limit-check']);
      });

      it('skips probe during cooldown', () => {
        const { deps, calls } = createMockDeps();
        const engine = new HeartbeatEngine(deps, {
          initialHealth: 'rate_limited',
          rateLimitedProbeInterval: 300
        });
        const now = Math.floor(Date.now() / 1000);
        engine.lastRateLimitedCheckAt = now - 60;

        engine.processHeartbeat(true, now);

        assert.deepStrictEqual(calls.enqueueHeartbeat, []);
      });

      it('does not probe when claude is not running', () => {
        const { deps, calls } = createMockDeps();
        const engine = new HeartbeatEngine(deps, {
          initialHealth: 'rate_limited',
          rateLimitedProbeInterval: 300
        });
        const now = Math.floor(Date.now() / 1000);
        engine.lastRateLimitedCheckAt = now - 301;

        engine.processHeartbeat(false, now);

        assert.deepStrictEqual(calls.enqueueHeartbeat, []);
      });
    });

    describe('heartbeat success recovers from rate_limited', () => {
      it('transitions to ok and notifies channels', () => {
        const { deps, calls } = createMockDeps();
        deps._pending = { control_id: 1, phase: 'rate-limit-check' };
        deps._heartbeatStatus = 'done';
        const engine = new HeartbeatEngine(deps, { initialHealth: 'rate_limited' });

        engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

        assert.equal(engine.health, 'ok');
        assert.equal(calls.notifyPendingChannels, 1);
      });
    });

    describe('heartbeat failure stays rate_limited (no escalation)', () => {
      it('stays rate_limited on timeout (no kill)', () => {
        const { deps, calls } = createMockDeps();
        deps._pending = { control_id: 1, phase: 'rate-limit-check' };
        deps._heartbeatStatus = 'timeout';
        const engine = new HeartbeatEngine(deps, { initialHealth: 'rate_limited' });

        engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

        assert.equal(engine.health, 'rate_limited');
        assert.equal(calls.killTmuxSession, 0);
      });

      it('stays rate_limited on failed (no kill)', () => {
        const { deps, calls } = createMockDeps();
        deps._pending = { control_id: 1, phase: 'rate-limit-check' };
        deps._heartbeatStatus = 'failed';
        const engine = new HeartbeatEngine(deps, { initialHealth: 'rate_limited' });

        engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

        assert.equal(engine.health, 'rate_limited');
        assert.equal(calls.killTmuxSession, 0);
      });

      it('logs waiting message on failure', () => {
        const { deps, calls } = createMockDeps();
        deps._pending = { control_id: 1, phase: 'rate-limit-check' };
        deps._heartbeatStatus = 'timeout';
        const engine = new HeartbeatEngine(deps, { initialHealth: 'rate_limited' });

        engine.processHeartbeat(true, Math.floor(Date.now() / 1000));

        assert.ok(calls.log.some(m => m.includes('RATE_LIMITED') && m.includes('waiting for rate limit to clear')));
      });
    });

    describe('triggerRecovery skipped in rate_limited', () => {
      it('does not kill tmux or increment failure count', () => {
        const { deps, calls } = createMockDeps();
        const engine = new HeartbeatEngine(deps, { initialHealth: 'rate_limited' });

        engine.triggerRecovery('should_skip');

        assert.equal(calls.killTmuxSession, 0);
        assert.equal(engine.restartFailureCount, 0);
        assert.equal(engine.health, 'rate_limited');
      });

      it('logs skip message', () => {
        const { deps, calls } = createMockDeps();
        const engine = new HeartbeatEngine(deps, { initialHealth: 'rate_limited' });

        engine.triggerRecovery('my_reason');

        assert.ok(calls.log.some(m => m.includes('RATE_LIMITED') && m.includes('my_reason')));
      });
    });

    describe('requestImmediateProbe rejected in rate_limited', () => {
      it('returns false', () => {
        const { deps, calls } = createMockDeps();
        const engine = new HeartbeatEngine(deps, { initialHealth: 'rate_limited' });

        const result = engine.requestImmediateProbe('test');

        assert.equal(result, false);
        assert.deepStrictEqual(calls.enqueueHeartbeat, []);
      });
    });

    describe('initial health rate_limited', () => {
      it('sets lastRateLimitedCheckAt to now on construction', () => {
        const { deps } = createMockDeps();
        const before = Math.floor(Date.now() / 1000);
        const engine = new HeartbeatEngine(deps, { initialHealth: 'rate_limited' });
        const after = Math.floor(Date.now() / 1000);

        assert.ok(engine.lastRateLimitedCheckAt >= before);
        assert.ok(engine.lastRateLimitedCheckAt <= after);
      });

      it('does not set lastRateLimitedCheckAt for non-rate_limited health', () => {
        const { deps } = createMockDeps();
        const engine = new HeartbeatEngine(deps, { initialHealth: 'ok' });

        assert.equal(engine.lastRateLimitedCheckAt, 0);
      });
    });
  });
});
