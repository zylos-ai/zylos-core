import test from 'node:test';
import assert from 'node:assert/strict';
import { attachCommand } from '../../commands/attach.js';

const status = { view: 'multi', origin: { presence: 'not_running' }, originNeed: { inbound: 0, controls: 0, oldestAt: null }, runtimeHealth: {}, readAt: 1_000_000 };
async function absentAttach(sessionGroup, data = status) {
  const originalError = console.error, originalExit = process.exit;
  const lines = [], calls = [];
  console.error = message => lines.push(message);
  process.exit = code => { throw Object.assign(new Error('fixture exit'), { exitCode: code }); };
  try {
    await assert.rejects(attachCommand({ resolve: async () => ({ sessionGroup, runtime: 'codex', live: { tmuxName: 'zylos-group-origin' } }),
      exec: (command, args) => { calls.push([command, args]); throw new Error('absent'); },
      collect: async () => { assert.equal(sessionGroup, 'origin'); return data; },
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
test('single absence keeps the existing initialization advice', async () => {
  const text = await absentAttach(null);
  assert.match(text, /No active codex session/);
  assert.doesNotMatch(text, /Origin is asleep|Group sessions start/);
});

test('marker-only Origin attach reports waking or authentication and sleeps once cleared', async () => {
  const data = { ...status, originNeed: { inbound: 0, controls: 0, continuation: true, oldestAt: 999 } };
  assert.match(await absentAttach('origin', data), /Origin is waking up/);
  assert.match(await absentAttach('origin', { ...data, runtimeHealth: { codex: { health: 'auth_failed' } } }), /codex authentication/);
  data.originNeed = { inbound: 0, controls: 0, continuation: false, oldestAt: null };
  assert.match(await absentAttach('origin', data), /Origin is asleep/);
});
