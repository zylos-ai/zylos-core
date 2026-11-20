import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as child from 'node:child_process';
const calls = [];
mock.module('node:child_process', { namedExports: { ...child,
  execFile(command, args, options, callback) {
    calls.push({ command, args, options });
    queueMicrotask(() => callback(Object.assign(new Error('timed out'), { killed: true }), '', ''));
  },
} });
const { handleAction } = await import('../actions.js');
const { jsonResponse } = await import('../http.js');
test('Antigravity timeout reports incomplete and allows five minutes without restarting a session', async () => {
  const result = await handleAction('upgrade-cc', { runtime: 'agy' }, {});
  assert.equal(result.ok, false); assert.equal(result.error, 'deadline_exceeded');
  assert.equal(result.messageKey, 'result.agy_upgrade_incomplete');
  assert.match(result.message, /did not complete/); assert.doesNotMatch(result.message, /updated/);
  assert.equal(result.requires_restart, undefined);
  assert.equal(jsonResponse(200, result, { command: true }).status, 504);
  assert.equal(calls.length, 1); assert.equal(calls[0].command, 'agy');
  assert.deepEqual(calls[0].args, ['update']); assert.equal(calls[0].options.timeout, 300000);
  assert.equal(calls[0].options.killSignal, 'SIGKILL');
});
