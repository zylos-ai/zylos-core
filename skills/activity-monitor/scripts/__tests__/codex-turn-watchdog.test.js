import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CODEX_PENDING_MESSAGE_INTERRUPT_AVAILABLE_IN_SEC,
  evaluateCodexTurnWatchdogTransition
} from '../codex-turn-watchdog.js';

function createState(overrides = {}) {
  return {
    watchdogState: null,
    runtimeLaunchAtMs: 0,
    launchGracePeriodSec: 180,
    engineHealth: 'ok',
    codexPendingMessageInterruptSec: 30,
    codexPendingMessageGraceSec: 10,
    codexPendingMessageCooldownSec: 30,
    codexActiveCallInterruptSec: 900,
    codexActiveCallGraceSec: 30,
    codexActiveCallCooldownSec: 120,
    ...overrides,
  };
}

function createInteractiveState(overrides = {}) {
  return {
    captureOk: true,
    codexQueuedUserMessages: true,
    codexWorkingSeconds: 45,
    ...overrides,
  };
}

function createRolloutActivity(overrides = {}) {
  return {
    activeCall: {
      callId: 'call_1',
      name: 'exec_command',
      startedAtMs: 100_000,
      ageSeconds: 901,
    },
    lastEventAtMs: 100_000,
    ...overrides,
  };
}

function createDeps(overrides = {}) {
  const calls = {
    cleared: 0,
    writes: 0,
    enqueues: [],
    recoveries: [],
    logs: [],
  };

  return {
    calls,
    deps: {
      clearWatchdogState: () => {
        calls.cleared += 1;
      },
      writeWatchdogState: () => {
        calls.writes += 1;
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

describe('codex-turn-watchdog', () => {
  it('exports a named available-in constant for queued-message interrupts', () => {
    assert.equal(CODEX_PENDING_MESSAGE_INTERRUPT_AVAILABLE_IN_SEC, 1);
  });

  it('observes before the queued-message timeout', () => {
    const state = createState();
    const { deps, calls } = createDeps();

    const phase = evaluateCodexTurnWatchdogTransition({
      nowMs: 100_000,
      interactiveState: createInteractiveState({ codexWorkingSeconds: 20 }),
      state,
      deps,
    });

    assert.equal(phase.watchdog_phase, 'observing');
    assert.equal(calls.enqueues.length, 0);
    assert.equal(state.watchdogState, null);
  });

  it('sends Escape when Codex is working with queued user messages past the threshold', () => {
    const state = createState();
    const { deps, calls } = createDeps();

    const phase = evaluateCodexTurnWatchdogTransition({
      nowMs: 100_000,
      interactiveState: createInteractiveState({ codexWorkingSeconds: 45 }),
      state,
      deps,
    });

    assert.equal(phase.watchdog_phase, 'interrupt_sent');
    assert.deepEqual(calls.enqueues, ['Escape']);
    assert.equal(calls.writes, 1);
    assert.equal(state.watchdogState?.type, 'codex_pending_message');
    assert.equal(state.watchdogState?.interrupt_sent_at, 100_000);
  });

  it('waits during interrupt grace and escalates after grace expires', () => {
    const state = createState({
      watchdogState: {
        type: 'codex_pending_message',
        episode_key: 'codex_pending_message:55',
        interrupt_sent_at: 100_000,
        grace_deadline_at: 110_000,
        retry_after_at: 0,
        escalated_at: 0,
      }
    });
    const { deps, calls } = createDeps();

    const waiting = evaluateCodexTurnWatchdogTransition({
      nowMs: 105_000,
      interactiveState: createInteractiveState({ codexWorkingSeconds: 50 }),
      state,
      deps,
    });
    assert.equal(waiting.watchdog_phase, 'interrupt_wait');

    const escalated = evaluateCodexTurnWatchdogTransition({
      nowMs: 112_000,
      interactiveState: createInteractiveState({ codexWorkingSeconds: 57 }),
      state,
      deps,
    });
    assert.equal(escalated.watchdog_phase, 'escalated');
    assert.deepEqual(calls.recoveries, ['codex_pending_message_stuck']);
  });

  it('clears state when there is no queued user message', () => {
    const state = createState({ watchdogState: { episode_key: 'old' } });
    const { deps, calls } = createDeps({
      clearWatchdogState: () => {
        calls.cleared += 1;
        state.watchdogState = null;
      }
    });

    const phase = evaluateCodexTurnWatchdogTransition({
      nowMs: 100_000,
      interactiveState: createInteractiveState({ codexQueuedUserMessages: false }),
      rolloutActivity: { activeCall: null, lastEventAtMs: 0 },
      state,
      deps,
    });

    assert.equal(phase.watchdog_phase, 'idle');
    assert.equal(phase.watchdog_block_reason, 'no_queued_user_message');
    assert.equal(calls.cleared, 1);
    assert.equal(state.watchdogState, null);
  });

  it('observes an active rollout call before the active-call timeout', () => {
    const state = createState();
    const { deps, calls } = createDeps();

    const phase = evaluateCodexTurnWatchdogTransition({
      nowMs: 1_000_000,
      interactiveState: createInteractiveState({ codexQueuedUserMessages: false }),
      rolloutActivity: createRolloutActivity({
        activeCall: {
          callId: 'call_1',
          name: 'exec_command',
          startedAtMs: 100_000,
          ageSeconds: 899,
        }
      }),
      state,
      deps,
    });

    assert.equal(phase.watchdog_phase, 'observing');
    assert.equal(phase.watchdog_block_reason, 'no_queued_user_message');
    assert.equal(calls.enqueues.length, 0);
    assert.equal(state.watchdogState, null);
  });

  it('sends Escape for an active rollout call after the conservative timeout', () => {
    const state = createState();
    const { deps, calls } = createDeps();

    const phase = evaluateCodexTurnWatchdogTransition({
      nowMs: 1_001_000,
      interactiveState: createInteractiveState({ codexQueuedUserMessages: false }),
      rolloutActivity: createRolloutActivity(),
      state,
      deps,
    });

    assert.equal(phase.watchdog_phase, 'interrupt_sent');
    assert.deepEqual(calls.enqueues, ['Escape']);
    assert.equal(calls.writes, 1);
    assert.equal(state.watchdogState?.type, 'codex_active_call');
    assert.equal(state.watchdogState?.call_id, 'call_1');
    assert.equal(state.watchdogState?.tool_name, 'exec_command');
  });

  it('escalates an active rollout call after interrupt grace expires', () => {
    const state = createState({
      watchdogState: {
        type: 'codex_active_call',
        episode_key: 'codex_active_call:call_1:100',
        interrupt_sent_at: 1_001_000,
        grace_deadline_at: 1_031_000,
        retry_after_at: 0,
        escalated_at: 0,
      }
    });
    const { deps, calls } = createDeps();

    const phase = evaluateCodexTurnWatchdogTransition({
      nowMs: 1_032_000,
      interactiveState: createInteractiveState({ codexQueuedUserMessages: false }),
      rolloutActivity: createRolloutActivity({ activeCall: { ...createRolloutActivity().activeCall, ageSeconds: 932 } }),
      state,
      deps,
    });

    assert.equal(phase.watchdog_phase, 'escalated');
    assert.deepEqual(calls.recoveries, ['codex_active_call_stuck']);
  });
});
