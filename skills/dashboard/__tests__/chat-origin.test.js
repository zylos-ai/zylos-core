import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../src/lib/store.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { ChatSender } from '../src/lib/chat/send.js';
import { ChatHistory } from '../src/lib/chat/history.js';
import { ChatAnswers } from '../src/lib/chat/answers.js';
import { ChatAnswerDelivery } from '../src/lib/chat/delivery.js';
import { ChatAttachments } from '../src/lib/chat/attachments.js';
import { registerQuestion } from '../src/lib/chat/questions.js';
import { requireChatWrite } from '../src/lib/chat/access.js';
import { requestConversationName } from '../src/lib/chat/auto-name.js';
import { ensureOriginConversation, ORIGIN_CONVERSATION_ID } from '../src/lib/chat/origin.js';
import { createGroupDeletionStorage } from '../src/lib/group-deletion-storage.js';
import { evaluateBeforeSend } from '../scripts/send-hook.js';
import { createStore } from '../../comm-bridge/scripts/c4-v2-store.js';
import { receive } from '../../comm-bridge/scripts/c4-receive.js';
import { isDataError } from '../../comm-bridge/scripts/c4-session-group.js';
import { SKILLS_DIR } from '../../comm-bridge/scripts/c4-config.js';
import { CONTENT_PREFIX, parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';
import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../comm-bridge/scripts/c4-schema.js';

const protocol = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const groupId = group => `g:${Buffer.from(group).toString('hex').toUpperCase()}`;
const auth = { enabled: true, resolveAuthContext: req => { req._authContext = req.context; return req.context; } };
const local = { kind: 'cookie', scope: 'admin' };
const hasGroupArgument = args => args.includes('--session-group');

// Boundary: real Dashboard store, real C4 schema/store and the in-process
// receive entry, plus real history, answer, attachment and BeforeSend code over
// private files. Run for Origin conversation routing, history, send-state,
// answer, upload or access changes; presentation-only changes may skip. The
// official runner provides isolated HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; each
// case owns one private root (both databases and media) and closes everything
// before removing it. Routing and status notices are injected: no runtime,
// tmux, PM2, network or child process starts, including on failure paths.
function fixture(t, { mode = 'multi', ids } = {}) {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key] && !process.env[key].startsWith(os.userInfo().homedir + path.sep), `${key} must be isolated`);
  }
  assert.ok(SKILLS_DIR.startsWith(process.env.ZYLOS_DIR + path.sep));
  fs.mkdirSync(path.join(SKILLS_DIR, 'dashboard'), { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-origin-')));
  for (const dir of ['comm-bridge', 'components/dashboard', 'workspace']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const db = new Database(path.join(root, 'comm-bridge/c4.db'));
  guardDatabase(db, schema);
  db.pragma('busy_timeout=10');
  const store = new Store(path.join(root, 'components/dashboard/dashboard.db'));
  const c4 = createStore(db, { validateComponent: name => name === 'dashboard',
    readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: mode } }) });
  const generated = [...(ids ?? [])];
  const conversations = new ChatConversations({ store, ...(ids ? { idGenerator: () => generated.shift() } : {}) });
  ensureOriginConversation(store.db);
  const reader = new C4Reader(root);
  const attachments = new ChatAttachments({ store, c4Reader: reader, zylosDir: root });
  const calls = [];
  let invoke = null;
  const realReceive = args => receive(args, {
    db: c4,
    queryRoute: async () => ({ decision: 'pending', runtime: 'claude' }),
    appendEntryEvent: async () => true,
    reserveStatusNotice: () => ({ suppressed: true }),
    sendStatusNotice: () => ({ outcome: 'suppressed' }),
    diagnostic() {},
  });
  const core = {
    isDataError,
    getChannelNamespace: name => c4.getChannelNamespace(name),
    ensureChannelNamespace: name => c4.ensureChannelNamespace(name),
    receive: async args => { calls.push(args); return (invoke || realReceive)(args); },
  };
  const makeSender = () => new ChatSender({ conversations, c4Reader: reader, loadCore: async () => core, zylosDir: root, attachments });
  const sender = makeSender();
  const history = new ChatHistory({ c4Reader: reader, conversations, attachments });
  const answers = new ChatAnswers({ store });
  const delivery = new ChatAnswerDelivery({ answers, sender, c4Reader: reader });
  const config = { chat: { allowRemote: false } };
  const authorizeAs = (context, sessionMode = mode) => record => requireChatWrite(
    { headers: { 'sec-fetch-site': 'same-origin' }, context }, auth, config, {
      mode: sessionMode, conversation: record, namespace: record.namespace, localId: record.localId,
      draft: record.namespace === null && record.state !== 'active',
    });
  const add = (direction, channel, endpoint, content, sessionGroup = 'origin') => Number(db.prepare(`INSERT INTO conversations
    (direction,channel,endpoint_id,session_group,content,status) VALUES(?,?,?,?,?,'delivered')`)
    .run(direction, channel, endpoint, sessionGroup, content).lastInsertRowid);
  t.after(async () => {
    await attachments.close(); reader.close(); store.close(); db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, db, c4, store, conversations, reader, attachments, calls, sender, makeSender, history, answers,
    delivery, config, authorizeAs, add, realReceive, setInvoke: value => { invoke = value; },
    originRows: () => db.prepare("SELECT * FROM conversations WHERE session_group='origin' ORDER BY id").all() };
}

test('the Origin conversation is pinned first in "mine" with or without messages and never listed in external', async t => {
  const f = fixture(t);
  const [empty] = f.history.list({ tab: 'mine' }).items;
  assert.deepEqual({ id: empty.id, group: empty.session_group, endpoint: empty.endpoint_id, localId: empty.localId,
    name: empty.display_name, count: empty.count, preview: empty.preview, draft: empty.draft, origin: empty.origin },
  { id: ORIGIN_CONVERSATION_ID, group: 'origin', endpoint: 'origin', localId: 'origin',
    name: 'Origin', count: 0, preview: '', draft: false, origin: true });
  assert.equal(f.history.list({ tab: 'mine' }).items.length, 1);
  assert.deepEqual(f.history.messages(ORIGIN_CONVERSATION_ID).items, [], 'an empty Origin conversation is empty, not missing');
  f.add('out', 'dashboard', 'origin', 'An older alert');
  const draft = f.conversations.create({ displayName: 'Newer work' });
  const sent = await f.sender.send(draft.id, { content: 'newer conversation' });
  assert.equal(sent.stored, true);
  f.db.prepare("UPDATE conversations SET timestamp='2020-01-01 00:00:00' WHERE session_group='origin'").run();
  const listed = f.history.list({ tab: 'mine' }).items;
  assert.deepEqual(listed.map(item => item.id), [ORIGIN_CONVERSATION_ID, sent.conversationId], 'Origin stays first outside activity order');
  assert.equal(listed[0].preview, 'An older alert');
  const first = f.history.list({ tab: 'mine', limit: 1 });
  assert.deepEqual(first.items.map(item => item.id), [ORIGIN_CONVERSATION_ID]);
  const next = f.history.list({ tab: 'mine', limit: 1, cursor: first.nextCursor });
  assert.deepEqual(next.items.map(item => item.id), [sent.conversationId]);
  assert.equal(next.nextCursor, null);
  f.add('in', 'telegram', 'chat', 'external words', 'telegram:chat');
  assert.equal(f.history.list({ tab: 'external' }).items.some(item => item.id === ORIGIN_CONVERSATION_ID || item.session_group === 'origin'), false);
  assert.throws(() => f.history.messages(ORIGIN_CONVERSATION_ID, { tab: 'external' }), { code: 'chat_conversation_not_found' });
  const { highwater } = f.history.chatChangeSnapshot({ tab: 'mine' });
  f.add('in', 'system', 'scheduler', 'scheduled task');
  assert.equal(f.history.chatChangeSnapshot({ tab: 'mine' }, { afterId: highwater }).listChanged, false);
  f.add('out', 'dashboard', 'origin', 'A new alert');
  assert.equal(f.history.chatChangeSnapshot({ tab: 'mine' }, { afterId: highwater }).listChanged, true);
});

test('Origin messages show Dashboard and internal rows both ways but not system, scheduler, control or void rows', t => {
  const f = fixture(t);
  const shown = [
    f.add('in', 'dashboard', 'origin', 'owner asks'),
    f.add('out', 'dashboard', 'origin', 'system alert'),
    f.add('out', 'internal', 'telegram:chat', 'relay to Telegram'),
    f.add('in', 'internal', 'telegram:chat', '[internal] Yourself, from your "telegram:chat" session group, said: relayed back'),
  ];
  for (const channel of ['system', 'scheduler', 'control', 'void']) f.add('in', channel, 'x', `${channel} row`);
  f.add('in', 'telegram', 'chat', 'Telegram words', 'telegram:chat');
  const items = f.history.messages(ORIGIN_CONVERSATION_ID).items;
  assert.deepEqual(items.map(row => row.id), shown);
  assert.deepEqual(items.slice(2).map(row => [row.direction, row.internal.peerSessionGroup, row.internal.peerExists, row.internal.content]),
    [['out', 'telegram:chat', true, 'relay to Telegram'], ['in', 'telegram:chat', true, 'relayed back']]);
  assert.equal(items[1].deliveryState, 'stored');
  const [origin] = f.history.list({ tab: 'mine' }).items;
  assert.equal(origin.count, 2, 'summaries count Dashboard rows only');
  assert.equal(origin.preview, 'system alert', 'summaries exclude internal messages');
  assert.deepEqual(f.history.status(ORIGIN_CONVERSATION_ID, { ids: [shown[0]] }).items.map(row => row.deliveryState), ['delivered']);
});

test('in single mode Origin accepts sends without a session group while other conversations stay read-only', async t => {
  const f = fixture(t, { mode: 'single' });
  const authorize = f.authorizeAs(local, 'single');
  const receipt = await f.sender.send(ORIGIN_CONVERSATION_ID, { content: 'hello Origin' }, { authorize });
  assert.equal(receipt.stored, true);
  assert.equal(receipt.conversationId, ORIGIN_CONVERSATION_ID);
  assert.equal(f.calls.length, 1);
  assert.equal(hasGroupArgument(f.calls[0]), false);
  assert.deepEqual(f.originRows().map(row => [row.direction, row.channel, row.endpoint_id, row.content]),
    [['in', 'dashboard', 'origin', 'hello Origin']]);
  assert.equal(f.conversations.get('origin').lastMessageId, receipt.messageId);
  const draft = f.conversations.create();
  await assert.rejects(f.sender.send(draft.id, { content: 'not here' }, { authorize }), { code: 'chat_requires_multi' });
  assert.equal(f.calls.length, 1, 'a refused conversation never reaches Core');
  const multi = await f.sender.send(draft.id, { content: 'in multi' }, { authorize: f.authorizeAs(local, 'multi') });
  assert.equal(multi.stored, true);
  assert.equal(hasGroupArgument(f.calls[1]), true, 'ordinary conversations keep their session group');
});

test('an interrupted Origin send is reconciled from its fixed record and never resent automatically', async t => {
  const f = fixture(t);
  f.setInvoke(async args => { await f.realReceive(args); throw Error('lost receipt'); });
  const lost = await f.sender.send(ORIGIN_CONVERSATION_ID, { content: 'did this arrive?' });
  assert.equal(lost.needsReconciliation, true);
  assert.equal(f.conversations.get('origin').lastOutcome.kind, 'unknown');
  f.setInvoke(null);
  const restarted = f.makeSender();
  const reopened = await restarted.reconcile(ORIGIN_CONVERSATION_ID);
  assert.equal(reopened.conversationId, ORIGIN_CONVERSATION_ID);
  assert.equal(reopened.needsReconciliation, true);
  const again = await restarted.send(ORIGIN_CONVERSATION_ID, { content: 'did this arrive?' });
  assert.equal(again.needsReconciliation, true);
  assert.equal(f.calls.length, 1, 'no automatic resend after the uncertain send');
  assert.equal(f.originRows().length, 1);
});

test('Origin is fixed: it cannot be renamed, deleted, auto-named or used as an ordinary conversation ID', async t => {
  const f = fixture(t, { ids: ['origin', 'fresh-id'] });
  assert.equal(f.conversations.create().localId, 'fresh-id', 'a new conversation never takes the Origin ID');
  assert.throws(() => f.conversations.rename('origin', 'Renamed'), { code: 'chat_conversation_forbidden' });
  // The conversation page reads its title from this record, so it carries the same fixed name as the list.
  assert.equal(f.conversations.get('origin').displayName, 'Origin');
  assert.equal(f.store.getGroupDisplayName('origin'), null, 'the name is fixed, not stored as a group name');
  const namespace = f.c4.ensureChannelNamespace('dashboard').namespace;
  for (const id of ['d:origin', groupId(`${namespace}:origin`)]) {
    await assert.rejects(f.sender.resolve(id), { code: 'invalid_chat_conversation' });
  }
  ensureOriginConversation(f.store.db);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM chat_conversations WHERE local_id='origin'").get().n, 1, 'startup creation is idempotent');
  const storage = createGroupDeletionStorage({ zylosDir: f.root, homeDir: f.root, store: f.store, c4Db: f.db, tmpdir: f.root });
  for (const target of [{ draftLocalId: 'origin' }, { sessionGroup: 'origin' }]) {
    assert.throws(() => storage.resolveTarget(target), { code: 'group_delete_forbidden' });
  }
  const reply = f.c4.insertConversation('out', 'dashboard', 'origin', 'first reply');
  assert.equal(reply.session_group, 'origin');
  const naming = requestConversationName(reply, { env: { ZYLOS_DIR: f.root }, enqueue: () => assert.fail('Origin is never auto-named') });
  assert.equal(naming, null);
});

test('Origin answers, uploads and agent attachments work without a session group in single mode', async t => {
  const f = fixture(t, { mode: 'single' });
  const authorize = f.authorizeAs(local, 'single');
  const origin = await f.sender.resolve(ORIGIN_CONVERSATION_ID);
  assert.equal(origin.sessionGroup, 'origin');
  const envelope = structuredClone(parseC4Content(protocol.valid.find(item => item.name === 'single').content).envelope);
  const question = f.c4.insertConversation('out', 'dashboard', 'origin', CONTENT_PREFIX + JSON.stringify(envelope));
  registerQuestion(question, { env: { ZYLOS_DIR: f.root } });
  const block = envelope.blocks.find(item => item.id === envelope.interrupt.blockId);
  const accepted = f.answers.accept({ sessionGroup: origin.sessionGroup, endpointId: origin.localId, interruptId: envelope.interruptId,
    action: { id: 'origin_answer', protocolVersion: '0.1', type: block.data.action.type, target: block.data.action.target,
      context: { messageId: envelope.messageId, blockId: block.id }, payload: { selected: ['a'] } } });
  const answered = await f.delivery.deliver(accepted.answer.answerId, { initial: accepted.created, authorize: () => authorize(origin) });
  assert.equal(answered.stored, true);
  assert.equal(hasGroupArgument(f.calls.at(-1)), false, 'answers to Origin carry no session group');
  assert.equal(f.originRows().at(-1).session_group, 'origin');

  const prepared = await f.sender.prepareAttachmentConversation(origin, { authorize });
  const upload = await f.attachments.prepareUser(prepared, { name: 'note.txt', mime: 'text/plain', principal: 'cookie:owner',
    stream: Readable.from(['owner bytes']), watermark: f.attachments.captureWatermark() });
  const sent = await f.sender.send(ORIGIN_CONVERSATION_ID, { content: 'see the note', attachments: [upload.id] },
    { authorize, principal: 'cookie:owner' });
  assert.equal(sent.stored, true);
  assert.equal(hasGroupArgument(f.calls.at(-1)), false);
  const withFile = f.history.messages(ORIGIN_CONVERSATION_ID).items.find(row => row.id === sent.messageId);
  assert.deepEqual(withFile.attachments.map(item => [item.name, item.available]), [['note.txt', true]]);

  // The agent's attachment reply to `dashboard origin` passes the unchanged BeforeSend check.
  const source = path.join(f.root, 'workspace', 'report.txt');
  fs.writeFileSync(source, 'agent bytes');
  const registered = await f.attachments.register(origin, { kind: 'file', path: source });
  const id = registered.attachmentId ?? registered.id;
  const reply = CONTENT_PREFIX + JSON.stringify({ version: 1, kind: 'message', messageId: 'origin_reply', fallbackText: 'report',
    blocks: [{ id: 'file', type: 'x-zylos.file', schemaVersion: 1, fallbackText: 'report.txt', data: { attachmentId: id, nameSnapshot: 'report.txt' } }] });
  const input = groupName => ({ version: 1, hook_event_name: 'BeforeSend', hook_id: 'dashboard.content', request_id: 'r', invocation_id: 'i',
    request: { channel: 'dashboard', endpoint: 'origin', content: reply, options: { groupName, wholeGroup: false } },
    context: { session_group: 'origin' } });
  const env = { ...process.env, ZYLOS_DIR: f.root };
  assert.equal(evaluateBeforeSend(input('origin'), { env }).decision, 'continue');
  assert.equal(evaluateBeforeSend(input('elsewhere'), { env }).decision, 'abort');
});

test('an internal message to origin from another session appears in the Origin conversation', async t => {
  const f = fixture(t);
  const draft = f.conversations.create();
  const seed = await f.sender.send(draft.id, { content: 'work in another conversation' });
  const group = `${seed.namespace}:${draft.localId}`;
  // Core's own internal-message insert, as `c4-send internal origin` stores it.
  f.c4.insertInternalMessage(group, 'origin', 'please tell the owner in Origin');
  const items = f.history.messages(ORIGIN_CONVERSATION_ID).items;
  assert.deepEqual(items.map(row => [row.direction, row.channel, row.internal?.peerSessionGroup, row.internal?.content]),
    [['in', 'internal', group, 'please tell the owner in Origin']]);
  assert.equal(f.history.list({ tab: 'mine' }).items[0].preview, '', 'the summary still excludes internal messages');
});
