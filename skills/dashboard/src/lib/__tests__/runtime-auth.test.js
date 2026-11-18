import test from 'node:test';
import assert from 'node:assert/strict';

test('runtime authentication errors display original details while other errors retain their message key', async t => {
  let reply;
  t.mock.module('../core-actions.js', { namedExports: {
    handleCoreAction: async () => reply,
  } });
  const { handleAction } = await import('../actions.js');
  for (const code of ['AUTH_FAILED', 'AUTH_NOT_CONFIRMED', 'RUNTIME_NOT_INSTALLED']) {
    reply = { ok: false, error: { code, message: 'Original probe explanation' }, messageKey: 'result.runtime_unknown' };
    const result = await handleAction('switch-runtime', { runtime: 'codex', request: code }, {});
    assert.deepEqual(result.error, reply.error);
    if (code === 'RUNTIME_NOT_INSTALLED') {
      assert.equal(result.messageKey, reply.messageKey);
    } else {
      assert.equal(result.messageKey, null);
      assert.equal(result.message, `${code}: Original probe explanation`);
    }
  }
});
