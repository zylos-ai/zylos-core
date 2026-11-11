import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../src/lib/store.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { ChatSender } from '../src/lib/chat/send.js';
import { ChatHistory } from '../src/lib/chat/history.js';
import { createStore } from '../../comm-bridge/scripts/c4-v2-store.js';
import { receive } from '../../comm-bridge/scripts/c4-receive.js';
import { dataError, isDataError } from '../../comm-bridge/scripts/c4-session-group.js';
import { SKILLS_DIR } from '../../comm-bridge/scripts/c4-config.js';
import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../comm-bridge/scripts/c4-schema.js';

const groupId = group => `g:${Buffer.from(group).toString('hex').toUpperCase()}`;

// These cases exercise real Dashboard and C4 stores plus the real in-process
// receive entry. Run for draft, receive classification, recovery or routing
// changes; unrelated UI-only changes may skip them. The official runner sets
// isolated HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR before imports. Every case owns
// two databases and a separate read-only C4 handle, all closed before removal.
// queryRoute and status notification delivery are injected: no runtime starts,
// CLI spawn, network, PM2 or tmux is used, including on failure paths.
function fixture(t, options = {}) {
  assert.ok(!path.resolve(process.env.HOME).startsWith(os.userInfo().homedir + path.sep), 'official isolated HOME is required');
  assert.ok(SKILLS_DIR.startsWith(process.env.ZYLOS_DIR + path.sep));
  fs.mkdirSync(path.join(SKILLS_DIR, 'dashboard'), { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-send-'));
  const file = path.join(root, 'c4.db');
  const db = new Database(file);
  guardDatabase(db, schema);
  db.pragma('busy_timeout=10');
  const dashboard = new Store(path.join(root, 'dashboard.db'));
  const readonly = new Database(file, { readonly: true, fileMustExist: true });
  const counts = { receive: 0, routes: 0, notifications: 0 };
  const c4 = createStore(db, { validateComponent: name => name === 'dashboard',
    readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  const conversations = new ChatConversations({ store: dashboard, ...options });
  let route = { decision: 'pending', runtime: 'claude' };
  let invoke;
  let queryError = false;
  let notificationMode = 'suppressed';
  const reader = { _open() { if (queryError) throw Error('private reader unavailable'); return readonly; } };
  const realReceive = args => receive(args, {
    db: c4,
    queryRoute: async () => { counts.routes++; return route; },
    appendEntryEvent: async () => true,
    reserveStatusNotice: () => ({ suppressed: notificationMode === 'suppressed' }),
    sendStatusNotice: () => { counts.notifications++; return { outcome: notificationMode }; },
    diagnostic() {},
  });
  const core = {
    getChannelNamespace: name => c4.getChannelNamespace(name),
    ensureChannelNamespace: name => c4.ensureChannelNamespace(name),
    isDataError,
    receive: async args => { counts.receive++; return (invoke || realReceive)(args); },
  };
  const makeSender = () => new ChatSender({ conversations, c4Reader: reader, loadCore: async () => core, zylosDir: root });
  const sender = makeSender();
  t.after(() => { readonly.close(); dashboard.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, c4, dashboard, conversations, sender, core, counts, realReceive, makeSender, reader,
    setInvoke(value) { invoke = value; }, setRoute(value) { route = value; }, setQueryError(value) { queryError = value; },
    setNotification(value) { notificationMode = value; },
    count(table) { return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; },
    rows(localId) { return db.prepare('SELECT * FROM conversations WHERE channel=? AND endpoint_id=? ORDER BY id').all('dashboard', localId); },
  };
}

function emptyCore(f) {
  assert.equal(f.count('conversations'), 0);
  assert.equal(f.count('group_heads'), 0);
  assert.equal(f.count('channel_namespaces'), 0);
  assert.equal(f.counts.routes, 0);
  assert.equal(f.counts.notifications, 0);
}

async function activate(f, name = 'first') {
  const draft = f.conversations.create({ displayName: name });
  const receipt = await f.sender.send(draft.id, { content: `hello ${name}` });
  return { draft, receipt, id: groupId(`${receipt.namespace}:${draft.localId}`) };
}

// Boundary: real sender/receive and private C4 storage, without a runtime.
// Run for quote validation/annotation/retry changes; unrelated UI may skip.
test('quote sends persist a first-line marker for Dashboard and visible internal targets', async t => {
  const f = fixture(t), active = await activate(f);
  const target = active.receipt.messageId;
  const sent = await f.sender.send(active.id, { content: 'reply to owner', quote: target });
  assert.equal(sent.stored, true);
  assert.equal(f.rows(active.draft.localId).at(-1).content, `[quote c4_id=${target}]\nreply to owner`);
  const internal = f.db.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,session_group,content,status)
    VALUES('in','internal','peer',?,'internal text','delivered')`).run(`${active.receipt.namespace}:${active.draft.localId}`);
  const internalId = Number(internal.lastInsertRowid);
  await f.sender.send(active.id, { content: 'reply to peer', quote: internalId });
  assert.equal(f.rows(active.draft.localId).at(-1).content, `[quote c4_id=${internalId}]\nreply to peer`);
});

test('quote sends reject invalid IDs and rows outside the visible conversation before receive', async t => {
  const f = fixture(t), active = await activate(f), other = await activate(f, 'other');
  const group = `${active.receipt.namespace}:${active.draft.localId}`;
  const hidden = [
    ['dashboard', 'wrong-endpoint', group, 'in'],
    ['telegram', active.draft.localId, group, 'in'],
    ['system', active.draft.localId, group, 'in'],
    ['dashboard', active.draft.localId, group, 'other'],
    ['internal', active.draft.localId, `${other.receipt.namespace}:${other.draft.localId}`, 'in'],
  ].map(([channel, endpoint, sessionGroup, direction]) => Number(f.db.prepare(`INSERT INTO conversations
    (direction,channel,endpoint_id,session_group,content,status) VALUES(?,?,?,?,'hidden','delivered')`)
    .run(direction, channel, endpoint, sessionGroup).lastInsertRowid));
  const before = f.counts.receive;
  for (const quote of [null, 0, -1, 1.2, true, '1', Number.MAX_SAFE_INTEGER + 1, 999999,
    other.receipt.messageId, ...hidden]) {
    await assert.rejects(f.sender.send(active.id, { content: 'must reject', quote }), { code: 'invalid_chat_quote' });
  }
  const draft = f.conversations.create();
  await assert.rejects(f.sender.send(draft.id, { content: 'no conversation yet', quote: active.receipt.messageId }),
    { code: 'invalid_chat_quote' });
  assert.equal(f.counts.receive, before);
});

// Real sender authorization and SQLite prepare boundary, within fixture-owned
// databases. Run for quote access-order changes; unrelated UI may skip.
test('quote authorization rejects before any reference query', async t => {
  const f = fixture(t), active = await activate(f);
  const prepare = f.reader._open().prepare.bind(f.reader._open());
  let quoteReads = 0;
  const sender = new ChatSender({ conversations: f.conversations,
    c4Reader: { _open: () => ({ prepare(sql) {
      if (/\bFROM\s+conversations\b/i.test(sql)) quoteReads++;
      return prepare(sql);
    } }) }, loadCore: async () => f.core, zylosDir: f.root });
  const before = f.counts.receive;
  await assert.rejects(sender.send(active.id, { content: 'denied', quote: active.receipt.messageId }, {
    authorize: () => ({ status: 403, error: 'chat_conversation_forbidden' }),
  }), { code: 'chat_conversation_forbidden', statusCode: 403 });
  assert.equal(quoteReads, 0);
  assert.equal(f.counts.receive, before);
});

test('quote markers count toward the byte limit and cannot make empty content sendable', async t => {
  const f = fixture(t), active = await activate(f), quote = active.receipt.messageId;
  for (const content of ['', ' \n ']) {
    await assert.rejects(f.sender.send(active.id, { content, quote }), { code: 'invalid_chat_content' });
  }
  const prefix = `[quote c4_id=${quote}]\n`;
  const exact = 'a'.repeat(65536 - Buffer.byteLength(prefix));
  await f.sender.send(active.id, { content: exact, quote });
  assert.equal(Buffer.byteLength(f.rows(active.draft.localId).at(-1).content), 65536);
  const before = f.counts.receive;
  await assert.rejects(f.sender.send(active.id, { content: exact + 'a', quote }), { code: 'invalid_chat_content' });
  assert.equal(f.counts.receive, before);
});

for (const notification of ['failed', 'suppressed']) {
test(`quote retries preserve exact pending content and reuse a ${notification} notification receipt`, async t => {
  const f = fixture(t), active = await activate(f), quote = active.receipt.messageId;
  f.setInvoke(() => { throw Error('private uncertain receive'); });
  const uncertain = await f.sender.send(active.id, { content: 'retry body', quote });
  assert.equal(uncertain.stored, null);
  assert.equal(f.conversations.get(active.draft.localId).pendingContent, `[quote c4_id=${quote}]\nretry body`);
  await f.makeSender().send(active.id, { content: 'retry body', quote });
  assert.equal(f.counts.receive, 2, 'unconfirmed repeat cannot receive again');
  f.setInvoke(null);
  f.setRoute({ decision: 'unavailable', runtime: 'claude', health: 'unavailable', reason: 'fixture' });
  f.setNotification(notification);
  const expectedContent = `[quote c4_id=${quote}]\nretry body` + (notification === 'suppressed'
    ? '\n\n[C4] Status notification suppressed by cooldown while health=unavailable reason=fixture.' : '');
  const sent = await f.makeSender().send(active.id, { content: 'retry body', quote, retry: true });
  assert.equal(f.rows(active.draft.localId).at(-1).content, expectedContent);
  if (notification === 'suppressed') assert.equal(sent.action, 'suppressed');
  else assert.equal(sent.error, 'UNHEALTHY_NOTIFY_FAILED');
  const again = await f.makeSender().send(active.id, { content: 'retry body', quote, retry: true });
  assert.equal(f.rows(active.draft.localId).at(-1).content, expectedContent);
  assert.equal(again.messageId, sent.messageId);
  assert.equal(f.counts.receive, 3);
  assert.equal(f.rows(active.draft.localId).length, 2);
  const changed = await f.makeSender().send(active.id, { content: 'retry body', quote: sent.messageId });
  assert.notEqual(changed.messageId, sent.messageId, 'a different quote is a different complete string');
  assert.ok(f.rows(active.draft.localId).at(-1).content.startsWith(`[quote c4_id=${sent.messageId}]\nretry body`));
});
}

test('creating, reopening and renaming a draft leaves Core empty and never starts a receive', async t => {
  const f = fixture(t), draft = f.conversations.create({ displayName: '方案' });
  assert.equal(draft.state, 'draft');
  assert.equal(draft.namespace, null);
  const renamed = f.conversations.rename(draft.localId, '比较方案');
  assert.equal(renamed.displayName, '比较方案');
  assert.equal((await f.sender.resolve(draft.id)).localId, draft.localId);
  const reopened = await f.makeSender().reconcile(draft.id);
  assert.equal(reopened.draft, true);
  assert.equal(f.conversations.get(draft.localId).displayName, '比较方案');
  assert.equal(f.counts.receive, 0);
  emptyCore(f);
});

test('a canonical group ID cannot send through a registration that is still a draft', async t => {
  const f = fixture(t), draft = f.conversations.create();
  const binding = f.c4.ensureChannelNamespace('dashboard');
  const bound = f.conversations.bind(draft.localId, binding.namespace);
  assert.equal(bound.state, 'draft');
  assert.equal(bound.lastOutcome, null, 'the draft has no uncertain send to reconcile');
  const canonical = groupId(`${bound.namespace}:${draft.localId}`);
  const before = f.dashboard.db.prepare('SELECT * FROM chat_conversations WHERE local_id=?').get(draft.localId);
  await assert.rejects(f.sender.send(canonical, { content: 'forged canonical draft submission' }), {
    code: 'chat_conversation_forbidden', statusCode: 403,
  });
  assert.deepEqual(f.dashboard.db.prepare('SELECT * FROM chat_conversations WHERE local_id=?').get(draft.localId), before);
  assert.equal(f.counts.receive, 0);
  assert.equal(f.counts.routes, 0);
  assert.equal(f.counts.notifications, 0);
  assert.equal(f.count('conversations'), 0);
  assert.equal(f.count('group_heads'), 0);
  assert.equal(f.count('channel_namespaces'), 1, 'only the fixture namespace binding exists');
});

test('local ID collisions retry without changing an existing registration or Core history', t => {
  const sequence = ['same', 'same', 'fresh'];
  const f = fixture(t, { idGenerator: () => sequence.shift() });
  const first = f.conversations.create({ displayName: '保留' });
  const second = f.conversations.create({ displayName: '新建' });
  assert.equal(first.localId, 'same');
  assert.equal(second.localId, 'fresh');
  assert.equal(f.conversations.get('same').displayName, '保留');
  emptyCore(f);
});

test('first and later messages retain the registered endpoint and group through rename and reopen', async t => {
  const f = fixture(t), { draft, receipt, id } = await activate(f);
  assert.equal(receipt.stored, true);
  assert.equal(receipt.retryAllowed, false, 'stored receipts never permit a retry');
  assert.equal(receipt.deliveryState, 'pending');
  assert.equal(receipt.messageId, f.rows(draft.localId)[0].id);
  assert.equal(f.conversations.get(draft.localId).firstMessageId, receipt.messageId);
  assert.equal(f.count('group_heads'), 1);
  assert.equal(f.counts.receive, 1);
  const initialReplay = await f.sender.send(draft.id, { content: 'hello first' });
  assert.equal(initialReplay.messageId, receipt.messageId);
  assert.equal(initialReplay.retryAllowed, false);
  await assert.rejects(f.sender.send(draft.id, { content: 'different initial text' }), {
    code: 'chat_conversation_started', statusCode: 409, conversationId: id, preserveInput: true,
  });
  f.conversations.rename(draft.localId, 'new name');
  const second = await f.makeSender().send(id, { content: 'after TTL and refresh' });
  assert.equal(second.stored, true);
  assert.equal(second.retryAllowed, false, 'stored receipts never permit a retry');
  assert.equal(f.count('group_heads'), 1);
  for (const row of f.rows(draft.localId)) {
    assert.equal(row.endpoint_id, draft.localId);
    assert.equal(row.session_group, `${receipt.namespace}:${draft.localId}`);
  }
  const replay = await f.sender.send(draft.id, { content: 'hello first' });
  assert.equal(replay.messageId, receipt.messageId);
  assert.equal(replay.retryAllowed, false);
  await assert.rejects(f.sender.send(draft.id, { content: 'a new message in a stale draft tab' }), {
    code: 'chat_conversation_started', statusCode: 409, conversationId: id, preserveInput: true,
  });
  assert.equal(f.counts.receive, 2, 'old draft endpoint cannot become a later send');
  assert.equal(f.db.open, true, 'receive must not close its caller database');
});

test('explicit local groups keep interleaved replies separate and group-less storage ignores history', async t => {
  const f = fixture(t), a = await activate(f, 'A'), b = await activate(f, 'B');
  await f.sender.send(a.id, { content: 'A again' });
  await f.sender.send(b.id, { content: 'B again' });
  for (const rename of [false, true]) {
    if (rename) f.conversations.rename(a.draft.localId, 'A after TTL');
    const beforeB = f.rows(b.draft.localId).length;
    const out = f.c4.insertConversation('out', 'dashboard', a.draft.localId, 'reply with component local group', { groupName: a.draft.localId });
    assert.equal(out.session_group, `${a.receipt.namespace}:${a.draft.localId}`);
    const ungrouped = f.c4.insertConversation('out', 'dashboard', a.draft.localId, 'no queried local group');
    assert.equal(ungrouped.session_group, a.receipt.namespace, 'storage never infers a local group from inbound history');
    assert.equal(f.rows(b.draft.localId).length, beforeB);
  }
  assert.equal(f.count('group_heads'), 3);
});

test('invalid content and foreign or forged conversation identities make no receive call', async t => {
  const f = fixture(t), draft = f.conversations.create();
  for (const content of ['', '  \n', null, 'x'.repeat(65537)]) {
    await assert.rejects(f.sender.send(draft.id, { content }));
  }
  for (const id of ['unknown', 'd:not-registered', groupId('telegram:outside'), groupId('dashboard:forged')]) {
    await assert.rejects(f.sender.send(id, { content: 'must not send' }));
  }
  assert.equal(f.counts.receive, 0);
  emptyCore(f);
});

for (const failure of ['begin', 'rollback']) {
  test(`a real Core ${failure} write failure is definite and leaves draft input retryable`, async t => {
    const f = fixture(t), draft = f.conversations.create();
    f.c4.ensureChannelNamespace('dashboard');
    if (failure === 'begin') {
      const broken = new Proxy(f.db, { get(target, key) {
        if (key === 'exec') return sql => { if (sql === 'BEGIN IMMEDIATE') throw Object.assign(Error('fixture locked'), { code: 'SQLITE_BUSY' }); return target.exec(sql); };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
      const store = createStore(broken, { validateComponent: () => true });
      f.setInvoke(args => receive(args, { db: store, queryRoute: async () => ({ decision: 'pending', runtime: 'claude' }), diagnostic() {} }));
    } else {
      f.db.exec("CREATE TRIGGER reject_fixture_inbound BEFORE INSERT ON conversations BEGIN SELECT RAISE(ABORT, 'fixture rejected insert'); END");
    }
    const receipt = await f.sender.send(draft.id, { content: 'keep this input' });
    assert.equal(receipt.stored, false);
    assert.equal(receipt.error, failure === 'begin' ? 'DB_BUSY' : 'DB_WRITE_FAILED');
    assert.equal(receipt.needsReconciliation, false);
    assert.equal(receipt.retryAllowed, true);
    assert.equal(receipt.preserveInput, true);
    assert.equal(f.conversations.get(draft.localId).pendingContent, 'keep this input');
    assert.equal(f.count('conversations'), 0);
    assert.equal(f.count('group_heads'), 0);
    assert.equal(f.db.inTransaction, false, 'failed write rolled back');
  });
}

test('a branded pre-insert validation error with persisted empty is not treated as unknown', async t => {
  const f = fixture(t), draft = f.conversations.create();
  f.setInvoke(() => { throw dataError('INVALID_ARGS', 'fixture rejected before insert', { persisted: [] }); });
  const result = await f.sender.send(draft.id, { content: 'retain me' });
  assert.equal(result.stored, false);
  assert.equal(result.needsReconciliation, false);
  assert.equal(result.retryAllowed, true);
  assert.equal(f.conversations.get(draft.localId).pendingContent, 'retain me');
  assert.equal(f.count('group_heads'), 0);
});

test('a suppressed initial receipt is stored failed state and a repeated initial click cannot insert again', async t => {
  const f = fixture(t), draft = f.conversations.create();
  f.setRoute({ decision: 'unavailable', runtime: 'claude', health: 'unavailable', reason: 'fixture' });
  const result = await f.sender.send(draft.id, { content: 'suppressed inbound' });
  assert.equal(result.action, 'suppressed');
  assert.equal(result.stored, true);
  assert.equal(result.retryAllowed, false, 'stored receipts never permit a retry');
  assert.equal(result.deliveryState, 'suppressed');
  assert.equal(f.conversations.get(draft.localId).state, 'active');
  const again = await f.sender.send(draft.id, { content: 'suppressed inbound', retry: true });
  assert.equal(again.messageId, result.messageId);
  assert.equal(again.retryAllowed, false);
  assert.equal(f.counts.receive, 1);
  assert.equal(f.count('conversations'), 1);
});

for (const code of ['UNHEALTHY_NOTIFY_FAILED', 'UNHEALTHY_NOTIFY_UNCERTAIN']) {
  test(`a ${code} receipt with a committed row is never retried as an initial send`, async t => {
    const f = fixture(t), draft = f.conversations.create();
    f.setRoute({ decision: 'unavailable', runtime: 'claude', health: 'unavailable', reason: 'fixture' });
    f.setNotification(code === 'UNHEALTHY_NOTIFY_FAILED' ? 'failed' : 'uncertain');
    const first = await f.sender.send(draft.id, { content: 'committed before notification' });
    assert.equal(first.stored, true);
    assert.equal(first.retryAllowed, false, 'stored receipts never permit a retry');
    assert.equal(first.deliveryState, 'failed', 'authority row takes precedence over notice action');
    assert.equal(first.error, code);
    assert.equal(f.counts.notifications, 1);
    assert.equal(f.conversations.get(draft.localId).firstMessageId, first.messageId);
    await f.makeSender().send(draft.id, { content: 'committed before notification', retry: true });
    assert.equal(f.counts.receive, 1);
    assert.equal(f.count('conversations'), 1);
  });
}

test('an unknown initial send without a head preserves input across reopen and needs an explicit retry', async t => {
  const f = fixture(t), draft = f.conversations.create();
  f.setInvoke(() => { throw Error('fixture unknown before commit'); });
  const result = await f.sender.send(draft.id, { content: 'initial uncertain input' });
  assert.equal(result.preserveInput, true);
  assert.equal(f.count('group_heads'), 0);
  assert.equal(f.conversations.get(draft.localId).pendingContent, 'initial uncertain input');
  const fresh = f.makeSender();
  await fresh.reconcile(draft.id);
  await fresh.send(draft.id, { content: 'initial uncertain input' });
  assert.equal(f.counts.receive, 1, 'refresh and unconfirmed repeat cannot resend unknown initial input');
  f.setInvoke(null);
  const retried = await fresh.send(draft.id, { content: 'initial uncertain input', retry: true });
  assert.equal(retried.stored, true);
  assert.equal(retried.retryAllowed, false, 'stored receipts never permit a retry');
  assert.equal(f.counts.receive, 2);
});

test('an unknown initial send with an established head activates the conversation without repeating receive', async t => {
  const f = fixture(t), draft = f.conversations.create();
  f.setInvoke(async args => { await f.realReceive(args); throw Error('fixture lost receipt after commit'); });
  const result = await f.sender.send(draft.id, { content: 'lost initial receipt' });
  assert.equal(result.draft, false);
  assert.equal(f.conversations.get(draft.localId).state, 'active');
  assert.equal(f.conversations.get(draft.localId).firstMessageId, null, 'a head only proves the group exists');
  await f.makeSender().reconcile(draft.id);
  await f.sender.send(draft.id, { content: 'lost initial receipt', retry: true });
  assert.equal(f.counts.receive, 1);
  assert.equal(f.count('conversations'), 1);
});

test('head recovery prevents canonical retries of the first text and permits a new subsequent message', async t => {
  const f = fixture(t), draft = f.conversations.create();
  f.setInvoke(async args => { await f.realReceive(args); throw Error('lost initial receipt'); });
  const sent = await f.sender.send(draft.id, { content: 'committed first text' });
  const restarted = f.makeSender();
  const canonical = sent.conversationId;
  assert.ok(canonical.startsWith('g:'));
  for (const id of [draft.id, canonical]) {
    const opened = await restarted.reconcile(id);
    assert.equal(opened.stored, true);
    assert.equal(opened.messageId, null, 'head evidence cannot invent a message ID');
    assert.equal(opened.needsReconciliation, true);
    assert.equal(opened.retryAllowed, false);
    assert.equal(opened.preserveInput, false);
  }
  const replay = await restarted.send(canonical, { content: 'committed first text', retry: true });
  assert.equal(replay.retryAllowed, false);
  assert.equal(replay.stored, true);
  assert.equal(f.counts.receive, 1);
  assert.deepEqual(f.rows(draft.localId).map(row => row.content), ['committed first text']);
  await assert.rejects(restarted.send(draft.id, { content: 'new text from old draft', retry: true }), {
    code: 'chat_conversation_started', statusCode: 409, conversationId: canonical, preserveInput: true,
  });
  assert.equal(f.counts.receive, 1);
  f.setInvoke(null);
  const later = await restarted.send(canonical, { content: 'normal subsequent text' });
  assert.equal(later.stored, true);
  assert.equal(later.retryAllowed, false);
  assert.equal(f.counts.receive, 2);
  assert.deepEqual(f.rows(draft.localId).map(row => row.content), ['committed first text', 'normal subsequent text']);
  assert.equal(f.conversations.get(draft.localId).firstMessageId, null);
});

test('a later receipt cannot become the authority for an unknown initial message', async t => {
  const f = fixture(t), draft = f.conversations.create();
  f.setInvoke(async args => { await f.realReceive(args); throw Error('lost initial receipt'); });
  const first = await f.sender.send(draft.id, { content: 'initial unknown message' });
  assert.equal(first.draft, false);
  assert.equal(first.messageId, null);
  f.setInvoke(null);
  const later = await f.sender.send(first.conversationId, { content: 'deliberate later message' });
  assert.equal(later.stored, true);
  assert.equal(later.retryAllowed, false, 'stored receipts never permit a retry');
  assert.ok(later.messageId);
  assert.equal(f.conversations.get(draft.localId).firstMessageId, null);
  const initialReplay = await f.sender.send(draft.id, { content: 'initial unknown message' });
  assert.equal(initialReplay.messageId, null);
  assert.equal(initialReplay.stored, true, 'activation proves the first insert committed');
  assert.equal(initialReplay.needsReconciliation, true);
  assert.equal(f.counts.receive, 2);
});

test('failed initial head reconciliation remains pending and opening it retries only the head query', async t => {
  const f = fixture(t), draft = f.conversations.create();
  f.setInvoke(async args => { await f.realReceive(args); f.setQueryError(true); throw Error('fixture unknown result'); });
  const result = await f.sender.send(draft.id, { content: 'reconcile after recovery' });
  assert.equal(result.needsReconciliation, true);
  assert.equal(f.conversations.get(draft.localId).state, 'unknown');
  f.setQueryError(false);
  const opened = await f.makeSender().reconcile(draft.id);
  assert.equal(opened.draft, false);
  assert.equal(f.conversations.get(draft.localId).state, 'active');
  assert.equal(f.counts.receive, 1, 'opening a conversation must not call receive');
});

test('an owned canonical list entry opens and reconciles an uncertain first send', async t => {
  const f = fixture(t), draft = f.conversations.create({ displayName: 'Preserved title' });
  f.setInvoke(async args => { await f.realReceive(args); f.setQueryError(true); throw Error('lost first receipt'); });
  assert.equal((await f.sender.send(draft.id, { content: 'uncertain first message' })).needsReconciliation, true);
  f.setQueryError(false);
  const history = new ChatHistory({ c4Reader: f.reader, conversations: f.conversations });
  const listed = history.list({ tab: 'mine' }).items;
  assert.equal(listed.length, 1);
  assert.ok(listed[0].id.startsWith('g:'));
  assert.equal(listed[0].display_name, 'Preserved title');
  assert.equal(listed[0].draft, false);
  assert.equal(f.conversations.get(draft.localId).state, 'unknown');
  const opened = await f.makeSender().reconcile(listed[0].id);
  assert.equal(opened.draft, false);
  assert.equal(opened.messageId, null);
  assert.equal(opened.stored, true);
  assert.equal(opened.retryAllowed, false);
  assert.equal(opened.preserveInput, false);
  assert.equal(f.conversations.get(draft.localId).state, 'active');
  assert.equal((await f.sender.resolve(listed[0].id)).localId, draft.localId);
  assert.equal(f.counts.receive, 1);
  await assert.rejects(f.sender.send(draft.id, { content: 'different after delayed head recovery' }), {
    code: 'chat_conversation_started', statusCode: 409, conversationId: listed[0].id, preserveInput: true,
  });
  const replay = await f.makeSender().send(listed[0].id, { content: 'uncertain first message', retry: true });
  assert.equal(replay.retryAllowed, false);
  assert.equal(f.rows(draft.localId).length, 1);
  assert.equal(f.counts.receive, 1);
});

test('an unknown later send survives restart and refresh without resending until the user explicitly retries', async t => {
  const f = fixture(t), active = await activate(f);
  f.setInvoke(() => { throw Error('fixture unknown later result'); });
  const result = await f.sender.send(active.id, { content: 'later uncertain input' });
  assert.equal(result.needsReconciliation, true);
  assert.equal(result.preserveInput, true);
  assert.equal(f.conversations.get(active.draft.localId).pendingContent, 'later uncertain input');
  const restarted = f.makeSender();
  await restarted.reconcile(active.id);
  await restarted.send(active.id, { content: 'later uncertain input' });
  await restarted.reconcile(active.id);
  assert.equal(f.counts.receive, 2);
  f.setInvoke(null);
  const retried = await restarted.send(active.id, { content: 'later uncertain input', retry: true });
  assert.equal(retried.stored, true);
  assert.equal(retried.retryAllowed, false, 'stored receipts never permit a retry');
  assert.equal(f.counts.receive, 3);
  assert.equal(f.count('group_heads'), 1);
});

test('a committed non-success later receipt reuses authority for the same input rather than receiving again', async t => {
  const f = fixture(t), active = await activate(f);
  f.setInvoke(async args => {
    const result = await f.realReceive(args);
    throw dataError('UNHEALTHY_NOTIFY_FAILED', 'fixture notice failed', { persisted: ['D1'], id: result.id });
  });
  const first = await f.sender.send(active.id, { content: 'committed later' });
  assert.equal(first.stored, true);
  assert.equal(first.retryAllowed, false, 'stored receipts never permit a retry');
  const repeat = await f.makeSender().send(active.id, { content: 'committed later', retry: true });
  assert.equal(repeat.messageId, first.messageId);
  assert.equal(repeat.retryAllowed, false);
  assert.equal(f.counts.receive, 2);
  assert.equal(f.rows(active.draft.localId).length, 2);
});

test('historical local IDs reported by the collision callback are skipped without overwriting their Core group', t => {
  const sequence = ['historical', 'available'];
  let coreDb;
  const checked = [];
  const f = fixture(t, { idGenerator: () => sequence.shift(), isUsed(localId) {
    checked.push(localId);
    return !!coreDb.prepare("SELECT 1 FROM conversations WHERE channel='dashboard' AND endpoint_id=? LIMIT 1").get(localId);
  } });
  coreDb = f.db;
  const historical = f.c4.insertConversation('in', 'dashboard', 'historical', 'retained history', { groupName: 'historical' });
  const draft = f.conversations.create({ displayName: 'new draft' });
  assert.equal(draft.localId, 'available');
  assert.deepEqual(checked, ['historical', 'available']);
  assert.equal(f.db.prepare('SELECT content FROM conversations WHERE id=?').get(historical.id).content, 'retained history');
  assert.equal(f.count('conversations'), 1);
  assert.equal(f.count('group_heads'), 1);
  assert.equal(f.dashboard.db.prepare('SELECT count(*) AS n FROM chat_conversations WHERE local_id=?').get('historical').n, 0);
  assert.equal(f.counts.receive, 0);
});

test('concurrent initial submissions share one in-flight receive for the registered local ID', { timeout: 3000 }, async t => {
  const f = fixture(t), draft = f.conversations.create();
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.setInvoke(async args => { entered(); await blocked; return f.realReceive(args); });
  const pending = f.sender.send(draft.id, { content: 'one initial submission' });
  try {
    await Promise.race([started, pending.then(() => { throw Error('receive finished before the fixture barrier'); })]);
    const duplicate = await f.sender.send(draft.id, { content: 'one initial submission' });
    assert.equal(duplicate.preserveInput, true);
    assert.equal(duplicate.retryAllowed, false);
    assert.equal(duplicate.needsReconciliation, true);
    assert.equal(f.counts.receive, 1);
    assert.equal(f.count('conversations'), 0);
    assert.equal(f.count('group_heads'), 0);
  } finally { release(); await pending; }
  assert.equal(f.counts.receive, 1);
  assert.equal(f.count('conversations'), 1);
  assert.equal(f.count('group_heads'), 1);
});

test('authorization is rechecked after asynchronous Core loading before namespace allocation or draft writes', async t => {
  const f = fixture(t), draft = f.conversations.create({ displayName: 'unchanged registration' });
  const before = f.dashboard.db.prepare('SELECT * FROM chat_conversations WHERE local_id=?').get(draft.localId);
  let loaded = false, namespaceAllocations = 0;
  const sender = new ChatSender({ conversations: f.conversations, c4Reader: { _open: () => f.db }, zylosDir: f.root,
    loadCore: async () => {
      await Promise.resolve();
      loaded = true;
      return { ...f.core, ensureChannelNamespace: name => { namespaceAllocations++; return f.core.ensureChannelNamespace(name); } };
    } });
  await assert.rejects(sender.send(draft.id, { content: 'must remain unsent' }, { authorize() {
    assert.equal(loaded, true, 'authorization must run after awaiting the Core dependency');
    return { status: 403, error: 'chat_requires_multi' };
  } }), { code: 'chat_requires_multi', statusCode: 403 });
  assert.equal(namespaceAllocations, 0);
  assert.equal(f.counts.receive, 0);
  assert.deepEqual(f.dashboard.db.prepare('SELECT * FROM chat_conversations WHERE local_id=?').get(draft.localId), before);
  emptyCore(f);
});

test('starting a send rolls back its pending input and state if the outcome write fails', t => {
  let now = 1000;
  const f = fixture(t, { now: () => now }), draft = f.conversations.create();
  const before = f.dashboard.db.prepare('SELECT * FROM chat_conversations WHERE local_id=?').get(draft.localId);
  f.dashboard.db.exec("CREATE TRIGGER reject_fixture_outcome BEFORE UPDATE OF last_outcome ON chat_conversations BEGIN SELECT RAISE(ABORT, 'fixture outcome write rejected'); END");
  now = 2000;
  assert.throws(() => f.conversations.beginSend(draft.localId, { content: 'not yet submitted', initial: true }), /fixture outcome write rejected/);
  assert.deepEqual(f.dashboard.db.prepare('SELECT * FROM chat_conversations WHERE local_id=?').get(draft.localId), before);
  assert.equal(f.dashboard.db.inTransaction, false);
  assert.equal(f.counts.receive, 0);
  emptyCore(f);
});

// The private connection wrapper counts or rejects only the exact head read.
// Namespace ownership remains readable so a retry must be stopped by failed
// reconciliation itself, rather than an earlier unrelated connection failure.
function headProbe(f) {
  let reads = 0, reject = false;
  const connection = new Proxy(f.db, { get(target, key) {
    if (key === 'prepare') return sql => {
      if (/FROM group_heads WHERE session_group=/.test(sql)) {
        reads++;
        if (reject) throw Error('private head lookup unavailable');
      }
      return target.prepare(sql);
    };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const sender = new ChatSender({ conversations: f.conversations, c4Reader: { _open: () => connection },
    loadCore: async () => f.core, zylosDir: f.root });
  return { sender, count: () => reads, setReject: value => { reject = value; } };
}

test('an old draft rejects different text when its send call recovers the committed first insert', async t => {
  const f = fixture(t), draft = f.conversations.create(), probe = headProbe(f);
  probe.setReject(true);
  f.setInvoke(async args => { await f.realReceive(args); throw Error('lost committed first receipt'); });
  const first = await probe.sender.send(draft.id, { content: 'committed while head lookup failed' });
  assert.equal(first.needsReconciliation, true);
  assert.equal(f.conversations.get(draft.localId).state, 'unknown');
  assert.equal(probe.count(), 1);
  assert.equal(f.counts.receive, 1);
  assert.equal(f.count('group_heads'), 1);
  const pending = f.conversations.get(draft.localId);
  const canonical = groupId(`${pending.namespace}:${draft.localId}`);
  probe.setReject(false);
  f.setInvoke(null);
  // Do not open/reconcile first: this send must recover the head itself before
  // checking whether the old draft ID is trying to submit different text.
  await assert.rejects(probe.sender.send(draft.id, { content: 'different text after unknown first result' }), {
    code: 'chat_conversation_started', statusCode: 409, conversationId: canonical, preserveInput: true,
  });
  assert.equal(probe.count(), 2, 'the second send performs its own head reconciliation');
  assert.equal(f.conversations.get(draft.localId).state, 'active');
  assert.equal(f.conversations.get(draft.localId).firstMessageId, null, 'head recovery cannot invent a first message ID');
  assert.equal(f.counts.receive, 1, 'different text is not silently sent as another first message');
  const rows = f.rows(draft.localId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'committed while head lookup failed');
});

test('a branded unknown commit error with null persisted state checks the head and retains uncertain input', async t => {
  const f = fixture(t), draft = f.conversations.create(), probe = headProbe(f);
  f.setInvoke(() => { throw dataError('INTERNAL_ERROR', 'Core commit state unknown', { persisted: null }); });
  const result = await probe.sender.send(draft.id, { content: 'uncertain branded input' });
  assert.equal(probe.count(), 1, 'unknown commit state requires an exact head lookup');
  assert.equal(result.stored, null, 'unknown is distinct from explicitly not stored');
  assert.equal(result.preserveInput, true);
  assert.equal(f.conversations.get(draft.localId).lastOutcome.kind, 'unknown');
  assert.equal(f.conversations.get(draft.localId).pendingContent, 'uncertain branded input');
  assert.equal(f.counts.receive, 1);
  assert.equal(f.count('conversations'), 0);
});

test('explicit retry cannot call receive while the first send head lookup remains unavailable', async t => {
  const f = fixture(t), draft = f.conversations.create(), probe = headProbe(f);
  probe.setReject(true);
  f.setInvoke(() => { throw dataError('INTERNAL_ERROR', 'Core commit state unknown', { persisted: null }); });
  const first = await probe.sender.send(draft.id, { content: 'keep waiting for authority' });
  assert.equal(first.needsReconciliation, true);
  assert.equal(first.retryAllowed, false);
  f.setInvoke(null);
  const retry = await probe.sender.send(draft.id, { content: 'keep waiting for authority', retry: true });
  assert.equal(probe.count(), 2);
  assert.equal(retry.needsReconciliation, true);
  assert.equal(retry.retryAllowed, false);
  assert.equal(retry.preserveInput, true);
  assert.equal(f.counts.receive, 1, 'retry must not bypass a failed head lookup');
  assert.equal(f.count('conversations'), 0);
});

test('a suppressed later message replays the same stored receipt without another receive', async t => {
  const f = fixture(t), active = await activate(f);
  f.setRoute({ decision: 'unavailable', runtime: 'claude', health: 'unavailable', reason: 'fixture' });
  const first = await f.sender.send(active.id, { content: 'later notification suppressed' });
  assert.equal(first.action, 'suppressed');
  assert.equal(first.stored, true);
  assert.equal(first.retryAllowed, false);
  assert.equal(first.deliveryState, 'suppressed');
  const replay = await f.makeSender().send(active.id, { content: 'later notification suppressed', retry: true });
  assert.equal(replay.messageId, first.messageId);
  assert.equal(replay.retryAllowed, false);
  assert.equal(f.counts.receive, 2);
  assert.equal(f.rows(active.draft.localId).length, 2);
});

test('an absent authority row yields reconciliation state rather than pending delivery', async t => {
  const f = fixture(t), active = await activate(f);
  f.db.prepare('DELETE FROM conversations WHERE id=?').run(active.receipt.messageId);
  const reopened = await f.makeSender().reconcile(active.id);
  assert.equal(reopened.stored, true, 'saved commit evidence is retained');
  assert.equal(reopened.messageId, active.receipt.messageId);
  assert.equal(reopened.deliveryState, 'pending_reconciliation');
  assert.equal(reopened.needsReconciliation, true);
  assert.equal(reopened.retryAllowed, false);
  assert.equal(f.counts.receive, 1);
});

test('an unnamed draft activates without a human naming lock and remains nameable by the agent', async t => {
  const f = fixture(t), draft = f.conversations.create();
  assert.equal(draft.displayName, null);
  const sent = await f.sender.send(draft.id, { content: 'unnamed discussion' });
  const key = `${sent.namespace}:${draft.localId}`;
  assert.equal(sent.stored, true);
  assert.equal(sent.retryAllowed, false);
  assert.equal(f.dashboard.getGroupDisplayName(key), null);
  assert.equal(f.dashboard.writeGroupDisplayName(key, 'Agent supplied name', 'agent'), true);
  assert.equal(f.conversations.get(draft.localId).displayName, 'Agent supplied name');
  assert.equal(f.dashboard.getGroupDisplayName(key).source, 'agent');
});
