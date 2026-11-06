import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
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
  assert.equal(receipt.deliveryState, 'pending');
  assert.equal(receipt.messageId, f.rows(draft.localId)[0].id);
  assert.equal(f.conversations.get(draft.localId).firstMessageId, receipt.messageId);
  assert.equal(f.count('group_heads'), 1);
  assert.equal(f.counts.receive, 1);
  f.conversations.rename(draft.localId, 'new name');
  const second = await f.makeSender().send(id, { content: 'after TTL and refresh' });
  assert.equal(second.stored, true);
  assert.equal(f.count('group_heads'), 1);
  for (const row of f.rows(draft.localId)) {
    assert.equal(row.endpoint_id, draft.localId);
    assert.equal(row.session_group, `${receipt.namespace}:${draft.localId}`);
  }
  const replay = await f.sender.send(draft.id, { content: 'a repeated initial click' });
  assert.equal(replay.messageId, receipt.messageId);
  assert.equal(f.counts.receive, 2, 'old draft endpoint cannot become a later send');
  assert.equal(f.db.open, true, 'receive must not close its caller database');
});

test('interleaved conversations and legacy group-less replies never route a reply into another conversation', async t => {
  const f = fixture(t), a = await activate(f, 'A'), b = await activate(f, 'B');
  await f.sender.send(a.id, { content: 'A again' });
  await f.sender.send(b.id, { content: 'B again' });
  for (const rename of [false, true]) {
    if (rename) f.conversations.rename(a.draft.localId, 'A after TTL');
    const beforeB = f.rows(b.draft.localId).length;
    const out = f.c4.insertConversation('out', 'dashboard', a.draft.localId, 'startup history reply without group');
    assert.equal(out.session_group, `${a.receipt.namespace}:${a.draft.localId}`);
    assert.equal(f.rows(b.draft.localId).length, beforeB);
  }
  assert.equal(f.count('group_heads'), 2);
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
  assert.equal(result.deliveryState, 'suppressed');
  assert.equal(f.conversations.get(draft.localId).state, 'active');
  const again = await f.sender.send(draft.id, { content: 'suppressed inbound', retry: true });
  assert.equal(again.messageId, result.messageId);
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

test('a later receipt cannot become the authority for an unknown initial message', async t => {
  const f = fixture(t), draft = f.conversations.create();
  f.setInvoke(async args => { await f.realReceive(args); throw Error('lost initial receipt'); });
  const first = await f.sender.send(draft.id, { content: 'initial unknown message' });
  assert.equal(first.draft, false);
  assert.equal(first.messageId, null);
  f.setInvoke(null);
  const later = await f.sender.send(first.conversationId, { content: 'deliberate later message', retry: true });
  assert.equal(later.stored, true);
  assert.ok(later.messageId);
  assert.equal(f.conversations.get(draft.localId).firstMessageId, null);
  const initialReplay = await f.sender.send(draft.id, { content: 'initial unknown message' });
  assert.equal(initialReplay.messageId, null);
  assert.equal(initialReplay.stored, null);
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
  assert.equal(opened.stored, null);
  assert.equal(f.conversations.get(draft.localId).state, 'active');
  assert.equal((await f.sender.resolve(listed[0].id)).localId, draft.localId);
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
  const repeat = await f.makeSender().send(active.id, { content: 'committed later', retry: true });
  assert.equal(repeat.messageId, first.messageId);
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
