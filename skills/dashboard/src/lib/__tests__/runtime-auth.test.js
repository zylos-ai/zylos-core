import test from 'node:test';
import assert from 'node:assert/strict';

test('runtime authentication and hook readiness errors display original details while other errors retain their message key', async t => {
  let reply;
  t.mock.module('../core-actions.js', { namedExports: {
    handleCoreAction: async () => reply,
  } });
  const { handleAction } = await import('../actions.js');
  const write = process.stderr.write;
  for (const code of ['AUTH_FAILED', 'AUTH_NOT_CONFIRMED', 'RUNTIME_SETUP_INCOMPLETE', 'RUNTIME_NOT_INSTALLED']) {
    reply = { ok: false, error: { code, message: 'Original probe explanation' }, messageKey: 'result.runtime_unknown' };
    const logged = [];
    process.stderr.write = chunk => { logged.push(String(chunk)); return true; };
    let result;
    try { result = await handleAction('switch-runtime', { runtime: 'codex', request: code }, {}); }
    finally { process.stderr.write = write; }
    assert.deepEqual(result.error, reply.error);
    const outcome = logged.at(-1);
    if (code === 'RUNTIME_NOT_INSTALLED') {
      assert.equal(result.messageKey, reply.messageKey);
      assert.match(outcome, /\] <= fail RUNTIME_NOT_INSTALLED\n$/);
    } else {
      assert.equal(result.messageKey, null);
      assert.equal(result.message, `${code}: Original probe explanation`);
      assert.match(outcome, new RegExp(`\\] <= fail ${code} \\| ${code}: Original probe explanation\\n$`));
    }
  }
});
