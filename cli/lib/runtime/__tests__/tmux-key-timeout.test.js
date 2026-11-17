import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmuxClientArgs } from '../tmux-client-args.js';

const calls = [];
const failure = Object.assign(Error('timed out'), { code: 'ETIMEDOUT' });
let fail = true;
mock.module('node:child_process', { namedExports: {
  execFileSync(bin, args, options) {
    if (args[0] === '-V') return 'tmux 3.3a';
    calls.push({ bin, args, options });
    if (fail) throw failure;
    return '';
  },
} });
const { tmuxSendKeys, tmuxPasteBuffer } = await import('../tmux-helpers.js');

test('runtime key delivery keeps a finite timeout and propagates timeout failure', t => {
  assert.throws(() => tmuxSendKeys('agent', 'Enter'), caught => caught === failure);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'tmux');
  assert.deepEqual(calls[0].args, [...tmuxClientArgs({ utf8: false }), 'send-keys', '-t', 'agent', 'Enter']);
  assert.equal(calls[0].options.timeout, 3000);
});

test('runtime buffer delivery bounds load, paste and Enter calls', () => {
  calls.length = 0;
  fail = false;
  tmuxPasteBuffer('agent', '/private/message', 'message-buffer');
  const prefix = tmuxClientArgs({ utf8: false });
  assert.deepEqual(calls.map(call => call.args.slice(prefix.length)), [
    ['load-buffer', '-b', 'message-buffer', '/private/message'],
    ['paste-buffer', '-b', 'message-buffer', '-t', 'agent'],
    ['send-keys', '-t', 'agent', 'Enter'],
  ]);
  assert.ok(calls.every(call => call.options.timeout === 3000));
  fail = true;
  assert.throws(() => tmuxPasteBuffer('agent', '/private/message', 'message-buffer'), caught => caught === failure);
  mock.restoreAll();
});
