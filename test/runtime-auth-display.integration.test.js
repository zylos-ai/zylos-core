import test from 'node:test';
import assert from 'node:assert/strict';
import { executeRuntimeSwitch } from '../cli/commands/runtime.js';
import { sendCommandJson } from '../skills/dashboard/src/lib/http.js';
import { formatActionResult } from '../skills/dashboard/public/js/action-result.js';

test('runtime auth remedies remain distinct through Dashboard HTTP and page formatting', async t => {
  let reply;
  t.mock.module('../skills/dashboard/src/lib/core-actions.js', { namedExports: {
    handleCoreAction: async () => reply,
  } });
  const { handleAction } = await import('../skills/dashboard/src/lib/actions.js');
  for (const runtime of ['claude', 'codex', 'agy']) {
    const messages = [];
    for (const status of ['failure', 'uncertain']) {
      reply = await executeRuntimeSwitch(runtime, [], {
        read: () => ({ state: 'ok', config: { runtime: runtime === 'claude' ? 'codex' : 'claude' } }),
        adapter: () => ({ checkAuth: async () => ({ status }) }),
        exists: () => true, hooksReady: () => ({ ready: true }),
        write: () => assert.fail('authentication rejection must not save runtime'),
      });
      const result = await handleAction('switch-runtime', { runtime, request: `${runtime}-${status}` }, {});
      let httpStatus, body;
      sendCommandJson({
        apiWrite: true,
        writeHead: code => { httpStatus = code; },
        end: data => { body = JSON.parse(data); },
      }, 200, result);
      assert.equal(httpStatus, 403);
      assert.equal(body.error.code, status === 'failure' ? 'AUTH_FAILED' : 'AUTH_NOT_CONFIRMED');
      const displayed = formatActionResult(body, key => key);
      assert.equal(displayed, reply.error.message, 'the page formatter uses the HTTP error message');
      assert.match(displayed, status === 'failure' ? /credentials rejected or not logged in/ : /check network\/proxy connectivity/);
      if (runtime === 'agy' && status === 'failure') assert.match(displayed, /zylos runtime agy --save-apikey <key>/);
      messages.push(displayed);
    }
    assert.notEqual(messages[0], messages[1], `${runtime}: browser-visible remedies must differ`);
  }
});
