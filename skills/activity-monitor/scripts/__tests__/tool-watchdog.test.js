import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  WATCHDOG_INTERRUPT_AVAILABLE_IN_SEC,
  evaluateToolWatchdogTransition
} from '../tool-watchdog.js';

function createRule() {
  return {
    id: 'web-tools-timeout',
    watchdog: {
      enabled: true,
      maxRuntimeSec: 3600,
      interruptKey: 'Escape',
      interruptGraceSec: 30,
      cooldownSec: 15,
      escalation: 'guardian_restart',
    }
  };
}

function createCandidate(overrides = {}) {
  return {
    event_id: 'toolu_123',
    name: 'WebFetch',
    rule_id: 'web-tools-timeout',
    started_at: 1_000,
    summary: { type: 'url-host', value: 'example.com' },
    ...overrides,
  };
}

function createForegroundIdentity(overrides = {}) {
  return {
    trusted: true,
    sessionId: 'session-1',
    claudePid: 4242,
    blockReason: null,
    ...overrides,
  };
}

function createState(overrides = {}) {
  return {
    watchdogState: null,
    runtimeLaunchAtMs: 0,
    launchGracePeriodSec: 180,
    engineHealth: 'ok',
    ...overrides,
  };
}

function createDeps(overrides = {}) {
  const calls = {
    cleared: 0,
    writes: 0,
    hints: [],
    recoveries: [],
    logs: [],
    enqueues: [],
  };

  return {
    calls,
    deps: {
      canTreatPaneAsRecovered: () => false,
      getRuleById: () => createRule(),
      clearWatchdogState: () => {
        calls.cleared += 1;
      },
      writeWatchdogState: () => {
        calls.writes += 1;
      },
      applySyntheticClearHint: (...args) => {
        calls.hints.push(args);
      },
      enqueueInterrupt: (key) => {
        calls.enqueues.push(key);
        return { ok: true, output: '' };
      },
      triggerRecovery: (reason) => {
        calls.recoveries.push(reason);
      },
      log: (message) => {
        calls.logs.push(message);
      },
      ...overrides,
    }
  };
}

describe('tool-watchdog', () => {
  it('exports a named available-in constant for watchdog interrupts', () => {
    assert.equal(WATCHDOG_INTERRUPT_AVAILABLE_IN_SEC, 1);
  });

  it('blocks and clears state when foreground identity is untrusted', () => {
    const state = createState({ watchdogState: { episode_key: 'old' } });
    const { deps, calls } = createDeps({
      clearWatchdogState: () => {
        calls.cleared += 1;
        state.watchdogState = null;
      }
    });

    const phase = evaluateToolWatchdogTransition({
      nowMs: 5_000,
      foregroundIdentity: createForegroundIdentity({ trusted: false, blockReason: 'missing_foreground_identity' }),
      apiActivity: { watchdog_candidate_tool: createCandidate() },
      interactiveState: {},
      state,
      deps,
    });

    assert.equal(phase.watchdog_phase, 'idle');
    assert.equal(phase.watchdog_block_reason, 'missing_foreground_identity');
    assert.equal(calls.cleared, 1);
    assert.equal(state.watchdogState, null);
  });

  it('sends an interrupt and persists watchdog state when a tool times out', () => {
    const state = createState();
    const { deps, calls } = createDeps({
      writeWatchdogState: () => {
        calls.writes += 1;
      }
    });

    const phase = evaluateToolWatchdogTransition({
      nowMs: 3_700_000,
      foregroundIdentity: createForegroundIdentity(),
      apiActivity: { watchdog_candidate_tool: createCandidate() },
      interactiveState: {},
      state,
      deps,
    });

    assert.equal(phase.watchdog_phase, 'interrupt_sent');
    assert.equal(calls.enqueues.length, 1);
    assert.equal(calls.writes, 1);
    assert.equal(state.watchdogState?.interrupt_key, 'Escape');
    assert.equal(state.watchdogState?.interrupt_sent_at, 3_700_000);
    assert.equal(state.watchdogState?.interrupt_count, 1);
  });

  it('clears state without a redundant write when the pane is interactively recovered', () => {
    const state = createState({
      watchdogState: {
        episode_key: 'toolu_123',
        interrupt_sent_at: 3_700_000,
        grace_deadline_at: 3_730_000,
        retry_after_at: 0,
        escalated_at: 0,
      }
    });
    const { deps, calls } = createDeps({
      canTreatPaneAsRecovered: () => true,
      clearWatchdogState: () => {
        calls.cleared += 1;
        state.watchdogState = null;
      }
    });

    const phase = evaluateToolWatchdogTransition({
      nowMs: 3_705_000,
      foregroundIdentity: createForegroundIdentity(),
      apiActivity: { watchdog_candidate_tool: createCandidate() },
      interactiveState: { promptVisible: true },
      state,
      deps,
    });

    assert.equal(phase.watchdog_phase, 'recovered');
    assert.equal(phase.api_activity_dirty, true);
    assert.equal(calls.hints.length, 1);
    assert.equal(calls.cleared, 1);
    assert.equal(calls.writes, 0);
    assert.equal(state.watchdogState, null);
  });

  it('escalates to guardian recovery after interrupt grace expires', () => {
    const state = createState({
      watchdogState: {
        episode_key: 'toolu_123',
        interrupt_sent_at: 3_700_000,
        grace_deadline_at: 3_730_000,
        retry_after_at: 0,
        escalated_at: 0,
        last_action_at: 3_700_000,
      }
    });
    const { deps, calls } = createDeps({
      writeWatchdogState: () => {
        calls.writes += 1;
      }
    });

    const phase = evaluateToolWatchdogTransition({
      nowMs: 3_740_000,
      foregroundIdentity: createForegroundIdentity(),
      apiActivity: { watchdog_candidate_tool: createCandidate() },
      interactiveState: {},
      state,
      deps,
    });

    assert.equal(phase.watchdog_phase, 'escalated');
    assert.deepEqual(calls.recoveries, ['tool_timeout_WebFetch']);
    assert.equal(calls.writes, 1);
    assert.equal(state.watchdogState?.escalated_at, 3_740_000);
  });
});
