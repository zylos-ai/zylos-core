import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from '../config.js';
import { attachCommand } from '../../commands/attach.js';
import { tmuxClientArgs } from '../runtime/tmux-client-args.js';

const status = { view: 'multi', origin: { presence: 'not_running' }, originNeed: { inbound: 0, controls: 0, oldestAt: null }, runtimeHealth: {}, readAt: 1_000_000 };

test('attach client removes inherited identity and forwards all other environment values', async t => {
  const inherited = {
    ZYLOS_RUN_ID: 'parent-run',
    ZYLOS_MODEL_CONFIG: '{"runtime":"claude"}',
    ZYLOS_SESSION_GROUP: 'parent-group',
    ZYLOS_ATTACH_ENV_FIXTURE: 'spaces $ and \\ remain literal',
  };
  const previous = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, inherited);
  const before = { ...process.env };
  const calls = [];
  await attachCommand({
    resolve: async () => ({ sessionGroup: 'origin', runtime: 'codex', live: { tmuxName: 'zylos-group-origin' } }),
    exec: (command, args, options) => { calls.push({ command, args, options }); },
  });
  assert.equal(calls.length, 3);
  const attached = calls.at(-1);
  assert.equal(attached.command, 'tmux');
  assert.deepEqual(attached.args, [...tmuxClientArgs({ utf8: false }), 'attach', '-t', '=zylos-group-origin']);
  assert.equal(attached.options.stdio, 'inherit');
  const expected = { ...before };
  for (const key of ['ZYLOS_RUN_ID', 'ZYLOS_MODEL_CONFIG', 'ZYLOS_SESSION_GROUP']) delete expected[key];
  assert.deepEqual(attached.options.env, expected);
  assert.deepEqual({ ...process.env }, before);
});

async function absentAttach(sessionGroup, data = status) {
  const originalError = console.error, originalExit = process.exit;
  const lines = [], calls = [];
  console.error = message => lines.push(message);
  process.exit = code => { throw Object.assign(new Error('fixture exit'), { exitCode: code }); };
  try {
    await assert.rejects(attachCommand({ resolve: async () => ({ sessionGroup, runtime: 'codex', live: { tmuxName: 'zylos-group-origin' } }),
      exec: (command, args) => { calls.push([command, args]); throw new Error('absent'); },
      collect: async () => { assert.ok(sessionGroup === 'origin' || sessionGroup === null && data.sessionMode === 'single'); return data; },
    }), error => error.exitCode === 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'tmux');
    return lines.join('\n');
  } finally { console.error = originalError; process.exit = originalExit; }
}
test('absent Origin attach explains sleep without starting a session', async () => {
  assert.match(await absentAttach('origin'), /Origin is asleep/);
});
test('absent Origin attach uses target runtime authentication and read errors', async () => {
  const text = await absentAttach('origin', { ...status, originNeed: { inbound: 1, controls: 0, oldestAt: 1 }, runtimeHealth: { codex: { health: 'auth_failed' } } });
  assert.match(text, /codex authentication/);
  assert.match(await absentAttach('origin', { ...status, originNeed: { error: { message: 'C4 unreadable' } } }), /C4 unreadable/);
});
test('absent group attach waits for its next message without reading C4', async () => {
  assert.equal(await absentAttach('telegram_group'), 'No active session for telegram_group. Group sessions start when a message for the group arrives.');
});
test('single absence distinguishes pre-migration advice from native Origin sleep', async t => {
  const text = await absentAttach(null);
  assert.match(text, /No active codex session/);
  assert.doesNotMatch(text, /Origin is asleep|Group sessions start/);
  // The real mode reader sees only the runner's isolated configuration.
  const previous = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE) : null;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  t.after(() => { if (previous === null) fs.rmSync(CONFIG_FILE); else fs.writeFileSync(CONFIG_FILE, previous); });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ session_mode: 'single' }));
  const native = await absentAttach(null, { ...status, view: 'single', sessionMode: 'single' });
  assert.match(native, /Origin is asleep/);
  assert.doesNotMatch(native, /No active codex session|First time|zylos init/);
});

test('marker-only Origin attach reports waking or authentication and sleeps once cleared', async () => {
  const data = { ...status, originNeed: { inbound: 0, controls: 0, continuation: true, oldestAt: 999 } };
  assert.match(await absentAttach('origin', data), /Origin is waking up/);
  assert.match(await absentAttach('origin', { ...data, runtimeHealth: { codex: { health: 'auth_failed' } } }), /codex authentication/);
  data.originNeed = { inbound: 0, controls: 0, continuation: false, oldestAt: null };
  assert.match(await absentAttach('origin', data), /Origin is asleep/);
});
