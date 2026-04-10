import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyOrderedToolEvents,
  createToolLifecycleState,
  getSessionSnapshot,
} from '../tool-lifecycle.js';

function createPreEvent({ sessionId = 's1', tool = 'WebFetch', eventId = 'evt-1', ts = 1000, pid = 42, ruleId = 'web-tools-timeout' } = {}) {
  return {
    ts,
    pid,
    session_id: sessionId,
    event: 'pre_tool',
    event_id: eventId,
    tool,
    rule_id: ruleId,
    summary: { type: 'input-keys', value: ['url'] }
  };
}

function createPostEvent({ sessionId = 's1', tool = 'WebFetch', ts = 2000, pid = 42, event = 'post_tool' } = {}) {
  return {
    ts,
    pid,
    session_id: sessionId,
    event,
    tool
  };
}

describe('tool-lifecycle', () => {
  it('tracks prompt state without clearing running tools', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent(),
      { ts: 1500, pid: 42, session_id: 's1', event: 'prompt' }
    ], { nowMs: 1500 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.equal(snapshot.running_tools.length, 1);
    assert.equal(snapshot.in_prompt, true);
  });

  it('clears a tool on normal completion', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent(),
      createPostEvent()
    ], { nowMs: 2000 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.equal(snapshot.running_tools.length, 0);
    assert.equal(snapshot.last_completed_tool.status, 'success');
  });

  it('handles completion arriving before pre_tool without leaving a ghost active tool', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPostEvent({ ts: 1000 }),
      createPreEvent({ ts: 1200 })
    ], { nowMs: 1200 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.equal(snapshot.running_tools.length, 0);
    assert.equal(snapshot.last_completed_tool.status, 'success');
    assert.equal(snapshot.last_completed_tool.event_id, 'evt-1');
  });

  it('uses LIFO matching for same-name tools', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent({ eventId: 'evt-1', ts: 1000 }),
      createPreEvent({ eventId: 'evt-2', ts: 1100 }),
      createPostEvent({ ts: 1200 })
    ], { nowMs: 1200 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.deepEqual(snapshot.running_tools.map((tool) => tool.event_id), ['evt-1']);
    assert.equal(snapshot.last_completed_tool.event_id, 'evt-2');
  });

  it('session clear hints only clear older episodes', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent({ eventId: 'evt-old', ts: 1000 }),
      {
        ts: 1500,
        pid: 42,
        session_id: 's1',
        event: 'session_clear_hint',
        reason: 'statusline_turn_complete',
        match_slack_ms: 2000
      },
      createPreEvent({ eventId: 'evt-new', ts: 1600 })
    ], { nowMs: 1600 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.deepEqual(snapshot.running_tools.map((tool) => tool.event_id), ['evt-new']);
    assert.equal(snapshot.last_completed_tool.status, 'cleared_by_session_event');
    assert.equal(snapshot.last_completed_tool.event_id, 'evt-old');
  });

  it('late pre_tool events are cleared by earlier pending clear hints', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      {
        ts: 1500,
        pid: 42,
        session_id: 's1',
        event: 'session_clear_hint',
        reason: 'interactive_recovered',
        match_slack_ms: 2000
      },
      createPreEvent({ eventId: 'evt-late', ts: 1400 })
    ], { nowMs: 1600 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.equal(snapshot.running_tools.length, 0);
    assert.equal(snapshot.last_completed_tool.status, 'cleared_by_session_event');
    assert.equal(snapshot.last_completed_tool.event_id, 'evt-late');
  });

  it('does not clear a genuinely newer tool with an older pending clear hint', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      {
        ts: 1500,
        pid: 42,
        session_id: 's1',
        event: 'session_clear_hint',
        reason: 'statusline_turn_complete',
        match_slack_ms: 2000
      },
      createPreEvent({ eventId: 'evt-newer', ts: 1600 })
    ], { nowMs: 1600 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.deepEqual(snapshot.running_tools.map((tool) => tool.event_id), ['evt-newer']);
  });

  it('does not match a distant pending completion to a new tool episode', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPostEvent({ ts: 1000 }),
      createPreEvent({ eventId: 'evt-far', ts: 20_000 })
    ], { nowMs: 20_000 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.deepEqual(snapshot.running_tools.map((tool) => tool.event_id), ['evt-far']);
  });

  it('matches the closest pending completion when multiple same-name completions are buffered', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPostEvent({ ts: 1000 }),
      createPostEvent({ ts: 1800 }),
      createPreEvent({ eventId: 'evt-2', ts: 1700 }),
      createPreEvent({ eventId: 'evt-1', ts: 900 })
    ], { nowMs: 1800 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.equal(snapshot.running_tools.length, 0);
    assert.equal(snapshot.last_completed_tool.event_id, 'evt-1');
    assert.equal(snapshot.last_completed_tool.ended_at, 1000);
  });
});
