import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCodexRolloutActivityFromLines } from '../codex-rollout-activity-reader.js';

describe('codex-rollout-activity-reader', () => {
  it('returns the oldest unclosed function call', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-04-30T08:00:00.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec_command', call_id: 'call_1' }
      }),
      JSON.stringify({
        timestamp: '2026-04-30T08:00:05.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'view_image', call_id: 'call_2' }
      }),
    ];

    const result = parseCodexRolloutActivityFromLines(lines, {
      nowMs: Date.parse('2026-04-30T08:01:00.000Z')
    });

    assert.equal(result.activeCall.callId, 'call_1');
    assert.equal(result.activeCall.name, 'exec_command');
    assert.equal(result.activeCall.ageSeconds, 60);
  });

  it('clears calls completed by function_call_output', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-04-30T08:00:00.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec_command', call_id: 'call_1' }
      }),
      JSON.stringify({
        timestamp: '2026-04-30T08:00:01.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_1', output: 'done' }
      }),
    ];

    const result = parseCodexRolloutActivityFromLines(lines, {
      nowMs: Date.parse('2026-04-30T08:01:00.000Z')
    });

    assert.equal(result.activeCall, null);
  });

  it('clears calls completed by event_msg end events', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-04-30T08:00:00.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec_command', call_id: 'call_1' }
      }),
      JSON.stringify({
        timestamp: '2026-04-30T08:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'exec_command_end', call_id: 'call_1' }
      }),
    ];

    const result = parseCodexRolloutActivityFromLines(lines, {
      nowMs: Date.parse('2026-04-30T08:01:00.000Z')
    });

    assert.equal(result.activeCall, null);
  });

  it('skips malformed rollout tail lines', () => {
    const lines = [
      '{"partial"',
      JSON.stringify({
        timestamp: '2026-04-30T08:00:00.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec_command', call_id: 'call_1' }
      }),
    ];

    const result = parseCodexRolloutActivityFromLines(lines, {
      nowMs: Date.parse('2026-04-30T08:00:10.000Z')
    });

    assert.equal(result.activeCall.callId, 'call_1');
    assert.equal(result.activeCall.ageSeconds, 10);
  });
});
