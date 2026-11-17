import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmuxClientArgs } from '../tmux-client-args.js';

const calls = [];
const failure = Object.assign(Error('timed out'), { code: 'ETIMEDOUT' });
mock.module('node:child_process', { namedExports: {
  execFileSync(bin, args, options) {
    if (args[0] === '-V') return 'tmux 3.3a';
    calls.push({ bin, args, options }); throw failure;
  },
} });
const { tmuxSendKeys } = await import('../tmux-helpers.js');

test('runtime key delivery keeps a finite timeout and propagates timeout failure', t => {
  t.after(() => mock.restoreAll());
  assert.throws(() => tmuxSendKeys('agent', 'Enter'), caught => caught === failure);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'tmux');
  assert.deepEqual(calls[0].args, [...tmuxClientArgs({ utf8: false }), 'send-keys', '-t', 'agent', 'Enter']);
  assert.equal(calls[0].options.timeout, 3000);
});
