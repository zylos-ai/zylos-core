import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyOrderedToolEvents,
  createToolLifecycleState,
  getSessionSnapshot,
  pruneToolLifecycleState,
  normalizeToolLifecycleState,
} from '../tool-lifecycle.js';

function createPreEvent({
  sessionId = 's1',
  tool = 'WebFetch',
  eventId = 'evt-1',
  ts = 1000,
  pid = 42,
  ruleId = 'web-tools-timeout',
  summary = { type: 'input-keys', value: ['url'] }
} = {}) {
  return {
    ts,
    pid,
    session_id: sessionId,
    event: 'pre_tool',
    event_id: eventId,
    tool,
    rule_id: ruleId,
    summary
  };
}

function createPostEvent({
  sessionId = 's1',
  tool = 'WebFetch',
  ts = 2000,
  pid = 42,
  event = 'post_tool',
  eventId = null,
  summary = null
} = {}) {
  return {
    ts,
    pid,
    session_id: sessionId,
    event,
    tool,
    ...(eventId ? { event_id: eventId } : {}),
    ...(summary ? { summary } : {})
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

  it('matches same-name concurrent completions by event_id instead of LIFO', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent({ eventId: 'toolu-old', ts: 1000, summary: { type: 'url-host', value: 'a.example' } }),
      createPreEvent({ eventId: 'toolu-new', ts: 1100, summary: { type: 'url-host', value: 'b.example' } }),
      createPostEvent({
        ts: 1200,
        eventId: 'toolu-old',
        summary: { type: 'url-host', value: 'a.example' }
      })
    ], { nowMs: 1200 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.deepEqual(snapshot.running_tools.map((tool) => tool.event_id), ['toolu-new']);
    assert.equal(snapshot.last_completed_tool.event_id, 'toolu-old');
  });

  it('ignores duplicate pre_tool events with the same event_id', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent({ eventId: 'toolu-dup', ts: 1000 }),
      createPreEvent({ eventId: 'toolu-dup', ts: 1001 }),
      createPostEvent({ ts: 1200, eventId: 'toolu-dup' })
    ], { nowMs: 1200 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.equal(snapshot.running_tools.length, 0);
    assert.equal(snapshot.last_completed_tool.event_id, 'toolu-dup');
    assert.equal(snapshot.last_completed_tool.status, 'success');
  });

  it('ignores a late duplicate pre_tool even after other tools completed', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent({ eventId: 'toolu-a', ts: 1000 }),
      createPostEvent({ ts: 1100, eventId: 'toolu-a' }),
      createPreEvent({ eventId: 'toolu-b', ts: 1200 }),
      createPostEvent({ ts: 1300, eventId: 'toolu-b' }),
      createPreEvent({ eventId: 'toolu-a', ts: 1400 })
    ], { nowMs: 1400 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.equal(snapshot.running_tools.length, 0);
    assert.equal(snapshot.last_completed_tool.event_id, 'toolu-b');
    assert.equal(snapshot.last_completed_tool.status, 'success');
  });

  it('matches pending completion by event_id before the corresponding pre_tool arrives', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPostEvent({
        ts: 1000,
        eventId: 'toolu-late',
        summary: { type: 'url-host', value: 'late.example' }
      }),
      createPreEvent({
        eventId: 'toolu-late',
        ts: 1200,
        summary: { type: 'url-host', value: 'late.example' }
      })
    ], { nowMs: 1200 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.equal(snapshot.running_tools.length, 0);
    assert.equal(snapshot.last_completed_tool.event_id, 'toolu-late');
    assert.equal(snapshot.last_completed_tool.status, 'success');
  });

  it('ignores duplicate completion events with the same event_id after completion', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent({ eventId: 'toolu-post-dup', ts: 1000 }),
      createPostEvent({ ts: 1200, eventId: 'toolu-post-dup' }),
      createPostEvent({ ts: 1201, eventId: 'toolu-post-dup' })
    ], { nowMs: 1201 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.equal(snapshot.running_tools.length, 0);
    assert.equal(snapshot.last_completed_tool.event_id, 'toolu-post-dup');
    assert.equal(snapshot.last_completed_tool.status, 'success');
    assert.equal(state.pending_completions.length, 0);
  });

  it('ignores a late duplicate completion even after another tool completed', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent({ eventId: 'toolu-a', ts: 1000 }),
      createPostEvent({ ts: 1100, eventId: 'toolu-a' }),
      createPreEvent({ eventId: 'toolu-b', ts: 1200 }),
      createPostEvent({ ts: 1300, eventId: 'toolu-b' }),
      createPostEvent({ ts: 1400, eventId: 'toolu-a' })
    ], { nowMs: 1400 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.equal(snapshot.running_tools.length, 0);
    assert.equal(snapshot.last_completed_tool.event_id, 'toolu-b');
    assert.equal(snapshot.last_completed_tool.status, 'success');
    assert.equal(state.pending_completions.length, 0);
  });

  it('uses summary as a fallback discriminator when event_id is absent', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent({ eventId: 'evt-a', ts: 1000, summary: { type: 'url-host', value: 'a.example' } }),
      createPreEvent({ eventId: 'evt-b', ts: 1100, summary: { type: 'url-host', value: 'b.example' } }),
      createPostEvent({
        ts: 1200,
        summary: { type: 'url-host', value: 'a.example' }
      })
    ], { nowMs: 1200 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.deepEqual(snapshot.running_tools.map((tool) => tool.event_id), ['evt-b']);
    assert.equal(snapshot.last_completed_tool.event_id, 'evt-a');
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

  it('late exact completions override earlier session clear hints for the same episode', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent({
        eventId: 'toolu-status-race',
        ts: 1000,
        summary: { type: 'url-host', value: 'example.com' }
      }),
      {
        ts: 1100,
        pid: 42,
        session_id: 's1',
        event: 'session_clear_hint',
        reason: 'statusline_turn_complete',
        match_slack_ms: 2000
      },
      createPostEvent({
        ts: 1200,
        eventId: 'toolu-status-race',
        summary: { type: 'url-host', value: 'example.com' }
      })
    ], { nowMs: 1200 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.equal(snapshot.running_tools.length, 0);
    assert.equal(snapshot.last_completed_tool.event_id, 'toolu-status-race');
    assert.equal(snapshot.last_completed_tool.status, 'success');
    assert.equal(Object.hasOwn(snapshot.last_completed_tool, 'clear_reason'), false);
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

  it('clears a late pre_tool within the match_slack_ms window of a pending hint', () => {
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
      createPreEvent({ eventId: 'evt-within-slack', ts: 1600 })
    ], { nowMs: 1600 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.equal(snapshot.running_tools.length, 0);
    assert.equal(snapshot.last_completed_tool.status, 'cleared_by_session_event');
    assert.equal(snapshot.last_completed_tool.event_id, 'evt-within-slack');
  });

  it('does not clear a genuinely newer tool beyond the match_slack_ms window', () => {
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
      createPreEvent({ eventId: 'evt-newer', ts: 4000 })
    ], { nowMs: 4000 });

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

  it('records failure status on post_tool_failure', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent({ eventId: 'evt-fail', ts: 1000 }),
      createPostEvent({ eventId: 'evt-fail', ts: 2000, event: 'post_tool_failure' })
    ], { nowMs: 2000 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.equal(snapshot.running_tools.length, 0);
    assert.equal(snapshot.last_completed_tool.status, 'failure');
    assert.equal(snapshot.last_completed_tool.event_id, 'evt-fail');
  });

  it('stop event clears all running tools in the session', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent({ eventId: 'evt-a', ts: 1000 }),
      createPreEvent({ eventId: 'evt-b', ts: 1100, tool: 'WebSearch' }),
      { ts: 2000, pid: 42, session_id: 's1', event: 'stop' }
    ], { nowMs: 2000 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.equal(snapshot.running_tools.length, 0);
    assert.equal(snapshot.in_prompt, false);
    assert.equal(snapshot.last_completed_tool.status, 'cleared_by_session_event');
  });

  it('idle event clears running tools same as stop', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent({ eventId: 'evt-idle', ts: 1000 }),
      { ts: 2000, pid: 42, session_id: 's1', event: 'idle' }
    ], { nowMs: 2000 });

    const snapshot = getSessionSnapshot(state, 's1', 's1');
    assert.equal(snapshot.running_tools.length, 0);
    assert.equal(snapshot.last_completed_tool.clear_reason, 'idle');
  });

  it('tracks tools independently across multiple sessions', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent({ sessionId: 's1', eventId: 'evt-s1', ts: 1000, pid: 10 }),
      createPreEvent({ sessionId: 's2', eventId: 'evt-s2', ts: 1100, pid: 20 }),
      createPostEvent({ sessionId: 's1', eventId: 'evt-s1', ts: 1500 })
    ], { nowMs: 1500 });

    const snap1 = getSessionSnapshot(state, 's1', 's1');
    const snap2 = getSessionSnapshot(state, 's2', 's2');
    assert.equal(snap1.running_tools.length, 0);
    assert.equal(snap1.last_completed_tool.status, 'success');
    assert.equal(snap2.running_tools.length, 1);
    assert.equal(snap2.running_tools[0].event_id, 'evt-s2');
  });

  it('getSessionSnapshot reports foreground scope for matching session', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      createPreEvent({ sessionId: 's1', ts: 1000 }),
      createPreEvent({ sessionId: 's2', ts: 1100 })
    ], { nowMs: 1100 });

    const fgSnap = getSessionSnapshot(state, 's1', 's1');
    const bgSnap = getSessionSnapshot(state, 's2', 's1');
    assert.equal(fgSnap.scope, 'foreground');
    assert.equal(bgSnap.scope, 'background');
  });

  it('purges expired pending completions after TTL', () => {
    const state = createToolLifecycleState();
    // Post arrives at ts=1000, no matching pre
    applyOrderedToolEvents(state, [
      createPostEvent({ ts: 1000 })
    ], { nowMs: 1000 });

    assert.equal(state.pending_completions.length, 1);

    // Apply a no-op event 31s later to trigger purge (TTL is 30s)
    applyOrderedToolEvents(state, [
      { ts: 31_001, pid: 42, session_id: 's1', event: 'prompt' }
    ], { nowMs: 31_001 });

    assert.equal(state.pending_completions.length, 0);
  });
});

describe('pruneToolLifecycleState', () => {
  it('removes idle sessions that exceed TTL with dead pids', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      { ts: 1000, pid: 999, session_id: 'old-session', event: 'prompt' }
    ], { nowMs: 1000 });

    assert.ok(state.sessions['old-session']);

    pruneToolLifecycleState(state, {
      nowMs: 3_602_000,
      livePids: new Set(),
      sessionTtlMs: 3_600_000
    });

    assert.equal(state.sessions['old-session'], undefined);
  });

  it('preserves sessions with running tools even past TTL', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      {
        ts: 1000, pid: 999, session_id: 'active-session', event: 'pre_tool',
        event_id: 'evt-1', tool: 'WebFetch'
      }
    ], { nowMs: 1000 });

    pruneToolLifecycleState(state, {
      nowMs: 3_602_000,
      livePids: new Set(),
      sessionTtlMs: 3_600_000
    });

    assert.ok(state.sessions['active-session']);
    assert.equal(state.sessions['active-session'].running_tools.length, 1);
  });

  it('preserves sessions with live pids even past TTL', () => {
    const state = createToolLifecycleState();
    applyOrderedToolEvents(state, [
      { ts: 1000, pid: 777, session_id: 'live-session', event: 'prompt' }
    ], { nowMs: 1000 });

    pruneToolLifecycleState(state, {
      nowMs: 3_602_000,
      livePids: new Set([777]),
      sessionTtlMs: 3_600_000
    });

    assert.ok(state.sessions['live-session']);
  });
});

describe('normalizeToolLifecycleState', () => {
  it('normalizes a raw serialized state into valid structure', () => {
    const raw = {
      sessions: {
        's1': {
          pid: 42,
          in_prompt: true,
          last_event_at: 5000,
          running_tools: [
            { event_id: 'evt-1', name: 'WebFetch', started_at: 4000, summary: { type: 'url-host', value: 'example.com' } }
          ]
        }
      },
      pending_completions: [{ tool: 'WebFetch', ended_at: 4500 }]
    };

    const state = normalizeToolLifecycleState(raw);
    assert.equal(state.sessions['s1'].pid, 42);
    assert.equal(state.sessions['s1'].in_prompt, true);
    assert.equal(state.sessions['s1'].running_tools.length, 1);
    assert.equal(state.sessions['s1'].running_tools[0].session_id, 's1');
    assert.equal(state.pending_completions.length, 1);
  });

  it('returns empty state for null/undefined input', () => {
    const state = normalizeToolLifecycleState(null);
    assert.deepEqual(state.sessions, {});
    assert.deepEqual(state.pending_completions, []);
  });
});
