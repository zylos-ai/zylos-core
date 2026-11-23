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
  return handleHookActivity(payload, { nowMs, claudePid: 4242 });
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

  it('retains subagent hook facts with agent_id', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    process.env.HOOK_ACTIVITY_DISABLE_MAIN = '1';
    const modulePath = new URL('../hook-activity.js', import.meta.url);
    const { handleHookActivity } = await import(`${modulePath.href}?t=${Date.now()}-${Math.random()}`);
    const result = await handleHookActivity({
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

});
