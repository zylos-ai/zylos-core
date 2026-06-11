import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clearMemorySyncRequest,
  createMemorySyncControlPrompt,
  markMemorySyncRequested,
  shouldTriggerMemorySync,
} from '../memory-sync-gate.js';

describe('memory sync gate', () => {
  it('skips and clears stale request state when unsummarized count is below threshold', () => {
    const result = shouldTriggerMemorySync({
      state: {
        memory_sync: { status: 'requested', requested_at: 100, expires_at: 3700 },
        last_memory_sync_trigger_at: 100,
      },
      now: 200,
      unsummarizedCount: 5,
      checkpointThreshold: 30,
      cooldownSeconds: 600,
    });

    assert.equal(result.shouldEnqueue, false);
    assert.equal(result.reason, 'below_checkpoint_threshold');
    assert.deepEqual(result.nextState, {});
  });

  it('suppresses repeated requests during cooldown', () => {
    const state = {
      memory_sync: { status: 'requested', requested_at: 1000, expires_at: 4600 },
    };

    const result = shouldTriggerMemorySync({
      state,
      now: 1200,
      unsummarizedCount: 45,
      checkpointThreshold: 30,
      cooldownSeconds: 600,
    });

    assert.equal(result.shouldEnqueue, false);
    assert.equal(result.reason, 'cooldown');
    assert.equal(result.nextState, state);
  });

  it('honors legacy trigger timestamps during cooldown', () => {
    const result = shouldTriggerMemorySync({
      state: { last_memory_sync_trigger_at: 1000 },
      now: 1200,
      unsummarizedCount: 45,
      checkpointThreshold: 30,
      cooldownSeconds: 600,
    });

    assert.equal(result.shouldEnqueue, false);
    assert.equal(result.reason, 'cooldown');
  });

  it('suppresses in-flight requests after cooldown until the TTL expires', () => {
    const state = {
      memory_sync: { status: 'requested', requested_at: 1000, expires_at: 4600 },
    };

    const result = shouldTriggerMemorySync({
      state,
      now: 2000,
      unsummarizedCount: 45,
      checkpointThreshold: 30,
      cooldownSeconds: 600,
      inFlightTtlSeconds: 3600,
    });

    assert.equal(result.shouldEnqueue, false);
    assert.equal(result.reason, 'sync_request_in_flight');
  });

  it('allows a new request after the in-flight TTL expires', () => {
    const result = shouldTriggerMemorySync({
      state: {
        memory_sync: { status: 'requested', requested_at: 1000, expires_at: 4600 },
      },
      now: 5000,
      unsummarizedCount: 45,
      checkpointThreshold: 30,
      cooldownSeconds: 600,
      inFlightTtlSeconds: 3600,
    });

    assert.equal(result.shouldEnqueue, true);
    assert.equal(result.reason, 'eligible');
  });

  it('marks requests with a durable status and legacy timestamp', () => {
    const nextState = markMemorySyncRequested({
      state: { session_id: 'abc' },
      now: 1000,
      unsummarizedCount: 45,
      pct: 61,
      thresholdPct: 75,
      inFlightTtlSeconds: 3600,
    });

    assert.equal(nextState.session_id, 'abc');
    assert.equal(nextState.last_memory_sync_trigger_at, 1000);
    assert.deepEqual(nextState.memory_sync, {
      status: 'requested',
      requested_at: 1000,
      expires_at: 4600,
      unsummarized_count: 45,
      context_pct: 61,
      session_switch_threshold_pct: 75,
    });
  });

  it('removes memory sync request fields without touching unrelated state', () => {
    const nextState = clearMemorySyncRequest({
      session_id: 'abc',
      memory_sync: { status: 'requested' },
      last_memory_sync_trigger_at: 1000,
    });

    assert.deepEqual(nextState, { session_id: 'abc' });
  });

  it('builds a maintenance-only control prompt', () => {
    const prompt = createMemorySyncControlPrompt({ pct: 61, thresholdPct: 75 });

    assert.match(prompt, /Run Memory Sync now/);
    assert.match(prompt, /maintenance-only/);
    assert.match(prompt, /must not reply through C4/);
    assert.match(prompt, /process user-facing tasks/);
    assert.match(prompt, /modify business\/project repositories/);
    assert.match(prompt, /Do NOT wait for completion/);
  });
});
