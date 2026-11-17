import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleAgyHook, normalizeAgyHook, runAgySessionStart } from '../agy-hooks.js';
import { publishBootstrapReady } from '../bootstrap-ready.js';
import { acceptAgyMainEvent } from '../agy-main-session.js';
import { handleHookActivity } from '../hook-activity.js';
import { SessionActivity } from '../session-activity.js';
import { publishContextSample } from '../context-monitor.js';
import { buildKickPrompt } from '../../../../cli/lib/runtime/kick-prompt.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-main-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ZYLOS_DIR: root, ZYLOS_RUN_ID: 'run', ZYLOS_MODEL_CONFIG: '{"runtime":"agy"}' };
  const dir = path.join(root, 'activity-monitor/session-groups/origin');
  fs.mkdirSync(dir, { recursive: true });
  let clock = 1000, startups = [];
  const options = { env, health: () => null, activity: payload => handleHookActivity(payload, { env, nowMs: clock++ }),
    instructions: () => 'COMPLETE_SYSTEM_AND_USER_RULES',
    orchestrate: async payload => { startups.push(payload); } };
  const send = (eventName, conversationId = 'parent', extra = {}) => handleAgyHook({ conversationId, ...extra }, { ...options, eventName });
  return { root, env, dir, options, send, startups,
    kick: (id = 'parent') => send('SessionStart', id, { lastUserInput: buildKickPrompt() }),
    events: () => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
}

test('interleaved child sessions cannot inject, change main identity or end the parent turn', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.send('SessionStart', 'early-child', { lastUserInput: 'worker task' }), {});
  assert.equal(fs.existsSync(path.join(f.dir, 'agy-main-session.json')), false);
  const injected = await f.kick();
  assert.match(injected.injectSteps[0].systemMessage.systemMessage, /COMPLETE_SYSTEM_AND_USER_RULES/);
  await f.send('PreInvocation', 'parent', { invocationNum: 0 });
  assert.deepEqual(await f.send('SessionStart', 'child'), {});
  await f.send('PreInvocation', 'child', { invocationNum: 0 });
  await f.send('Stop', 'child', { fullyIdle: true });
  assert.equal(f.startups.length, 1);
  assert.equal(f.startups[0].session_id, 'parent');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'agy-main-session.json'))).conversationId, 'parent');
  const events = f.events(); assert.ok(events.every(event => event.session_id === 'parent'));
  const activity = new SessionActivity({ runDir: f.dir, runId: 'run', sessionId: 'parent', runtime: 'agy', startedAt: 0 });
  t.after(() => activity.close()); activity.consume(events);
  assert.equal(activity.read(5000).state, 'busy');
});

test('clear marker survives child events and only the new main kick advances identity', async t => {
  const f = fixture(t); await f.kick();
  publishContextSample({ conversation_id: 'parent', agent_state: 'idle' }, { env: f.env, now: 2000 });
  const marker = path.join(f.dir, 'agy-session-source');
  fs.writeFileSync(marker, JSON.stringify({ runId: 'run', source: 'clear' }));
  assert.deepEqual(await f.send('SessionStart', 'child'), {});
  await f.send('Stop', 'child', { fullyIdle: true });
  assert.equal(fs.existsSync(marker), true);
  await f.kick('new-parent');
  assert.equal(f.startups.at(-1).source, 'clear');
  assert.equal(fs.existsSync(marker), false);
  const count = f.events().length;
  await f.send('Stop', 'parent', { fullyIdle: true });
  assert.equal(f.events().length, count);
});

test('a child startup cannot replace the real bootstrap current-session record', async t => {
  const f = fixture(t);
  f.options.orchestrate = payload => runAgySessionStart(payload, {
    env: f.env, chainBuilder: () => ({ chain: [] }), foreground: () => {},
    ready: value => publishBootstrapReady(value, { env: f.env,
      identityReader: async () => {}, enqueue: async () => ({ skipped: true, reason: 'fixture' }) }),
  });
  await f.kick();
  const file = path.join(f.dir, 'current-session.json');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(before).sessionId, 'parent');
  assert.deepEqual(await f.kick('child'), {});
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('current run statusLine can prove main identity but a stale run cannot', t => {
  const f = fixture(t);
  publishContextSample({ conversation_id: 'parent' }, { env: { ...f.env, ZYLOS_RUN_ID: 'old-run' } });
  assert.equal(acceptAgyMainEvent({ conversationId: 'parent' }, 'PreInvocation', f.env), null);
  publishContextSample({ conversation_id: 'parent' }, { env: f.env });
  assert.equal(acceptAgyMainEvent({ conversationId: 'child' }, 'SessionStart', f.env), null);
  assert.equal(acceptAgyMainEvent({ conversationId: 'parent' }, 'PreInvocation', f.env).record.conversationId, 'parent');
});

test('terminal custom hook ends normally and next main invocation restores rules once', async t => {
  const f = fixture(t); await f.kick();
  const stop = { terminationReason: 'TERMINAL_CUSTOM_HOOK', fullyIdle: true };
  assert.equal(normalizeAgyHook({ conversationId: 'parent', ...stop }, 'Stop').hook_event_name, 'Stop');
  await f.send('Stop', 'parent', stop);
  assert.equal(await f.send('PreInvocation', 'child', { invocationNum: 0 }), null);
  const restored = await f.send('PreInvocation', 'parent', { invocationNum: 3 });
  assert.equal(restored.injectSteps[0].systemMessage.systemMessage, 'COMPLETE_SYSTEM_AND_USER_RULES');
  assert.equal(f.startups.length, 1, 'rule restore must not rerun startup orchestration');
  assert.equal(await f.send('PreInvocation', 'parent', { invocationNum: 4 }), null);
});

test('run_command native IDs track background tool start and completion only for the main session', async t => {
  const f = fixture(t); await f.kick();
  const toolCall = { id: 'tool-id', name: 'run_command', args: { CommandLine: 'sleep 20', Cwd: '/isolated', secret: 'omit' } };
  await f.send('PreToolUse', 'child', { toolCall });
  await f.send('PreToolUse', 'parent', { toolCall });
  const activity = new SessionActivity({ runDir: f.dir, runId: 'run', sessionId: 'parent', runtime: 'agy', startedAt: 0 });
  t.after(() => activity.close()); activity.consume(f.events());
  assert.equal(activity.tools.size, 1);
  await f.send('PostToolUse', 'child', { toolCall });
  assert.equal(f.events().filter(event => event.event === 'post_tool').length, 0);
  await f.send('PostToolUse', 'parent', { toolCall });
  const events = f.events(); activity.consume(events);
  assert.equal(activity.tools.size, 0);
  const [pre, post] = events.filter(event => event.tool_use_id);
  assert.equal(pre.tool_use_id, post.tool_use_id); assert.equal(pre.tool, 'run_command');
  assert.deepEqual(pre.tool_input, { CommandLine: 'sleep 20', Cwd: '/isolated' });
  const failed = normalizeAgyHook({ conversationId: 'parent', toolCall, error: 'private error' }, 'PostToolUse');
  assert.equal(failed.hook_event_name, 'PostToolUseFailure'); assert.equal(failed.error, 'tool_error');
});

test('native network error strings produce only a sanitized health category', () => {
  for (const error of ['proxyconnect tcp: dial tcp: connection refused', 'ECONNREFUSED', 'ENETUNREACH']) {
    assert.equal(normalizeAgyHook({ conversationId: 'main', terminationReason: 'ERROR', error }, 'Stop').error, 'network_error');
  }
  assert.equal(normalizeAgyHook({ conversationId: 'main', terminationReason: 'ERROR', error: 'proxyconnect API_KEY_INVALID' }, 'Stop').error, 'authentication_failed');
});
