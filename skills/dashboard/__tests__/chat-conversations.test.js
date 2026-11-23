import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../src/lib/store.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { ChatSender } from '../src/lib/chat/send.js';

import { createStore } from '../../comm-bridge/scripts/c4-v2-store.js';
import { receive } from '../../comm-bridge/scripts/c4-receive.js';
import { isDataError } from '../../comm-bridge/scripts/c4-session-group.js';
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

// Real sender authorization and SQLite prepare boundary, within fixture-owned
// databases. Run for quote access-order changes; unrelated UI may skip.

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

// The private connection wrapper counts or rejects only the exact head read.
// Namespace ownership remains readable so a retry must be stopped by failed
// reconciliation itself, rather than an earlier unrelated connection failure.

// In single mode, delivery records a message queued before the switch under
// `origin`; its conversation still finds the receipt by endpoint.
