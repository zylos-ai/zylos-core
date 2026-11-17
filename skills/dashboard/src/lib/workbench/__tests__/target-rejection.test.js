import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupActions } from '../group-actions.js';
import { sendCommandJson } from '../../http.js';
import { createTargetBindingBuilder } from '../../../../../comm-bridge/scripts/c4-target-binding.js';
import { nudgeSession } from '../../../../../../cli/lib/session-nudge.js';

// The real Core identity guard produces the refusal; only observations and child
// transport are supplied. No process, tmux, socket or database is opened.
test('interrupt and chop-chop expose a declared Core run mismatch as an HTTP conflict', async () => {
  const bind = createTargetBindingBuilder({ baseline: () => ({ sessionMode: 'multi' }),
    snapshot: read => read({}), knownGroup: () => {}, get: () => null,
    resolveTarget: async () => ({ runId: 'replacement-run' }),
  });
  for (const action of ['interrupt', 'chop-chop']) {
    let submissions = 0;
    const run = createGroupActions({ zylosDir: '/isolated/instance',
      loadCoreModule: async name => name === 'config.js'
        ? { readSessionMode: () => ({ mode: 'multi' }) } : { nudgeSession },
      sleep: () => assert.fail('A refused Escape must not schedule continue'),
      execute: async (_binary, argv) => {
        submissions++;
        try {
          await bind({ sessionGroup: 'telegram:example', expectedRunId: argv[argv.indexOf('--target-run') + 1] });
          assert.fail('The real Core guard must refuse the stale run');
        } catch (error) {
          assert.equal(error.code, 'TARGET_MISMATCH');
          return { stdout: JSON.stringify({ ok: false, error: { code: error.code, message: error.message, runId: error.runId } }) };
        }
      },
    });
    const outcome = await run('telegram:example', action, { runId: 'previous-run' });
    const res = { apiWrite: true, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    sendCommandJson(res, 200, outcome);
    assert.equal(res.status, 409);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'TARGET_MISMATCH');
    assert.equal(res.body.error.runId, 'replacement-run');
    assert.equal(res.body.submission, 'rejected');
    assert.equal(submissions, 1);
  }
});
