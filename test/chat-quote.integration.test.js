import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';
import { createChatApiFixture, assertChatProcessIsolation } from '../skills/dashboard/__tests__/helpers/chat-integration-api.js';
import { createDispatcher } from '../skills/comm-bridge/scripts/router/factory.js';
import { formatConversationsForAgent } from '../skills/comm-bridge/scripts/c4-db.js';
import * as dashboardSource from '../skills/comm-bridge/scripts/dashboard-source.js';
import { buildAnnotatedContent, splitContentAndAttachments } from '../skills/comm-bridge/scripts/attachment-annotations.js';
import { buildReplyViaSuffix } from '../skills/comm-bridge/scripts/c4-utils.js';
import { replyVia, shellQuote } from '../skills/comm-bridge/scripts/c4-query-format.js';
import { SKILLS_DIR, ATTACHMENTS_DIR } from '../skills/comm-bridge/scripts/c4-config.js';
import { tmuxNameForGroup } from '../cli/lib/session-group-paths.js';

const post = body => ({ method: 'POST', body });
const rowById = (api, id) => api.db.prepare('SELECT * FROM conversations WHERE id=?').get(id);

function dispatcherFixture(sandbox, api, sessionGroup) {
  const sent = [];
  const groups = ['origin', sessionGroup];
  const scenes = new Map(groups.map(group => [group, {
    present: true, ready: true, runtime: 'codex', runId: `private-${group}`,
    sessionId: `business-${group}`, runtimeSessionId: `business-${group}`,
    tmuxName: tmuxNameForGroup(group), serverGeneration: 'private-generation',
    paneId: '%1', createdAt: Math.floor(Date.now() / 1000),
  }]));
  const dispatcher = createDispatcher({
    env: { ...sandbox.env, ZYLOS_SESSION_POOL_SIZE: '1' },
    db: { ...api.c4, getDb: () => api.db,
      // These maintenance operations belong to the c4-db facade rather than
      // createStore. Keep their targets on the same private fixture database.
      expireTimedOutControls: current => api.db.prepare(`UPDATE control_queue
        SET status='timeout',updated_at=?,last_error=COALESCE(last_error,'ACK_DEADLINE_EXCEEDED')
        WHERE status IN ('pending','running') AND ack_deadline_at IS NOT NULL AND ack_deadline_at<?`)
        .run(current, current).changes,
      cleanupControlQueue: cutoff => api.db.prepare(`DELETE FROM control_queue
        WHERE status IN ('done','failed','timeout','superseded') AND updated_at<?`).run(cutoff).changes,
    },
    readSessionMode: () => ({ mode: 'multi' }),
    readZylosConfigStrict: () => ({ state: 'ok', config: { runtime: 'codex', session_mode: 'multi' } }),
    diagnostics: { diagnostic() {}, maintain() {} }, diagnostic() {}, log() {},
    listGroupTmuxSessions: async () => groups.map(group => ({ sessionGroup: group, ...scenes.get(group) })),
    readLiveIdentity: async group => scenes.get(group) ?? { present: false },
    readCurrentSession: async group => ({ runId: scenes.get(group).runId,
      sessionId: scenes.get(group).sessionId, startupControlIds: [] }),
    readSessionState: async group => ({ identity: scenes.get(group),
      status: { valid: true, value: { state: 'idle', health: 'ok', idle_seconds: 4, proc: { alive: true } } } }),
    readRuntimeHealth: () => ({ health: 'ok' }),
    openTmuxConnection: async options => {
      assert.equal(options.socketPath, sandbox.paths.socket);
      return { command: async args => args.at(-1) === '#{cursor_x}' ? '2' : '0', close: async () => {} };
    },
    resolveSessionTarget: async ({ sessionGroup: group }) => ({ ...scenes.get(group), sessionGroup: group, sessionId: '$1' }),
    revalidateSessionTarget: async () => {},
    getSessionAdapter: () => ({
      sendText: async ({ target, text }) => { assert.equal(sent.length, 0); sent.push({ group: target.sessionGroup, text }); },
      sendKeys: async () => {}, captureScreen: async () => '❯ ',
      launch: async () => assert.fail('Private READY fixture must not launch a runtime'),
      stop: async () => assert.fail('Private READY fixture must not stop a runtime'),
    }),
    notifyDelivered() {}, sleep: async () => {},
    findLegacySessions: async () => [], advanceLegacy: async () => {}, prepareSingle: async () => {},
    submit: async () => assert.fail('Private READY fixture must not submit a launch'),
  }, { tmux: { socketPath: sandbox.paths.socket }, delivery: { periodicEnabled: false, captureEnabled: false, verifyWaitMs: 1 } });
  sandbox.addCleanup(() => dispatcher.stop());
  return { dispatcher, sent };
}

// Boundary: real HTTP/AuthGate/send/receive/SQLite/history, then production
// dispatcher factory -> scheduler -> delivery -> captured agent sendText.
// Run for quote API, lookup, formatting or attachment placement changes; skip
// unrelated UI. Native model/tmux/PM2 are not exercised: only their transport
// boundary is injected. The gated harness proves private HOME/ZYLOS_DIR/
// PM2_HOME/short TMPDIR/socket/both DBs before HTTP/dispatch; teardown drains
// dispatch, clears attachment/auth timers, closes servers/DBs and removes roots.
test('HTTP quote persists, delivers and replays the same source without reviving old attachments',
  { skip: !chatEnabled(), timeout: 45000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      console.log('Quote dispatch isolation:', JSON.stringify(sandbox.assertIsolation()));
      assertChatProcessIsolation(sandbox);
      const api = await createChatApiFixture(t, sandbox);
      const current = await api.createConversation('Start here.');
      assert.equal(api.c4.claimConversation(current.receipt.messageId), true);
      assert.equal(api.c4.markDelivered(current.receipt.messageId), true);
      const original = api.addOutbound(current.draft.localId, buildAnnotatedContent('Earlier <answer> & details.', [
        { kind: 'file', path: path.join(sandbox.paths.zylos, 'old.txt'), name: 'old.txt', size: 3 },
      ]));
      const other = await api.createConversation('Other conversation.');
      assert.equal(api.c4.claimConversation(other.receipt.messageId), true);
      assert.equal(api.c4.markDelivered(other.receipt.messageId), true);
      const beforeReject = api.db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count;
      const rejected = await api.request(current.route + '/send', post({ content: 'Rejected.', quote: other.receipt.messageId }));
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.error, 'invalid_chat_quote');
      assert.equal(api.db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, beforeReject);

      const input = 'Please expand that.';
      const result = await api.request(current.route + '/send', post({ content: input, quote: original.id }));
      assert.equal(result.status, 200);
      assert.equal(result.body.stored, true);
      const saved = rowById(api, result.body.messageId);
      assert.equal(saved.content, `[quote c4_id=${original.id}]\n${input}`);
      assert.equal(saved.session_group, original.session_group);
      const source = '[Dashboard]\n<replying-to>\n[AI]: Earlier &lt;answer&gt; &amp; details.\n（附件：old.txt）\n</replying-to>\n\n<current-message>\nthe owner said: Please expand that.\n</current-message>';
      const hint = `\nCharts/choices/forms when useful: node ${shellQuote(path.join(SKILLS_DIR, 'dashboard/scripts/components.js'))} list --json\n`;
      const expected = source + hint + ' ' + replyVia(saved, path.join(SKILLS_DIR, 'comm-bridge/scripts/c4-send.js'));
      const { dispatcher, sent } = dispatcherFixture(sandbox, api, saved.session_group);
      await dispatcher.initialize(); await dispatcher.idle();
      dispatcher.tick(); await dispatcher.idle();
      assert.equal(rowById(api, saved.id).status, 'delivered');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].group, saved.session_group);
      assert.equal(sent[0].text, expected);
      assert.equal(splitContentAndAttachments(sent[0].text).attachments.length, 0);
      assert.equal(sent[0].text.includes('Attachments:'), false);
      await dispatcher.stop();
      const replay = formatConversationsForAgent([saved], { spill: false,
        lookupQuote: row => dashboardSource.resolveDashboardQuote(row, api.db) });
      assert.equal(replay, `[${saved.timestamp}] IN (dashboard:${saved.endpoint_id}):\n${source}${buildReplyViaSuffix('dashboard', saved.endpoint_id)}\n`);

      const history = await api.request(current.route + '/messages?tab=mine');
      assert.equal(history.status, 200);
      const item = history.body.items.find(row => row.id === saved.id);
      assert.equal(item.content, saved.content);
      assert.deepEqual(item.quote, { id: original.id, direction: 'out', timestamp: original.timestamp,
        internal: false, preview: 'Earlier <answer> & details.\n[文件] old.txt', available: true });
      const listing = await api.request('/api/chat/conversations?tab=mine');
      assert.equal(listing.body.items.find(row => row.id === result.body.conversationId).preview, input);
      api.db.prepare('UPDATE conversations SET session_group=? WHERE id=?').run(other.receipt.namespace + ':' + other.draft.localId, original.id);
      const unavailable = await api.request(current.route + '/messages?tab=mine');
      assert.equal(unavailable.status, 200);
      assert.deepEqual(unavailable.body.items.find(row => row.id === saved.id).quote,
        { id: original.id, direction: null, internal: false, timestamp: null, preview: '', available: false });
      assert.equal(rowById(api, saved.id).content, saved.content);
      console.log('Quote persisted C4 content:\n' + saved.content);
      console.log('Quote agent sendText (injected runtime transport):\n' + sent[0].text);
      console.log('Quote exact evidence:', JSON.stringify({ storedContent: saved.content, agentDelivery: sent[0].text }));
    });
  });

// Boundary: real authenticated upload + HTTP send + receive + Core rendering.
// Run for quote/new-attachment composition; skip unrelated UI. Uses the same
// private path proof and lifecycle cleanup above; no native runtime is started.
test('HTTP quote with a new upload exposes only that upload after the current message',
  { skip: !chatEnabled(), timeout: 45000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const api = await createChatApiFixture(t, sandbox);
      const current = await api.createConversation('Start here.');
      assert.equal(api.c4.claimConversation(current.receipt.messageId), true);
      assert.equal(api.c4.markDelivered(current.receipt.messageId), true);
      const original = api.addOutbound(current.draft.localId, buildAnnotatedContent('Earlier answer.', [
        { kind: 'file', path: path.join(sandbox.paths.zylos, 'old.txt'), name: 'old.txt', size: 3 },
      ]));
      const form = new FormData();
      form.append('file', new Blob(['new file'], { type: 'text/plain' }), 'new.txt');
      const response = await api.rawRequest(current.route + '/uploads', { method: 'POST', body: form });
      assert.equal(response.status, 201);
      const upload = await response.json();
      const result = await api.request(current.route + '/send', post({ content: 'Use this file.', quote: original.id, attachments: [upload.id] }));
      assert.equal(result.status, 200); assert.equal(result.body.stored, true);
      const saved = rowById(api, result.body.messageId);
      assert.ok(saved.content.startsWith(`[quote c4_id=${original.id}]\nUse this file.\n[attachment:file `));
      const { dispatcher, sent } = dispatcherFixture(sandbox, api, saved.session_group);
      await dispatcher.initialize(); await dispatcher.idle();
      dispatcher.tick(); await dispatcher.idle();
      assert.equal(rowById(api, saved.id).status, 'delivered'); assert.equal(sent.length, 1);
      const spill = path.join(ATTACHMENTS_DIR, `conv-${saved.id}`, 'message.txt');
      const complete = fs.existsSync(spill) ? fs.readFileSync(spill, 'utf8') : sent[0].text;
      const attachments = splitContentAndAttachments(complete).attachments;
      assert.equal(attachments.length, 1); assert.equal(attachments[0].name, 'new.txt');
      assert.ok(complete.includes('[AI]: Earlier answer.\n（附件：old.txt）\n</replying-to>'));
      assert.ok(complete.indexOf('</current-message>') < complete.indexOf('[attachment:file '));
      assert.equal(complete.includes('[quote c4_id='), false);
      assert.equal(complete.includes(path.join(sandbox.paths.zylos, 'old.txt')), false);
      const storedAttachments = splitContentAndAttachments(saved.content).attachments;
      assert.equal(storedAttachments.length, 1); assert.equal(storedAttachments[0].path, attachments[0].path);
      console.log('Quote + upload C4 content:\n' + saved.content);
      console.log('Quote + upload complete agent delivery (injected runtime transport):\n' + complete);
    });
  });
