import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleAgyHook } from '../agy-hooks.js';
import { handleHookActivity } from '../hook-activity.js';
import { SessionActivity } from '../session-activity.js';
import { buildKickPrompt } from '../../../../cli/lib/runtime/kick-prompt.js';
import { hooks } from '../../../../cli/lib/runtime/agy/hooks.js';

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
  assert.match(JSON.parse(hooks.output({ event: 'SessionStart', result: injected })).injectSteps[0].systemMessage.systemMessage, /COMPLETE_SYSTEM_AND_USER_RULES/);
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

