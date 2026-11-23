import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTmuxSender, parseTmuxVersion, describeTmuxSendKeys } from '../../../skills/comm-bridge/scripts/tmux-send-keys.js';
import { tmuxClientArgs } from '../runtime/tmux-client-args.js';

for (const [version, enabled] of [['3.2a', false], ['3.3a', false], ['3.4', true], ['3.6a', true], ['3.7c', true], ['3.10', true], ['4.0', true], ['next-3.8', true], ['next-3.9', true]]) {
  test(`tmux ${version} version gate and cached execution`, () => {
    const calls = [];
    const sender = createTmuxSender({ binary: '/test/tmux', exec: (bin, args, opts) => {
      calls.push({ bin, args, opts }); return `tmux ${version}`;
    } });
    assert.equal(calls.length, 0);
    assert.equal(parseTmuxVersion(`tmux ${version}`).version, version);
    const options = { timeout: 5000, stdio: 'pipe' };
    sender.sendKeys('agent', ['Enter'], options);
    sender.sendKeys('agent', ['Escape'], options);
    assert.equal(calls.filter(c => c.args[0] === '-V').length, 1);
    assert.ok(calls.every(c => c.bin === '/test/tmux'));
    for (let i = 1; i <= 2; i++) {
      assert.deepEqual(calls[i].args, [...tmuxClientArgs({ utf8: false }), 'send-keys', ...(enabled ? ['-c', 'zylos-no-client'] : []), '-t', 'agent', i === 1 ? 'Enter' : 'Escape']);
      assert.equal(calls[i].opts, options);
    }
    assert.match(describeTmuxSendKeys(sender.getCapability()), enabled ? /-c enabled/ : /-c disabled/);
  });
}
// The retired dispatcher source extraction moved to router-delivery.test.js:
// "Enter failure increments retry, invalid keystroke rejected; valid keystroke always acks".
// Real bound-key/version behavior remains in the runtime adapter test matrix.
