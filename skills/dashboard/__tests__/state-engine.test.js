import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAgentState, StateEngine } from '../src/lib/state-engine.js';
import { Sanitizer } from '../src/lib/sanitizer.js';

function makeMockStore() {
  return {
    latestSnapshot() { return null; },
    eventsSince() { return []; },
    saveSnapshot() {},
    upsertSourceHealth() {},
    getCollectorLiveness() { return []; },
    getSourceHealth() { return []; },
    db: { prepare() { return { get() { return { seq: 0 }; } }; } }
  };
}

function makeEngine(opts = {}) {
  let clock = opts.startTime || 1000000;
  const now = () => clock;
  const advance = (ms) => { clock += ms; };
  const store = opts.store || makeMockStore();
  const config = { zylosDir: '/tmp/zylos-test', runtime: opts.runtime || 'claude' };
  const engine = new StateEngine(store, {}, config, { now });
  engine._state.amHeartbeat = { state: 'idle', health: 'ok', lastCheck: clock / 1000, lastActivity: clock / 1000 };
  return { engine, now, advance };
}

test('stop event clears running tools for that session', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-1', tool_name: 'Read' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-2', tool_name: 'Read' }
  });

  assert.equal(engine.getRunningTools().length, 2);

  engine.onEvent({
    event_type: 'stop',
    timestamp: new Date(1001000).toISOString(),
    session_id: 'sess-1'
  });

  assert.equal(engine.getRunningTools().length, 0, 'running tools should be cleared after stop');
});

test('stop event only clears tools from the stopped session', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-1', tool_name: 'Read' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-2',
    metadata: { tool_use_id: 'tool-2', tool_name: 'Bash' }
  });

  assert.equal(engine.getRunningTools().length, 2);

  engine.onEvent({
    event_type: 'stop',
    timestamp: new Date(1001000).toISOString(),
    session_id: 'sess-1'
  });

  const remaining = engine.getRunningTools();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].tool_name, 'Bash');
});

test('stop event without session_id clears all tools', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-1', tool_name: 'Read' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-2',
    metadata: { tool_use_id: 'tool-2', tool_name: 'Bash' }
  });

  engine.onEvent({
    event_type: 'stop',
    timestamp: new Date(1001000).toISOString(),
    session_id: null
  });

  assert.equal(engine.getRunningTools().length, 0);
});

test('periodic stale tool cleanup removes old tools', () => {
  const { engine, advance } = makeEngine({ startTime: 1000000 });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-1', tool_name: 'Read' }
  });

  assert.equal(engine.getRunningTools().length, 1);

  advance(400_000);
  engine._cleanupStaleTools();

  assert.equal(engine.getRunningTools().length, 0, 'stale tool should be cleaned up after 5min');
});

test('periodic stale tool cleanup keeps fresh tools', () => {
  const { engine, advance } = makeEngine({ startTime: 1000000 });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-1', tool_name: 'Bash' }
  });

  advance(60_000);
  engine._cleanupStaleTools();

  assert.equal(engine.getRunningTools().length, 1, 'fresh tool should not be cleaned up');
});

test('subagent tools are separated from main session tools via agent_id', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess'
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-agent', tool_name: 'Agent' }
  });

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000150).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'general-purpose' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-sub', tool_name: 'Bash', agent_id: 'agent-1' }
  });

  const state = engine.getState();
  assert.equal(state.running_tools.length, 1, 'main feed should only have Agent launcher');
  assert.equal(state.running_tools[0].tool_name, 'Agent');
  assert.equal(state.subagent_tools.length, 1, 'subagent feed should have subagent tools');
  assert.equal(state.subagent_tools[0].tool_name, 'Bash');
  assert.equal(state.active_subagents[0].running_tools.length, 1, 'subagent should have its own running_tools');
  assert.equal(state.active_subagents[0].running_tools[0].tool_name, 'Bash');
});

test('subagent child session tools attach to active subagent row', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'default', nickname: 'Ada' }
  });

  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'agent-1',
    summary: 'Prompt received'
  });

  engine.onEvent({
    event_type: 'assistant_message',
    timestamp: new Date(1000150).toISOString(),
    session_id: 'agent-1',
    summary: 'I will run a read-only check.'
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'agent-1',
    metadata: { tool_use_id: 'tool-child', tool_name: 'Bash', tool_detail: 'sleep 45' }
  });

  let state = engine.getState();
  assert.equal(state.running_tools.length, 0, 'child session tool should not appear in main feed');
  assert.equal(state.subagent_tools.length, 1, 'child session tool should appear in subagent feed');
  assert.equal(state.active_subagents[0].running_tools.length, 1, 'active subagent row should show child tool');
  assert.equal(state.active_subagents[0].running_tools[0].tool_name, 'Bash');
  assert.equal(state.active_subagents[0].last_activity, 'Bash: sleep 45');
  assert.equal(state.last_message, null, 'child assistant message should not replace main assistant message');

  engine.onEvent({
    event_type: 'stop',
    timestamp: new Date(1000300).toISOString(),
    session_id: 'agent-1',
    summary: 'child complete'
  });

  state = engine.getState();
  assert.equal(state.active_subagents.length, 1, 'child stop should not remove parent-tracked subagent');
  assert.equal(state.active_subagents[0].status, 'completed');
  assert.equal(state.active_subagents[0].running_tools.length, 0);
});

test('background subagent: main and subagent tools separated by agent_id', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess'
  });

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000150).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-bg', agent_type: 'general-purpose' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-main', tool_name: 'Bash' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000250).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-bg', tool_name: 'Read', agent_id: 'agent-bg' }
  });

  const state = engine.getState();
  assert.equal(state.active_subagents.length, 1, 'subagent should be active');
  assert.equal(state.running_tools.length, 1, 'main session tool in main feed');
  assert.equal(state.running_tools[0].tool_name, 'Bash');
  assert.equal(state.subagent_tools.length, 1, 'subagent tool in subagent feed');
  assert.equal(state.subagent_tools[0].tool_name, 'Read');
  assert.equal(state.active_subagents[0].running_tools.length, 1, 'subagent has its own running_tools');
});

test('subagent lifecycle tracked via SubagentStart/Stop', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'general-purpose' }
  });

  let state = engine.getState();
  assert.equal(state.active_subagents.length, 1);
  assert.equal(state.active_subagents[0].agent_id, 'agent-1');

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-2', agent_type: 'general-purpose' }
  });

  state = engine.getState();
  assert.equal(state.active_subagents.length, 2);

  engine.onEvent({
    event_type: 'subagent_stop',
    timestamp: new Date(1002000).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1' }
  });

  state = engine.getState();
  assert.equal(state.active_subagents.length, 1);
  assert.equal(state.active_subagents[0].agent_id, 'agent-2');
});

test('subagent gets description from preceding Agent PreToolUse', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-agent', tool_name: 'Agent', tool_detail: 'Lark evening group digest' }
  });

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000010).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'general-purpose' }
  });

  const state = engine.getState();
  assert.equal(state.active_subagents[0].description, 'Lark evening group digest');
  assert.equal(state.active_subagents[0].agent_type, 'general-purpose');
});

test('subagent description fallback when no preceding Agent tool', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'claude-code-guide' }
  });

  const state = engine.getState();
  assert.equal(state.active_subagents[0].description, null);
  assert.equal(state.active_subagents[0].agent_type, 'claude-code-guide');
});

test('subagent description can come from canonical event metadata', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: {
      agent_id: 'agent-1',
      agent_type: 'worker',
      description: 'Investigate rollout lifecycle'
    }
  });

  const state = engine.getState();
  assert.equal(state.active_subagents[0].description, 'Investigate rollout lifecycle');
  assert.equal(state.active_subagents[0].agent_type, 'worker');
});

test('subagent update tracks status, nickname, and last activity', () => {
  const { engine, advance } = makeEngine({ runtime: 'codex' });

  engine.onEvent({
    runtime: 'codex',
    event_type: 'subagent_start',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: {
      agent_id: 'agent-1',
      agent_type: 'worker',
      nickname: 'Ada',
      description: 'Inspect runtime events'
    }
  });

  engine.onEvent({
    runtime: 'codex',
    event_type: 'subagent_update',
    timestamp: new Date(1001000).toISOString(),
    session_id: 'main-sess',
    summary: 'Waiting for subagent',
    metadata: {
      agent_id: 'agent-1',
      status: 'waiting',
      last_activity: 'Waiting for completion',
      wait_started_at: new Date(1001000).toISOString(),
      wait_timeout_ms: 3000
    }
  });
  advance(2000);

  const state = engine.getState();
  assert.equal(state.active_subagents.length, 1);
  assert.equal(state.active_subagents[0].nickname, 'Ada');
  assert.equal(state.active_subagents[0].status, 'waiting');
  assert.equal(state.active_subagents[0].last_activity, 'Waiting for subagent');
  assert.equal(state.active_subagents[0].description, 'Inspect runtime events');
  assert.equal(state.active_subagents[0].wait_duration_s, 1);
  assert.equal(state.active_subagents[0].wait_timeout_ms, 3000);
  assert.equal(state.active_subagents[0].recent_activity.at(-1).summary, 'Waiting for subagent');
  assert.equal(state.active_subagents[0].recent_activity.at(-1).status, 'waiting');
});

test('Codex runtime source health ignores Claude-only runtime progress', () => {
  const store = {
    ...makeMockStore(),
    getSourceHealth() {
      return [
        {
          name: 'hook_events',
          signal_type: 'runtime_progress',
          status: 'healthy',
          extra: { last_success: new Date(990000).toISOString(), runtime: 'claude' }
        },
        {
          name: 'statusline',
          signal_type: 'runtime_progress',
          status: 'healthy',
          extra: { last_success: new Date(990000).toISOString(), runtime: 'claude' }
        },
        {
          name: 'codex_rollout',
          signal_type: 'collector_liveness',
          status: 'healthy',
          extra: { last_success: new Date(990000).toISOString(), runtime: 'codex' }
        }
      ];
    }
  };
  const { engine } = makeEngine({ store, runtime: 'codex' });

  const source = engine.getSourceHealth();
  assert.equal(source.runtime_progress.hook_events.status, 'unknown');
  assert.equal(source.runtime_progress.hook_events.fresh, false);
  assert.equal(source.runtime_progress.hook_events.reason, 'runtime_mismatch');
  assert.equal(source.runtime_progress.statusline.status, 'unsupported');
  assert.equal(source.runtime_progress.statusline.capability, 'unsupported');
  assert.equal(source.runtime_progress.statusline.reason, 'unsupported');
  assert.equal(source.runtime_progress.jsonl_usage.status, 'healthy');
  assert.equal(source.runtime_progress.jsonl_usage.reason, 'fresh');
});

test('runtime boundary event resets foreground runtime state', () => {
  const { engine } = makeEngine({ runtime: 'codex' });

  engine.onEvent({
    runtime: 'codex',
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'codex-session'
  });
  engine.onEvent({
    runtime: 'codex',
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'codex-session',
    metadata: { tool_use_id: 'tool-1', tool_name: 'Bash' }
  });
  engine.onEvent({
    runtime: 'codex',
    event_type: 'permission_request',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'codex-session',
    metadata: { tool_name: 'Bash' }
  });
  engine.onEvent({
    runtime: 'codex',
    event_type: 'subagent_start',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'codex-session',
    metadata: { agent_id: 'agent-1', agent_type: 'worker' }
  });

  let state = engine.getState();
  assert.equal(state.running_tools.length, 1);
  assert.equal(state.active_subagents.length, 1);
  assert.equal(engine.getCurrentSessionId(), 'codex-session');

  engine.onEvent({
    runtime: 'claude',
    event_type: 'user_prompt_submit',
    timestamp: new Date(1001000).toISOString(),
    session_id: 'claude-session'
  });

  state = engine.getState();
  assert.equal(state.running_tools.length, 0);
  assert.equal(state.active_subagents.length, 0);
  assert.equal(state.last_prompt, null);
  assert.equal(engine.getCurrentSessionId(), null);
  assert.equal(state.state, 'IDLE');
});

test('session_start for a new session resets stale foreground runtime state', () => {
  const { engine } = makeEngine({ runtime: 'codex' });

  engine.onEvent({
    runtime: 'codex',
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'codex-old'
  });
  engine.onEvent({
    runtime: 'codex',
    event_type: 'pre_tool_use',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'codex-old',
    metadata: { tool_use_id: 'tool-old', tool_name: 'Bash' }
  });
  engine.onEvent({
    runtime: 'codex',
    event_type: 'subagent_start',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'codex-old',
    metadata: { agent_id: 'agent-old', agent_type: 'worker' }
  });

  engine.onEvent({
    runtime: 'codex',
    event_type: 'session_start',
    timestamp: new Date(1001000).toISOString(),
    session_id: 'codex-new'
  });

  const state = engine.getState();
  assert.equal(state.running_tools.length, 0, 'old session tool should be cleared');
  assert.equal(state.active_subagents.length, 0, 'old session subagent should be cleared');
  assert.equal(state.last_prompt, null, 'old prompt should be cleared');
  assert.equal(engine.getCurrentSessionId(), 'codex-new');
  assert.equal(state.state, 'IDLE');
});

test('duplicate session_start for current session preserves foreground runtime state', () => {
  const { engine } = makeEngine({ runtime: 'codex' });

  engine.onEvent({
    runtime: 'codex',
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'codex-current'
  });
  engine.onEvent({
    runtime: 'codex',
    event_type: 'pre_tool_use',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'codex-current',
    metadata: { tool_use_id: 'tool-current', tool_name: 'Bash' }
  });
  engine.onEvent({
    runtime: 'codex',
    event_type: 'subagent_start',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'codex-current',
    metadata: { agent_id: 'agent-current', agent_type: 'worker' }
  });

  engine.onEvent({
    runtime: 'codex',
    event_type: 'session_start',
    timestamp: new Date(1000300).toISOString(),
    session_id: 'codex-current'
  });

  const state = engine.getState();
  assert.equal(state.running_tools.length, 1, 'current session tool should be preserved');
  assert.equal(state.active_subagents.length, 1, 'current session subagent should be preserved');
  assert.equal(engine.getCurrentSessionId(), 'codex-current');
  assert.equal(state.state, 'BUSY');
});

test('Claude runtime source health keeps Claude runtime progress', () => {
  const store = {
    ...makeMockStore(),
    getSourceHealth() {
      return [
        {
          name: 'hook_events',
          signal_type: 'runtime_progress',
          status: 'healthy',
          extra: { last_success: new Date(990000).toISOString(), runtime: 'claude' }
        },
        {
          name: 'statusline',
          signal_type: 'runtime_progress',
          status: 'healthy',
          extra: { last_success: new Date(990000).toISOString(), runtime: 'claude' }
        },
        {
          name: 'jsonl_usage',
          signal_type: 'collector_liveness',
          status: 'healthy',
          extra: { last_success: new Date(990000).toISOString() }
        }
      ];
    }
  };
  const { engine } = makeEngine({ store, runtime: 'claude' });

  const source = engine.getSourceHealth();
  assert.equal(source.runtime_progress.hook_events.status, 'healthy');
  assert.equal(source.runtime_progress.statusline.status, 'healthy');
  assert.equal(source.runtime_progress.jsonl_usage.status, 'healthy');
});

test('source health explains missing Codex rollout mapping', () => {
  const store = {
    ...makeMockStore(),
    getSourceHealth() {
      return [
        {
          name: 'codex_rollout',
          signal_type: 'collector_liveness',
          status: 'unavailable',
          extra: { reason: 'no_hook_transcript_path', last_checked: new Date(990000).toISOString() }
        }
      ];
    }
  };
  const { engine } = makeEngine({ store, runtime: 'codex' });

  const source = engine.getSourceHealth();
  assert.equal(source.runtime_progress.jsonl_usage.status, 'unavailable');
  assert.equal(source.runtime_progress.jsonl_usage.capability, 'supported');
  assert.equal(source.runtime_progress.jsonl_usage.reason, 'no_hook_transcript_path');
  assert.match(source.runtime_progress.jsonl_usage.detail, /rollout transcript path/);
});

test('completed Agent tool does not leak description to next subagent', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-agent-1', tool_name: 'Agent', tool_detail: 'First task' }
  });
  engine.onEvent({
    event_type: 'post_tool_use',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-agent-1', tool_name: 'Agent' }
  });
  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-2', agent_type: 'general-purpose' }
  });

  const state = engine.getState();
  assert.equal(state.active_subagents[0].description, null,
    'should not inherit description from completed Agent tool');
});

test('concurrent subagents each get their own Agent description', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-a1', tool_name: 'Agent', tool_detail: 'First subagent task' }
  });
  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000010).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'general-purpose' }
  });
  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000020).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-a2', tool_name: 'Agent', tool_detail: 'Second subagent task' }
  });
  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000030).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-2', agent_type: 'general-purpose' }
  });

  const state = engine.getState();
  const a1 = state.active_subagents.find(a => a.agent_id === 'agent-1');
  const a2 = state.active_subagents.find(a => a.agent_id === 'agent-2');
  assert.equal(a1.description, 'First subagent task');
  assert.equal(a2.description, 'Second subagent task');
});

test('subagent tools do not appear in main running_tools after stop', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess'
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000050).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-agent', tool_name: 'Agent' }
  });

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000060).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'general-purpose' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-sub', tool_name: 'Bash', agent_id: 'agent-1' }
  });

  engine.onEvent({
    event_type: 'post_tool_use',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-sub', tool_name: 'Bash', agent_id: 'agent-1' }
  });

  engine.onEvent({
    event_type: 'subagent_stop',
    timestamp: new Date(1000300).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1' }
  });

  engine.onEvent({
    event_type: 'post_tool_use',
    timestamp: new Date(1000350).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-agent', tool_name: 'Agent' }
  });

  const state = engine.getState();
  assert.equal(state.running_tools.length, 0, 'no tools should be running after completion');
  assert.equal(state.subagent_tools.length, 0, 'no subagent tools after stop');
  assert.equal(state.active_subagents.length, 0, 'no active subagents after stop');
});

test('parent Stop preserves background subagent running tools', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess'
  });

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-bg', agent_type: 'general-purpose' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-main', tool_name: 'Bash' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000250).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-bg', tool_name: 'Read', agent_id: 'agent-bg' }
  });

  engine.onEvent({
    event_type: 'stop',
    timestamp: new Date(1000500).toISOString(),
    session_id: 'main-sess'
  });

  const state = engine.getState();
  assert.equal(state.running_tools.length, 0, 'main tool cleared by Stop');
  assert.equal(state.subagent_tools.length, 1, 'subagent tool survives parent Stop');
  assert.equal(state.subagent_tools[0].tool_name, 'Read');
  assert.equal(state.active_subagents.length, 1, 'subagent still active');
});

test('SubagentStop cleans up orphan running tools for that agent_id', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'general-purpose' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-orphan', tool_name: 'Bash', agent_id: 'agent-1' }
  });

  engine.onEvent({
    event_type: 'subagent_stop',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1' }
  });

  const state = engine.getState();
  assert.equal(state.active_subagents.length, 0, 'subagent removed');
  assert.equal(state.subagent_tools.length, 0, 'orphan tool cleaned up by SubagentStop');
  assert.equal(state.running_tools.length, 0, 'no main tools either');
});

test('Stop without session_id preserves subagent tools', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'general-purpose' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-main', tool_name: 'Bash' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000150).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-sub', tool_name: 'Read', agent_id: 'agent-1' }
  });

  engine.onEvent({
    event_type: 'stop',
    timestamp: new Date(1000200).toISOString(),
    session_id: null
  });

  const state = engine.getState();
  assert.equal(state.running_tools.length, 0, 'main tool cleared');
  assert.equal(state.subagent_tools.length, 1, 'subagent tool survives null-session Stop');
});

test('Stop event captures assistant_summary as last_message', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess'
  });

  engine.onEvent({
    event_type: 'stop',
    timestamp: new Date(1001000).toISOString(),
    session_id: 'main-sess',
    metadata: { assistant_summary: 'Fixed the bug in config.json' }
  });

  const state = engine.getState();
  assert.ok(state.last_message, 'last_message should be set');
  assert.equal(state.last_message.text, 'Fixed the bug in config.json');
  assert.ok(state.last_message.timestamp);
});

test('UserPromptSubmit clears last_message', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'stop',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: { assistant_summary: 'Some message' }
  });

  assert.ok(engine.getState().last_message, 'message set after stop');

  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1001000).toISOString(),
    session_id: 'main-sess'
  });

  assert.equal(engine.getState().last_message, null, 'message cleared on new turn');
});

test('Stop without assistant_summary does not set last_message', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'stop',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: {}
  });

  assert.equal(engine.getState().last_message, null);
});

test('snapshot restore preserves last_message', () => {
  let snapshotData = null;
  const store = {
    ...makeMockStore(),
    saveSnapshot(data) { snapshotData = data; },
    latestSnapshot() { return snapshotData; }
  };
  const config = { zylosDir: '/tmp/zylos-test', runtime: 'claude' };
  let clock = 1000000;
  const engine1 = new StateEngine(store, {}, config, { now: () => clock });
  engine1._state.amHeartbeat = { state: 'idle', health: 'ok', lastCheck: clock / 1000, lastActivity: clock / 1000 };

  engine1.onEvent({
    event_type: 'stop',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: { assistant_summary: 'Completed the task successfully' }
  });

  assert.ok(engine1.getState().last_message, 'message set after stop');
  engine1._saveSnapshot();
  assert.ok(snapshotData, 'snapshot saved');
  assert.ok(snapshotData.last_message, 'last_message included in snapshot');

  const engine2 = new StateEngine(store, {}, config, { now: () => clock });
  engine2._state.amHeartbeat = { state: 'idle', health: 'ok', lastCheck: clock / 1000, lastActivity: clock / 1000 };
  engine2.initialize();

  const state = engine2.getState();
  assert.ok(state.last_message, 'last_message restored from snapshot');
  assert.equal(state.last_message.text, 'Completed the task successfully');
});

test('snapshot restore preserves mainSessionId and activeSubagents', () => {
  let snapshotData = null;
  const store = {
    ...makeMockStore(),
    saveSnapshot(data) { snapshotData = data; },
    latestSnapshot() { return snapshotData; }
  };
  const config = { zylosDir: '/tmp/zylos-test', runtime: 'claude' };
  let clock = 1000000;
  const engine1 = new StateEngine(store, {}, config, { now: () => clock });
  engine1._state.amHeartbeat = { state: 'idle', health: 'ok', lastCheck: clock / 1000, lastActivity: clock / 1000 };

  engine1.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess'
  });
  engine1.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000050).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-agent', tool_name: 'Agent' }
  });
  engine1.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'general-purpose' }
  });
  engine1.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-sub', tool_name: 'Read', agent_id: 'agent-1' }
  });

  engine1._saveSnapshot();
  assert.ok(snapshotData, 'snapshot should be saved');

  const engine2 = new StateEngine(store, {}, config, { now: () => clock });
  engine2._state.amHeartbeat = { state: 'idle', health: 'ok', lastCheck: clock / 1000, lastActivity: clock / 1000 };
  engine2.initialize();

  const state = engine2.getState();
  assert.equal(state.running_tools.length, 1, 'Agent launcher should be in main running_tools');
  assert.equal(state.running_tools[0].tool_name, 'Agent');
  assert.equal(state.subagent_tools.length, 1, 'subagent tool should be in subagent_tools');
  assert.equal(state.active_subagents.length, 1);
  assert.equal(state.active_subagents[0].agent_id, 'agent-1');
  assert.equal(state.active_subagents[0].running_tools.length, 1, 'subagent running_tools preserved after restore');
});

test('snapshot restore preserves last_prompt', () => {
  let snapshotData = null;
  const store = {
    ...makeMockStore(),
    saveSnapshot(data) { snapshotData = data; },
    latestSnapshot() { return snapshotData; }
  };
  const config = { zylosDir: '/tmp/zylos-test', runtime: 'claude' };
  let clock = 1000000;
  const engine1 = new StateEngine(store, {}, config, { now: () => clock });
  engine1._state.amHeartbeat = { state: 'idle', health: 'ok', lastCheck: clock / 1000, lastActivity: clock / 1000 };

  engine1.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    summary: 'Prompt from telegram (8101553026)',
    metadata: { prompt_source: 'telegram (8101553026)' }
  });

  assert.ok(engine1.getState().last_prompt, 'last_prompt set after user_prompt_submit');
  engine1._saveSnapshot();
  assert.ok(snapshotData.last_prompt, 'last_prompt included in snapshot');

  const engine2 = new StateEngine(store, {}, config, { now: () => clock });
  engine2._state.amHeartbeat = { state: 'idle', health: 'ok', lastCheck: clock / 1000, lastActivity: clock / 1000 };
  engine2.initialize();

  const state = engine2.getState();
  assert.ok(state.last_prompt, 'last_prompt restored from snapshot');
  assert.equal(state.last_prompt.source, 'telegram (8101553026)');
  assert.equal(state.last_prompt.summary, 'Prompt from telegram (8101553026)');
});

test('snapshot restore preserves lastProgressAt', () => {
  let snapshotData = null;
  const store = {
    ...makeMockStore(),
    saveSnapshot(data) { snapshotData = data; },
    latestSnapshot() { return snapshotData; }
  };
  const config = { zylosDir: '/tmp/zylos-test', runtime: 'claude' };
  let clock = 1000000;
  const engine1 = new StateEngine(store, {}, config, { now: () => clock });
  engine1._state.amHeartbeat = { state: 'idle', health: 'ok', lastCheck: clock / 1000, lastActivity: clock / 1000 };

  engine1.onEvent({
    event_type: 'post_tool_use',
    timestamp: new Date(clock).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-1', tool_name: 'Bash' }
  });

  assert.ok(engine1._state.lastProgressAt, 'lastProgressAt set after post_tool_use');
  engine1._saveSnapshot();
  assert.ok(snapshotData.last_progress_at, 'last_progress_at included in snapshot');

  const engine2 = new StateEngine(store, {}, config, { now: () => clock });
  engine2._state.amHeartbeat = { state: 'idle', health: 'ok', lastCheck: clock / 1000, lastActivity: clock / 1000 };
  engine2.initialize();

  assert.ok(engine2._state.lastProgressAt, 'lastProgressAt restored from snapshot');
  assert.equal(engine2._state.lastProgressAt.toISOString(), new Date(clock).toISOString());
});

test('long-running tool with recent progress stays BUSY, not POSSIBLY_STUCK', () => {
  const signals = {
    amAvailable: true,
    amState: 'busy',
    amHealth: 'ok',
    runningTool: { tool_name: 'Read', age: 400 },
    openTurn: null,
    pendingPermission: null,
    lastProgressAge: 10,
    lastProgressType: null,
    collectorLivenessFresh: true,
    collectorLivenessAvailable: true,
    activeOtelSpan: false,
    possiblyStuckSince: null,
    runtime: 'claude',
    now: () => Date.now()
  };

  const result = deriveAgentState(signals);
  assert.equal(result.state, 'BUSY', 'should be BUSY when recent progress exists despite long tool');
});

test('long-running tool without recent progress is POSSIBLY_STUCK', () => {
  const signals = {
    amAvailable: true,
    amState: 'busy',
    amHealth: 'ok',
    runningTool: { tool_name: 'Read', age: 400 },
    openTurn: null,
    pendingPermission: null,
    lastProgressAge: 120,
    lastProgressType: null,
    collectorLivenessFresh: true,
    collectorLivenessAvailable: true,
    activeOtelSpan: false,
    possiblyStuckSince: null,
    runtime: 'claude',
    now: () => Date.now()
  };

  const result = deriveAgentState(signals);
  assert.equal(result.state, 'POSSIBLY_STUCK');
});

test('open turn with recent progress stays BUSY', () => {
  const signals = {
    amAvailable: true,
    amState: 'busy',
    amHealth: 'ok',
    runningTool: null,
    openTurn: { age: 400 },
    pendingPermission: null,
    lastProgressAge: 15,
    lastProgressType: null,
    collectorLivenessFresh: true,
    collectorLivenessAvailable: true,
    activeOtelSpan: false,
    possiblyStuckSince: null,
    runtime: 'claude',
    now: () => Date.now()
  };

  const result = deriveAgentState(signals);
  assert.equal(result.state, 'BUSY', 'should be BUSY when turn is old but progress is recent');
});

test('post_tool_use resets possibly-stuck via lastProgressAt', () => {
  const { engine, advance } = makeEngine();

  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-1'
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-long', tool_name: 'Read' }
  });

  advance(310_000);

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1310000).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-new', tool_name: 'Bash' }
  });

  engine.onEvent({
    event_type: 'post_tool_use',
    timestamp: new Date(1310100).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-new', tool_name: 'Bash' }
  });

  const state = engine.getState();
  assert.equal(state.state, 'BUSY', 'should be BUSY after new tool completed even with long-running tool');
});

test('Stop assistant_summary is redacted and truncated', () => {
  const sanitizer = new Sanitizer('/tmp/zylos-test');
  const longMsg = 'Fixed the config. Key was sk-abcdefghijklmnopqrstuvwx. ' + 'x'.repeat(300);
  const result = sanitizer.sanitizeHookPayload('Stop', {
    session_id: 'sess-1',
    hook_event_name: 'Stop',
    last_assistant_message: longMsg
  });

  assert.ok(result.metadata.assistant_summary, 'should have assistant_summary');
  assert.ok(result.metadata.assistant_summary.length <= 200, 'should be truncated to 200 chars');
  assert.ok(!result.metadata.assistant_summary.includes('sk-abcdefgh'), 'API key should be redacted');
});

test('SubagentStop assistant_summary is redacted', () => {
  const sanitizer = new Sanitizer('/tmp/zylos-test');
  const result = sanitizer.sanitizeHookPayload('SubagentStop', {
    session_id: 'sess-1',
    agent_id: 'agent-1',
    agent_type: 'general-purpose',
    hook_event_name: 'SubagentStop',
    last_assistant_message: 'Used key sk-1234567890abcdefghijklmnop and sent to user@example.com'
  });

  assert.ok(result.metadata.assistant_summary, 'should have assistant_summary');
  assert.ok(!result.metadata.assistant_summary.includes('sk-1234567890'), 'API key should be redacted');
  assert.ok(!result.metadata.assistant_summary.includes('user@example.com'), 'email should be redacted');
  assert.ok(result.metadata.assistant_summary.includes('[REDACTED]'), 'should contain redaction marker');
});

test('Bash tool_detail shortens paths and strips noise', () => {
  const sanitizer = new Sanitizer('/home/howard/zylos');

  const cases = [
    [
      'node /home/howard/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram" "123"',
      /^Send to telegram \(123\)$/
    ],
    [
      'grep -n "foo" /home/howard/zylos/workspace/zylos-dashboard/public/js/app.js',
      /^grep -n "foo" public\/js\/app\.js$/
    ],
    [
      'cd /home/howard/zylos && npm test 2>&1 | tail -5',
      /^npm test/
    ],
    [
      'curl -s "https://example.com/api/data" 2>&1 | head -5',
      /^curl -s "https:\/\/example\.com\/api\/data"/
    ],
    [
      'npm test 2>&1',
      /^npm test$/
    ],
    [
      'echo hello',
      /^echo hello$/
    ],
    [
      'node /Users/howard/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram"',
      /^Send to telegram$/
    ],
    [
      'curl https://example.com/home/a/b/c/d',
      /^curl https:\/\/example\.com\/home\/a\/b\/c\/d$/
    ],
    [
      'printf foo|tail -1',
      /^printf foo \| \.\.\.$/
    ],
    [
      'grep -E "foo|bar" file.txt | head',
      /^grep -E "foo\|bar" file\.txt \| \.\.\.$/
    ],
    [
      'curl "https://example.com/a|b"',
      /^curl "https:\/\/example\.com\/a\|b"$/
    ],
  ];

  for (const [input, expected] of cases) {
    const result = sanitizer.sanitizeHookPayload('PreToolUse', {
      session_id: 's', tool_name: 'Bash', tool_use_id: 't',
      tool_input: { command: input }
    });
    assert.match(result.metadata.tool_detail, expected,
      `"${input.slice(0, 50)}" → "${result.metadata.tool_detail}"`);
  }
});

test('Bash tool_detail prefers description over command parsing', () => {
  const sanitizer = new Sanitizer('/home/howard/zylos');
  const result = sanitizer.sanitizeHookPayload('PreToolUse', {
    session_id: 's', tool_name: 'Bash', tool_use_id: 't',
    tool_input: { command: 'python3 -c "\nimport json\nprint(json.dumps({}))\n"', description: 'Check JSON output format' }
  });
  assert.equal(result.metadata.tool_detail, 'Check JSON output format');
});

test('Bash tool_detail falls back to command when no description', () => {
  const sanitizer = new Sanitizer('/home/howard/zylos');
  const result = sanitizer.sanitizeHookPayload('PreToolUse', {
    session_id: 's', tool_name: 'Bash', tool_use_id: 't',
    tool_input: { command: 'npm test 2>&1' }
  });
  assert.equal(result.metadata.tool_detail, 'npm test');
});

test('Skill tool_detail shows skill name', () => {
  const sanitizer = new Sanitizer('/home/howard/zylos');
  const result = sanitizer.sanitizeHookPayload('PreToolUse', {
    session_id: 's', tool_name: 'Skill', tool_use_id: 't',
    tool_input: { skill: 'issue-triage', args: '84' }
  });
  assert.equal(result.metadata.tool_detail, 'issue-triage');
});

test('Skill tool_detail handles missing skill name', () => {
  const sanitizer = new Sanitizer('/home/howard/zylos');
  const result = sanitizer.sanitizeHookPayload('PreToolUse', {
    session_id: 's', tool_name: 'Skill', tool_use_id: 't',
    tool_input: {}
  });
  assert.equal(result.metadata.tool_detail, undefined);
});

test('c4-send.js produces friendly labels with target extraction', () => {
  const sanitizer = new Sanitizer('/home/howard/zylos');

  const cases = [
    [
      'node /home/howard/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram" "8101553026|msg:17996|req:8101553026:17996"',
      'Send to telegram (8101553026)'
    ],
    [
      'node c4-send.js "hxa-connect" "org:default|Jinglever"',
      'Send to hxa-connect (Jinglever)'
    ],
    [
      'node /Users/howard/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "lark" "group:-1001234|msg:5"',
      'Send to lark (group:-1001234)'
    ],
    [
      'node c4-send.js "telegram" "8101553026"',
      'Send to telegram (8101553026)'
    ],
    [
      'node c4-send.js "web-console" "session-handoff"',
      'Send to web-console (session-handoff)'
    ],
    [
      'cat <<\'EOF\' | node /Users/howard/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "hxa-connect" "org:coco|zylos01"',
      'Send to hxa-connect (zylos01)'
    ],
    [
      'cat <<\'EOF\'| node c4-send.js "telegram" "8101553026|msg:123|req:8101553026:123"',
      'Send to telegram (8101553026)'
    ],
  ];

  for (const [input, expected] of cases) {
    const result = sanitizer.sanitizeHookPayload('PreToolUse', {
      session_id: 's', tool_name: 'Bash', tool_use_id: 't',
      tool_input: { command: input }
    });
    assert.strictEqual(result.metadata.tool_detail, expected,
      `"${input.slice(0, 60)}..." → "${result.metadata.tool_detail}"`);
  }
});

test('c4-control.js produces friendly labels', () => {
  const sanitizer = new Sanitizer('/home/howard/zylos');

  const cases = [
    [
      'node /home/howard/zylos/.claude/skills/comm-bridge/scripts/c4-control.js ack --id 42',
      'Control: ack #42'
    ],
    [
      'node c4-control.js enqueue --content "Heartbeat check" --priority 1',
      'Control: enqueue'
    ],
    [
      'node c4-control.js get --id 99',
      'Control: get #99'
    ],
    [
      'node c4-control.js ack --id "3100"',
      'Control: ack #3100'
    ],
  ];

  for (const [input, expected] of cases) {
    const result = sanitizer.sanitizeHookPayload('PreToolUse', {
      session_id: 's', tool_name: 'Bash', tool_use_id: 't',
      tool_input: { command: input }
    });
    assert.strictEqual(result.metadata.tool_detail, expected,
      `"${input.slice(0, 60)}..." → "${result.metadata.tool_detail}"`);
  }
});

test('c4 friendly labels reject false positives', () => {
  const sanitizer = new Sanitizer('/home/howard/zylos');

  const cases = [
    'echo c4-send.js "telegram" "123"',
    'node /path/to/not-c4-send.js "telegram" "123"',
    'grep c4-send.js README.md',
    'cat c4-control.js',
    'echo c4-control.js ack --id 5',
    "echo 'foo| node c4-send.js \"telegram\" \"123\"'",
    "grep 'foo| node c4-send.js \"telegram\" \"123\"' README.md",
    "printf 'foo| node c4-control.js ack --id \"3100\"'",
  ];

  for (const input of cases) {
    const result = sanitizer.sanitizeHookPayload('PreToolUse', {
      session_id: 's', tool_name: 'Bash', tool_use_id: 't',
      tool_input: { command: input }
    });
    const detail = result.metadata.tool_detail;
    assert.ok(!detail.startsWith('Send to') && !detail.startsWith('Control:'),
      `"${input}" should NOT produce friendly label, got: "${detail}"`);
  }
});

test('Read/Edit/Write tool_detail shortens paths to max 3 segments', () => {
  const sanitizer = new Sanitizer('/home/howard/zylos');

  const cases = [
    ['/home/howard/zylos/workspace/zylos-dashboard/src/lib/sanitizer.js', 'src/lib/sanitizer.js'],
    ['/home/howard/zylos/memory/identity.md', 'memory/identity.md'],
    ['/home/howard/zylos/a/b/c/d/e.js', 'c/d/e.js'],
    ['/tmp/outside-zylos/file.txt', 'file.txt'],
  ];

  for (const [input, expected] of cases) {
    for (const tool of ['Read', 'Edit', 'Write']) {
      const result = sanitizer.sanitizeHookPayload('PreToolUse', {
        session_id: 's', tool_name: tool, tool_use_id: 't',
        tool_input: { file_path: input }
      });
      assert.strictEqual(result.metadata.tool_detail, expected,
        `${tool} "${input}" → "${result.metadata.tool_detail}"`);
    }
  }
});

test('UserPromptSubmit shows prompt source from reply via', () => {
  const sanitizer = new Sanitizer('/home/howard/zylos');

  const cases = [
    [
      '[TG DM] howardzhou said: hello ---- reply via: node /home/howard/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram" "8101553026|msg:123"',
      'Prompt from telegram (8101553026)',
      'telegram (8101553026)'
    ],
    [
      '[HXA:default DM] Jinglever said: review done ---- reply via: node c4-send.js "hxa-connect" "org:default|Jinglever"',
      'Prompt from hxa-connect (Jinglever)',
      'hxa-connect (Jinglever)'
    ],
    [
      'Heartbeat check ---- ack via: node c4-control.js ack --id 42',
      'Prompt from control',
      'control'
    ],
    [
      'just a plain prompt from the terminal',
      'Prompt received',
      null
    ],
  ];

  for (const [prompt, expectedSummary, expectedSource] of cases) {
    const result = sanitizer.sanitizeHookPayload('UserPromptSubmit', {
      session_id: 's', prompt
    });
    assert.strictEqual(result.summary, expectedSummary,
      `prompt "${prompt.slice(0, 50)}..." → summary "${result.summary}"`);
    assert.strictEqual(result.metadata.prompt_source || null, expectedSource,
      `prompt "${prompt.slice(0, 50)}..." → source ${result.metadata.prompt_source}`);
  }
});

// --- Issue #182: phantom running tool from out-of-order pre/post ingestion ---

test('post_tool_use arriving before its pre_tool_use leaves no phantom running tool', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'post_tool_use',
    timestamp: new Date(1000018).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-fast', tool_name: 'Read' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-fast', tool_name: 'Read' }
  });

  assert.equal(engine.getRunningTools().length, 0, 'out-of-order pair must not register a running tool');
});

test('tool tombstone only suppresses its own tool_use_id', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'post_tool_use',
    timestamp: new Date(1000018).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-a', tool_name: 'Read' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000020).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-b', tool_name: 'Bash' }
  });

  assert.equal(engine.getRunningTools().length, 1, 'unrelated tool must still register');
  assert.equal(engine.getRunningTools()[0].tool_name, 'Bash');
});

test('tombstone is consumed: same tool_use_id registers normally afterwards', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'post_tool_use',
    timestamp: new Date(1000018).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-a', tool_name: 'Read' }
  });
  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000020).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-a', tool_name: 'Read' }
  });
  assert.equal(engine.getRunningTools().length, 0);

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000030).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-a', tool_name: 'Read' }
  });
  assert.equal(engine.getRunningTools().length, 1, 'tombstone must not outlive its match');
});

test('main session switch via user_prompt_submit sweeps orphaned foreground tools', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-old',
    metadata: {}
  });
  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'sess-old',
    metadata: { tool_use_id: 'tool-orphan', tool_name: 'Read' }
  });
  assert.equal(engine.getRunningTools().length, 1);

  // sess-old dies mid-tool (no stop event); a new main session takes over
  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1011000).toISOString(),
    session_id: 'sess-new',
    metadata: {}
  });

  assert.equal(engine.getRunningTools().length, 0, 'foreground tools of superseded session must be swept');
});

test('main session switch keeps subagent tools and current-session tools', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-old',
    metadata: {}
  });
  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'sess-old',
    metadata: { tool_use_id: 'tool-orphan', tool_name: 'Read' }
  });
  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'sub-sess',
    metadata: { tool_use_id: 'tool-sub', tool_name: 'WebSearch', agent_id: 'agent-1' }
  });

  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1011000).toISOString(),
    session_id: 'sess-new',
    metadata: {}
  });
  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1011100).toISOString(),
    session_id: 'sess-new',
    metadata: { tool_use_id: 'tool-live', tool_name: 'Bash' }
  });

  const names = engine.getRunningTools().map(t => t.tool_name).sort();
  assert.deepEqual(names, ['Bash', 'WebSearch'], 'subagent + current-session tools must survive the sweep');
});
