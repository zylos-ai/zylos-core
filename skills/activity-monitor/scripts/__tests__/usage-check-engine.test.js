import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldStartUsageCheck } from '../usage-check-engine.js';

function baseInput() {
  return {
    runtimeId: 'claude',
    claudeState: 'idle',
    idleSeconds: 35,
    currentTime: 10_000,
    lastUsageCheckAt: 0,
    checkInterval: { seconds: 3600, idleGate: 30 },
    inPrompt: false,
    promptUpdatedAt: 0,
    localHour: 12,
    activeHoursStart: 8,
    activeHoursEnd: 23,
    pendingQueueCount: 0,
    lockBusy: false,
    backoffUntil: 0,
    circuitUntil: 0,
  };
}

describe('usage-check-engine', () => {
  it('allows check when all gates pass', () => {
    assert.equal(shouldStartUsageCheck(baseInput()), true);
  });

  it('blocks check when runtime is not claude', () => {
    const input = baseInput();
    input.runtimeId = 'codex';
    assert.equal(shouldStartUsageCheck(input), false);
  });

  it('blocks check when queue has pending work', () => {
    const input = baseInput();
    input.pendingQueueCount = 2;
    assert.equal(shouldStartUsageCheck(input), false);
  });

  it('blocks check during active in_prompt window', () => {
    const input = baseInput();
    input.inPrompt = true;
    input.promptUpdatedAt = input.currentTime - 30;
    assert.equal(shouldStartUsageCheck(input), false);
  });

  it('allows stale in_prompt record after 10 minutes', () => {
    const input = baseInput();
    input.inPrompt = true;
    input.promptUpdatedAt = input.currentTime - 601;
    assert.equal(shouldStartUsageCheck(input), true);
  });
});
