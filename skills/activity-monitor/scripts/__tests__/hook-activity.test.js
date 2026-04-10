import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-activity-test-'));
const monitorDir = path.join(tmpDir, 'activity-monitor');
const eventsFile = path.join(monitorDir, 'tool-events.jsonl');

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
  it('appends pre_tool with event_id, summary, and session_id', async () => {
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'payload-session',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com/path' }
    }, 1000);

    const [event] = readEvents();
    assert.equal(event.event, 'pre_tool');
    assert.equal(event.session_id, 'payload-session');
    assert.equal(event.tool, 'WebFetch');
    assert.match(event.event_id, /^evt_/);
    assert.deepEqual(event.summary, { type: 'url-host', value: 'example.com' });
  });

  it('appends PostToolUseFailure without mutating prior events', async () => {
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-1',
      tool_name: 'WebSearch',
      tool_input: { query: 'issue 492' }
    }, 1000);
    await runHook({
      hook_event_name: 'PostToolUseFailure',
      session_id: 'session-1',
      tool_name: 'WebSearch'
    }, 1100);

    const events = readEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'pre_tool');
    assert.equal(events[1].event, 'post_tool_failure');
    assert.equal(events[1].session_id, 'session-1');
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
});
