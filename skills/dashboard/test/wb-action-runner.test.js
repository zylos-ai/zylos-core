import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRM_ACTIONS, createActionRunner } from '../public/js/wb/action-runner.js';

const t = (key, params = {}) => key + (Object.keys(params).length ? ':' + JSON.stringify(params) : '');

// A runner whose confirmation answers `answer` and records every question; `sent` records what reaches the server.
function runner({ answer = true, readOnly = false, remote = null, prepare } = {}) {
  const asked = [], sent = [];
  const run = createActionRunner({ t, readOnly: () => readOnly, remoteTarget: () => remote, prepare,
    confirmText: (action, body) => `ask:${action}:${JSON.stringify(body ?? null)}`,
    confirm: async text => { asked.push(text); return answer; },
    send: async (action, body) => { sent.push({ action, body }); return true; } });
  return { run, asked, sent };
}

test('actions that change the running agent ask first, and cancelling sends nothing', async () => {
  for (const action of CONFIRM_ACTIONS) {
    const no = runner({ answer: false });
    assert.equal(await no.run.exec(action, { value: 1 }), false);
    assert.equal(no.asked.length, 1, action + ' asks once');
    assert.deepEqual(no.sent, [], action + ' sends nothing on cancel');
    const yes = runner();
    assert.equal(await yes.run.exec(action, { value: 1 }), true);
    assert.equal(yes.asked.length, 1);
    assert.deepEqual(yes.sent, [{ action, body: { value: 1 } }]);
  }
  assert.deepEqual([...CONFIRM_ACTIONS].sort(), ['restart-session', 'switch-effort', 'switch-mode', 'switch-model', 'switch-runtime', 'upgrade-cc', 'upgrade-zylos']);
});

test('other actions run without asking', async () => {
  const { run, asked, sent } = runner({ answer: false });
  assert.equal(await run.exec('set-threshold', { value: 70 }), true);
  assert.deepEqual(asked, []);
  assert.deepEqual(sent, [{ action: 'set-threshold', body: { value: 70 } }]);
});

test('the question names the remote machine the action acts on', async () => {
  const { run, asked } = runner({ remote: 'lab' });
  await run.exec('switch-model', { model: 'two' });
  assert.deepEqual(asked, ['ask:switch-model:{"model":"two"}\nconfirm.remote_target:{"agent":"lab"}']);
});

test('confirmed changes run without asking again', async () => {
  const { run, asked, sent } = runner({ answer: false, remote: 'lab' });
  assert.equal(await run.runConfirmed('switch-model', { model: 'two' }), true);
  assert.deepEqual(asked, [], 'runConfirmed never asks');
  assert.deepEqual(sent, [{ action: 'switch-model', body: { model: 'two' } }]);
  assert.equal(run.exec.length, 2, 'exec takes no third argument that could skip the question');
});

test('nothing runs or asks while the viewed machine was reached with a read-only key, or when the page has not said', async () => {
  const ro = runner({ readOnly: true });
  assert.equal(await ro.run.exec('switch-model', { model: 'two' }), false);
  assert.equal(await ro.run.runConfirmed('switch-model', { model: 'two' }), false);
  assert.equal(await ro.run.exec('set-threshold', { value: 70 }), false);
  assert.deepEqual(ro.asked, []); assert.deepEqual(ro.sent, []);
  const sent = [];
  const unsaid = createActionRunner({ t, confirmText: () => '', confirm: async () => true, send: async (action) => { sent.push(action); return true; } });
  assert.equal(await unsaid.exec('set-threshold', {}), false);
  assert.equal(await unsaid.runConfirmed('switch-model', {}), false);
  assert.deepEqual(sent, []);
});

test('a manual restart is prepared before the question and sent as prepared', async () => {
  const { run, asked, sent } = runner({ prepare: (action, body) => (action === 'restart-session' ? { ...body, runId: 'r1' } : body) });
  await run.exec('restart-session');
  assert.deepEqual(asked, ['ask:restart-session:{"runId":"r1"}']);
  assert.deepEqual(sent, [{ action: 'restart-session', body: { runId: 'r1' } }]);
});
