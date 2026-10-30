import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-activity-test-'));
const monitorDir = path.join(tmpDir, 'activity-monitor');
const eventsFile = path.join(monitorDir, 'events.jsonl');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(monitorDir, { recursive: true, force: true });
});

async function runHook(payload, nowMs = 1000) {
  process.env.ZYLOS_DIR = tmpDir;
  process.env.CLAUDE_SESSION_ID = 'env-session';
  process.env.HOOK_ACTIVITY_DISABLE_MAIN = '1';
  const modulePath = new URL('../hook-activity.js', import.meta.url);
  const { handleHookActivity } = await import(`${modulePath.href}?t=${Date.now()}-${Math.random()}`);
  handleHookActivity(payload, { nowMs, claudePid: 4242 });
}

function readEvents() {
  return fs.readFileSync(eventsFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('hook-activity', () => {
  it('uses Claude tool_use_id as tool_use_id when present', async () => {
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'payload-session',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com/path' },
      tool_use_id: 'toolu_01ABC123'
    }, 1000);

    const [event] = readEvents();
    assert.equal(event.event, 'pre_tool');
    assert.equal(event.session_id, 'payload-session');
    assert.equal(event.tool, 'WebFetch');
    assert.equal(event.tool_use_id, 'toolu_01ABC123');
    assert.deepEqual(event.tool_input, { url: 'https://example.com/path' });
  });

  it('preserves absent native tool_use_id without fabricating one', async () => {
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'payload-session',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com/fallback' }
    }, 1000);

    const [event] = readEvents();
    assert.equal(Object.hasOwn(event, 'tool_use_id'), false);
  });

  it('appends PostToolUseFailure with the same event_id and summary', async () => {
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-1',
      tool_name: 'WebSearch',
      tool_input: { query: 'issue 492' },
      tool_use_id: 'toolu_search_1'
    }, 1000);
    await runHook({
      hook_event_name: 'PostToolUseFailure',
      session_id: 'session-1',
      tool_name: 'WebSearch',
      tool_input: { query: 'issue 492' },
      tool_use_id: 'toolu_search_1'
    }, 1100);

    const events = readEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'pre_tool');
    assert.equal(events[1].event, 'post_tool_failure');
    assert.equal(events[1].session_id, 'session-1');
    assert.equal(events[1].tool_use_id, 'toolu_search_1');
    assert.deepEqual(events[1].tool_input, { query: 'issue 492' });
  });

  it('records prompt events without tool fields', async () => {
    await runHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-2'
    }, 1200);

    const [event] = readEvents();
    assert.equal(event.event, 'prompt');
    assert.equal(event.session_id, 'session-2');
    assert.equal(Object.hasOwn(event, 'tool'), false);
  });

  it('records PostToolUse as post_tool event', async () => {
    await runHook({
      hook_event_name: 'PostToolUse',
      session_id: 'session-3',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' },
      tool_use_id: 'toolu_post_1'
    }, 2000);

    const [event] = readEvents();
    assert.equal(event.event, 'post_tool');
    assert.equal(event.tool, 'WebFetch');
    assert.equal(event.tool_use_id, 'toolu_post_1');
  });

  it('records Stop as stop event without tool fields', async () => {
    await runHook({
      hook_event_name: 'Stop',
      session_id: 'session-4'
    }, 3000);

    const [event] = readEvents();
    assert.equal(event.event, 'stop');
    assert.equal(event.session_id, 'session-4');
    assert.equal(Object.hasOwn(event, 'tool'), false);
  });

  it('records Notification as idle event', async () => {
    await runHook({
      hook_event_name: 'Notification', notification_type: 'idle_prompt',
      session_id: 'session-5'
    }, 4000);

    const [event] = readEvents();
    assert.equal(event.event, 'idle');
  });

  it('retains subagent hook facts with agent_id', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    process.env.HOOK_ACTIVITY_DISABLE_MAIN = '1';
    const modulePath = new URL('../hook-activity.js', import.meta.url);
    const { handleHookActivity } = await import(`${modulePath.href}?t=${Date.now()}-${Math.random()}`);
    const result = handleHookActivity({
      hook_event_name: 'PreToolUse',
      session_id: 'session-subagent',
      agent_id: 'agent-123',
      agent_type: 'Explore',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com/subagent' },
      tool_use_id: 'toolu_subagent_1'
    }, { nowMs: 4500, claudePid: 4242 });
    assert.equal(result.agent_id, 'agent-123');
    assert.equal(fs.existsSync(eventsFile), true);
  });

  it('still records root-agent events when only agent_type is present', async () => {
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-agent-mode',
      agent_type: 'security-reviewer',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com/root-agent' },
      tool_use_id: 'toolu_root_agent_1'
    }, 4600);

    const [event] = readEvents();
    assert.equal(event.event, 'pre_tool');
    assert.equal(event.session_id, 'session-agent-mode');
    assert.equal(event.tool_use_id, 'toolu_root_agent_1');
  });

  it('returns null for unknown hook event', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    process.env.HOOK_ACTIVITY_DISABLE_MAIN = '1';
    const modulePath = new URL('../hook-activity.js', import.meta.url);
    const { handleHookActivity } = await import(`${modulePath.href}?t=${Date.now()}-${Math.random()}`);
    const result = handleHookActivity({ hook_event_name: 'UnknownEvent' }, { nowMs: 5000, claudePid: 4242 });
    assert.equal(result, null);
  });

  it('returns null when session_id is missing', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    delete process.env.CLAUDE_SESSION_ID;
    process.env.HOOK_ACTIVITY_DISABLE_MAIN = '1';
    const modulePath = new URL('../hook-activity.js', import.meta.url);
    const { handleHookActivity } = await import(`${modulePath.href}?t=${Date.now()}-${Math.random()}`);
    const result = handleHookActivity({
      hook_event_name: 'PreToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' }
    }, { nowMs: 6000, claudePid: 4242 });
    assert.equal(result, null);
    // Restore for other tests
    process.env.CLAUDE_SESSION_ID = 'env-session';
  });

  it('leaves watchdog classification to the consumer', async () => {
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-6',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' },
      tool_use_id: 'toolu_rule_1'
    }, 7000);

    const [event] = readEvents();
    assert.equal(Object.hasOwn(event, 'rule_id'), false);
  });

  it('does not assign rule_id for non-matching tools', async () => {
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-7',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/foo' },
      tool_use_id: 'toolu_read_1'
    }, 8000);

    const [event] = readEvents();
    assert.equal(Object.hasOwn(event, 'rule_id'), false);
  });
});
