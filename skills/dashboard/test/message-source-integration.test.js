// Real HTTP/AuthGate, C4/Dashboard SQLite owners and common delivery formatter.
// Run for Dashboard provenance or send/answer projection changes; skip UI styling.
// Official runner + gated sandbox prove HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR,
// private socket and both DB paths before use; lifecycle teardown reclaims all.
// Runtime adapters are injected here: no live model, PM2 or tmux is launched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { createChatApiFixture, questionContent } from './helpers/chat-integration-api.js';
import { formatConversation } from '../../comm-bridge/scripts/router/format.js';
import { readOwnerName } from '../../comm-bridge/scripts/dashboard-source.js';
import { replyVia, shellQuote } from '../../comm-bridge/scripts/c4-query-format.js';
import { SKILLS_DIR } from '../../comm-bridge/scripts/c4-config.js';
import { projectC4Content } from '../../comm-bridge/scripts/c4-content-projection.js';
import { createDelivery } from '../../comm-bridge/scripts/router/delivery.js';

const options = { skip: !chatEnabled(), timeout: 30_000 };
test('Dashboard sends and question or form answers gain source identity only at agent delivery', options, async t => {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    const api = await createChatApiFixture(t, sandbox);
    const references = path.join(sandbox.paths.zylos, 'memory/references.md');
    fs.mkdirSync(path.dirname(references));
    fs.writeFileSync(references, '## Active IDs\n- Owner: Howard (Telegram: private-fixture)\n');
    const format = row => formatConversation(row, { scriptPath: '/private/c4-send.js', ownerName: () => readOwnerName(references) });
    const first = await api.createConversation('Original Dashboard message');
    const rows = [api.db.prepare("SELECT * FROM conversations WHERE direction='in' ORDER BY id LIMIT 1").get()];
    for (const kind of ['single', 'form']) {
      const question = api.question(kind);
      api.addOutbound(first.draft.localId, questionContent(question));
      const answer = api.answer(question);
      if (kind === 'form') answer.action.payload = { values: { name: 'Howard', count: 2, tags: ['a'] } };
      const posted = await api.request(first.route + '/answers', { method: 'POST', body: answer });
      assert.equal(posted.status, 200);
      assert.equal(posted.body.delivery.stored, true);
      const saved = api.answerRows(answer.action.id);
      assert.equal(saved.length, 1); rows.push(saved[0]);
    }
    const received = [];
    for (const runtime of ['claude', 'codex']) {
      const target = { ready: true, runtime, runId: 'private-run', sessionId: '$1', paneId: '%1' };
      const delivery = createDelivery({
        getSessionMode: () => 'multi', openTmuxConnection: async () => ({ close: async () => {}, command: async () => '0' }),
        resolveSessionTarget: async () => target, revalidateSessionTarget: async () => {},
        readSessionState: async () => ({ identity: target, status: { valid: true, value: { state: 'idle', health: 'ok' } } }),
        readRuntimeHealth: () => ({ health: 'ok' }), readCurrentSession: async () => ({ runId: target.runId, sessionId: 'private-session' }),
        getSessionAdapter: () => ({ sendText: async ({ text }) => { received.push({ runtime, text }); }, sendKeys: async () => {}, captureScreen: async () => '❯ ' }),
        formatConversation: format, notifyDelivered: () => {}, sleep: async () => {},
        db: { markDelivered: () => true, requeueConversation: () => assert.fail('unexpected requeue'), failDelivery: () => assert.fail('unexpected failure') },
      }, { periodicEnabled: false, captureEnabled: false });
      try { for (const row of rows) assert.equal((await delivery.deliverConversation(row)).delivered, true); }
      finally { await delivery.stop(); }
    }
    assert.equal(received.length, 6);
    for (const [index, row] of rows.entries()) {
      const expected = '[Dashboard] Howard said: ' + projectC4Content(row.content, { c4Id: row.id }) + `\nCharts/choices/forms when useful: node ${shellQuote(path.join(SKILLS_DIR, 'dashboard', 'scripts', 'components.js'))} list --json\n` + ' ' + replyVia(row, '/private/c4-send.js');
      assert.equal(received[index].text, expected); assert.equal(received[index + 3].text, expected);
      assert.equal(row.content.includes('[Dashboard]'), false);
    }
    const history = await api.request(first.route + '/messages?tab=mine');
    assert.equal(history.status, 200);
    assert.ok(history.body.items.some(row => row.content === 'Original Dashboard message'));
    assert.equal(JSON.stringify(history.body).includes('[Dashboard]'), false);
    assert.equal(api.db.prepare("SELECT COUNT(*) n FROM conversations WHERE content LIKE '%[Dashboard]%' ").get().n, 0);
    fs.writeFileSync(references, '## Active IDs\n- Owner: (not yet established)\n');
    assert.ok(format(rows[0]).startsWith('[Dashboard] the owner said: Original Dashboard message'));
  });
});
