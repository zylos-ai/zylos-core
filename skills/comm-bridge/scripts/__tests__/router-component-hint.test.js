import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatConversation } from '../router/format.js';
import { createDelivery } from '../router/delivery.js';
import { replyVia, shellQuote } from '../c4-query-format.js';
import { ATTACHMENTS_DIR, SKILLS_DIR } from '../c4-config.js';
import { CONTENT_PREFIX } from '../c4-content-schema.js';
import { fixture as storeFixture } from './c4-v2-test-helpers.js';
import { createQueryHandlers } from '../c4-v2-cli.js';
import { C4Reader } from '../../../dashboard/src/lib/c4-reader.js';
import { ChatHistory } from '../../../dashboard/src/lib/chat/history.js';
import { createDisplayNames } from '../../../dashboard/src/lib/workbench/display-names.js';

const marker = 'Charts/choices/forms when useful:';
const count = value => value.split(marker).length - 1;
const row = (extra = {}) => ({ id: 970001, direction: 'in', channel: 'dashboard', endpoint_id: 'dialog',
  session_group: 'dashboard:dialog', content: 'Show the recent usage.', ...extra });
const home = fs.realpathSync(process.env.HOME), deployment = fs.realpathSync(process.env.ZYLOS_DIR);
assert.notEqual(home, fs.realpathSync(os.userInfo().homedir));
assert.ok(deployment.startsWith(home + path.sep));
for (const key of ['PM2_HOME', 'TMPDIR']) assert.ok(path.resolve(process.env[key]).startsWith(path.dirname(home) + path.sep));
assert.ok(ATTACHMENTS_DIR.startsWith(deployment + path.sep));
console.log(JSON.stringify({ HOME: home, ZYLOS_DIR: deployment, PM2_HOME: process.env.PM2_HOME,
  TMPDIR: process.env.TMPDIR, resources: 'private files/SQLite; runtime adapters injected; no service or network' }));
function cleanupSpill(t, id) { t.after(() => fs.rmSync(path.join(ATTACHMENTS_DIR, `conv-${id}`), { recursive: true, force: true })); }

for (const channel of ['dashboard', 'telegram', 'feishu', 'web-console']) for (const direction of ['in', 'out'])
test(`${channel} ${direction} delivery has only the applicable Dashboard component hint`, t => {
  const input = Object.freeze(row({ channel, direction }));
  cleanupSpill(t, input.id);
  const result = formatConversation(input);
  assert.equal(count(result), channel === 'dashboard' && direction === 'in' ? 1 : 0);
  assert.ok(result.endsWith(replyVia(input, path.join(SKILLS_DIR, 'comm-bridge/scripts/c4-send.js'))));
  assert.equal(input.content, 'Show the recent usage.');
  if (count(result)) assert.ok(result.includes(`node ${shellQuote(path.join(SKILLS_DIR, 'dashboard/scripts/components.js'))} list --json`));
});

test('reformatting the same Dashboard row is idempotent and supports messages without a reply endpoint', t => {
  const input = Object.freeze(row({ endpoint_id: null })), before = JSON.stringify(input);
  cleanupSpill(t, input.id);
  const first = formatConversation(input);
  assert.equal(formatConversation(input), first);
  assert.equal(count(first), 1);
  assert.equal(first.includes('reply via:'), false);
  assert.equal(JSON.stringify(input), before);
});

// Real delivery spill files; run for delivery hints/projection/budgets, skip UI
// styling. Official runner owns HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; no services or DB.
test('projected long Dashboard delivery retains one hint in both preview and complete spill', t => {
  const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url)));
  const envelope = structuredClone(fixtures.valid.find(item => item.name === 'markdown').envelope);
  envelope.fallbackText = 'Readable summary ' + 'x'.repeat(1400);
  envelope.metadata = { private: 'HOST_ONLY_METADATA' };
  const input = Object.freeze(row({ id: 970002, content: CONTENT_PREFIX + JSON.stringify(envelope) }));
  cleanupSpill(t, input.id);
  const preview = formatConversation(input), file = path.join(ATTACHMENTS_DIR, `conv-${input.id}/message.txt`);
  assert.ok(preview.includes(file));
  assert.equal(count(preview), 1);
  const full = fs.readFileSync(file, 'utf8');
  assert.ok(full.startsWith('[Dashboard] the owner said: ' + envelope.fallbackText));
  assert.equal(count(full), 1);
  for (const text of [preview, full]) assert.equal(text.includes('HOST_ONLY_METADATA'), false);
  assert.equal(formatConversation(input), preview);
  assert.equal(fs.readFileSync(file, 'utf8'), full);
});

// Real common delivery path to both runtime adapters; run for formatter/router
// changes, skip UI-only work. Injected transport, no tmux socket/runtime/PM2.
for (const runtime of ['claude', 'codex']) test(`${runtime} common delivery entry sends the Dashboard hint to its adapter`, async t => {
  const input = row({ id: runtime === 'claude' ? 970003 : 970004 }), before = JSON.stringify(input), sent = [];
  cleanupSpill(t, input.id);
  const target = { ready: true, runtime, runId: 'fixture-run', sessionId: '$1', paneId: '%1' };
  let closed = 0;
  const delivery = createDelivery({
    getSessionMode: () => 'multi', openTmuxConnection: async () => ({ close: async () => { closed++; }, command: async () => '0' }),
    resolveSessionTarget: async () => target, revalidateSessionTarget: async () => {},
    readSessionState: async () => ({ identity: target, status: { valid: true, value: { state: 'idle', health: 'ok' } } }),
    readRuntimeHealth: () => ({ health: 'ok' }), readCurrentSession: async () => ({ runId: target.runId, sessionId: 'fixture-session' }),
    getSessionAdapter: () => ({ sendText: async ({ text }) => { sent.push(text); }, sendKeys: async () => {}, captureScreen: async () => '❯ ' }),
    formatConversation, notifyDelivered: () => {}, sleep: async () => {},
    db: { markDelivered: () => true, requeueConversation: () => assert.fail('delivery blocked'), failDelivery: () => assert.fail('delivery failed') },
  }, { periodicEnabled: false, captureEnabled: false });
  t.after(() => delivery.stop());
  assert.equal((await delivery.deliverConversation(input)).delivered, true);
  assert.equal(sent.length, 1); assert.equal(count(sent[0]), 1);
  assert.equal(JSON.stringify(input), before); assert.equal(closed, 1);
});

// Real private SQLite and production history/query/export/name-list readers.
// Run for delivery-context placement or history changes; skip component UI.
// All paths live beneath official runner TMPDIR, no process/socket/network;
// registered cleanup closes both handles before removing the private root.
test('agent hint stays absent from stored messages, Dashboard history, search, exports and naming previews', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'component-history-'));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const { db, store } = storeFixture(t, {}, path.join(root, 'comm-bridge/c4.db'));
  const reader = new C4Reader(root);
  t.after(() => { reader.close(); if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const saved = store.insertConversation('in', 'dashboard', 'dialog', 'Seven days of usage.', { groupName: 'dialog' });
  assert.ok(saved.session_group.endsWith(':dialog'));
  db.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(saved.id);
  const before = db.prepare('SELECT content FROM conversations WHERE id=?').get(saved.id).content;
  cleanupSpill(t, saved.id);
  assert.equal(count(formatConversation(saved)), 1);
  assert.equal(db.prepare('SELECT content FROM conversations WHERE id=?').get(saved.id).content, before);
  const query = createQueryHandlers(store), history = new ChatHistory({ c4Reader: reader });
  const id = 'g:' + Buffer.from(saved.session_group).toString('hex').toUpperCase();
  assert.equal(history.messages(id).items[0].content, before);
  assert.equal(history.list().items[0].preview, before);
  assert.equal(query.groups({ match: marker }).length, 0);
  const names = createDisplayNames({ zylosDir: root,
    store: { getGroupDisplayName: () => null },
    runC4Db: async () => ({ ok: true, data: query.groups() }) });
  const list = await names.listNames({ unnamed: true });
  assert.equal(list.length, 1); assert.equal(list[0].preview.text, before);
  const { runId } = store.beginModeTransition('single', 'multi');
  // Absorb a fresh pending row to exercise the real full-field export path.
  const pending = store.insertConversation('in', 'dashboard', 'other', before, { groupName: 'other' });
  store.setDrainFence('*'); store.absorbForTransition(runId);
  const out = path.join(root, 'history-export.txt');
  query.absorbed({ runId, id: pending.id, out });
  assert.equal(fs.readFileSync(out, 'utf8'), before);
  assert.equal(count(JSON.stringify({ list, history: history.messages(id), groups: query.groups() })), 0);
});
