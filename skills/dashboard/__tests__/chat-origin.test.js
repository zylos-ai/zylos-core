import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../src/lib/store.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { ChatSender } from '../src/lib/chat/send.js';
import { ChatHistory } from '../src/lib/chat/history.js';
import { ChatAnswers } from '../src/lib/chat/answers.js';
import { ChatAnswerDelivery } from '../src/lib/chat/delivery.js';
import { ChatAttachments } from '../src/lib/chat/attachments.js';

import { requireChatWrite } from '../src/lib/chat/access.js';
import { requestConversationName } from '../src/lib/chat/auto-name.js';
import { ensureOriginConversation, ORIGIN_CONVERSATION_ID } from '../src/lib/chat/origin.js';
import { createGroupDeletionStorage } from '../src/lib/group-deletion-storage.js';

import { createStore } from '../../comm-bridge/scripts/c4-v2-store.js';
import { receive } from '../../comm-bridge/scripts/c4-receive.js';
import { isDataError } from '../../comm-bridge/scripts/c4-session-group.js';
import { SKILLS_DIR } from '../../comm-bridge/scripts/c4-config.js';

import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../comm-bridge/scripts/c4-schema.js';

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
  assert.equal(Object.hasOwn(origin, 'count'), false);
  assert.equal(origin.preview, 'system alert', 'the preview stays on the latest non-internal row');
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

// In single mode Core records the rows of every conversation and external chat
// under `origin` when it delivers them; the Origin conversation shows them all.
