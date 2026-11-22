import assert from 'node:assert/strict';
import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { createChatApiFixture } from './helpers/chat-integration-api.js';
import { ORIGIN_CONVERSATION_ID } from '../src/lib/chat/origin.js';

// Boundary: authenticated chat HTTP, Core messages and Dashboard read positions.
// Run for unread projection, delivery receipts, timeline pagination, or read
// authorization changes. Unrelated rendering and runtime changes may skip.
// The runner and sandbox verify isolated HOME/ZYLOS_DIR/PM2_HOME, short
// TMPDIR/socket and fixture DB paths, and close SQLite and loopback HTTP on
// success, failure or timeout. No real runtime or channel is started.
test('read positions are monotonic, scoped, and updated by a stored send',
  { skip: !chatEnabled(), timeout: 20000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const f = await createChatApiFixture(t, sandbox);
      const a = await f.createConversation('existing A'), b = await f.createConversation('existing B');
      const id = a.receipt.conversationId;
      const list = async tab => {
        const result = await f.request(`/api/conversations?tab=${tab}`);
        assert.equal(result.status, 200, result.text);
        return result.body.items;
      };
      const read = (upTo, options) => f.request(a.route + '/read', { method: 'PUT', body: { upTo }, ...options });
      const oldReply = f.addOutbound(a.draft.localId, 'reply before the upgrade');
      f.store.db.prepare("UPDATE chat_read_positions SET last_read=? WHERE conversation_id=''").run(oldReply.id);
      assert.ok((await list('mine')).every(item => item.unread === false));

      const reply = f.addOutbound(a.draft.localId, 'new reply');
      assert.equal((await list('mine')).find(item => item.id === id).unread, true);
      const send = await f.request(a.route + '/send', { method: 'POST', body: { content: 'I have caught up' } });
      assert.equal(send.status, 200, send.text);
      assert.equal(send.body.stored, true);
      assert.equal(f.history.readPosition(id), send.body.messageId);
      assert.equal((await list('mine')).find(item => item.id === id).unread, false);
      f.c4.insertConversation('in', 'dashboard', a.draft.localId, 'Own message beyond the read position',
        { groupName: a.draft.localId });
      assert.equal((await list('mine')).find(item => item.id === id).unread, false);

      const next = f.addOutbound(a.draft.localId, 'newer reply');
      const upTo = await read(next.id);
      assert.deepEqual(upTo.body, { ok: true, readUpTo: next.id });
      assert.deepEqual((await read(reply.id)).body, upTo.body);
      const changes = f.store.db.prepare('SELECT total_changes() AS n').get().n;
      assert.equal(f.history.markRead(id, reply.id), next.id);
      assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changes);
      const wrongConversation = await read(b.receipt.messageId);
      assert.deepEqual([wrongConversation.status, wrongConversation.body.error.code, wrongConversation.body.error.param],
        [400, 'invalid_parameter', 'upTo']);
      f.config.chat.allowRemote = true;
      for (const [options, code] of [
        [{ identity: 'read' }, 'insufficient_scope'],
        [{ origin: 'https://elsewhere.invalid' }, 'same_origin_required'],
      ]) {
        const denied = await read(next.id, options);
        assert.deepEqual([denied.status, denied.body.error.code], [403, code]);
      }
      const external = f.c4.insertConversation('in', 'telegram', 'probe', 'external');
      const [externalItem] = await list('external');
      assert.equal(Object.hasOwn(externalItem, 'unread'), false);
      const deniedExternal = await f.request(`/api/conversations/${encodeURIComponent(externalItem.id)}/read`,
        { method: 'PUT', body: { upTo: external.id } });
      assert.deepEqual([deniedExternal.status, deniedExternal.body.error.code], [404, 'not_found']);

      const originReply = f.addOutbound('origin', 'Origin reply');
      assert.equal((await list('mine')).find(item => item.id === ORIGIN_CONVERSATION_ID).unread, true);
      const originRead = await f.request(`/api/conversations/${encodeURIComponent(ORIGIN_CONVERSATION_ID)}/read`,
        { method: 'PUT', body: { upTo: originReply.id } });
      assert.deepEqual(originRead.body, { ok: true, readUpTo: originReply.id });
    });
  });

test('read anchor straddles a deleted message ID and pages in both directions',
  { skip: !chatEnabled(), timeout: 20000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const f = await createChatApiFixture(t, sandbox);
      const a = await f.createConversation('start');
      const group = a.receipt.namespace + ':' + a.draft.localId;
      const add = f.db.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,session_group,content,status)
        VALUES ('out','dashboard',?,?,?,'delivered')`);
      const messages = Array.from({ length: 61 }, (_, index) =>
        Number(add.run(a.draft.localId, group, `reply ${index}`).lastInsertRowid));
      const boundary = messages[30];
      const stored = await f.request(a.route + '/read', { method: 'PUT', body: { upTo: boundary } });
      assert.equal(stored.status, 200, stored.text);
      f.db.prepare('DELETE FROM conversations WHERE id=?').run(boundary);

      const fetch = async query => {
        const result = await f.request(a.route + '/messages?' + new URLSearchParams(query));
        assert.equal(result.status, 200, result.text);
        return result.body;
      };
      const anchor = await fetch({ anchor: 'read', limit: '50' });
      assert.equal(anchor.readUpTo, boundary);
      assert.equal(anchor.unreadCount, 30);
      assert.deepEqual(anchor.items.map(row => row.id), [...messages.slice(5, 30), ...messages.slice(31, 56)]);
      const older = await fetch({ direction: 'before', cursor: anchor.nextCursor });
      assert.equal(older.items.at(-1).id, messages[4]);
      const newer = await fetch({ direction: 'after', cursor: anchor.afterCursor });
      assert.deepEqual(newer.items.map(row => row.id), messages.slice(56));
      for (let i = 0; i < 120; i++) add.run(a.draft.localId, group, 'another reply');
      const capped = await fetch({ anchor: 'read', limit: '50' });
      assert.equal(capped.unreadCount, 100);
      const latest = await fetch({ limit: '50' });
      assert.equal(latest.items.length, 50);
      assert.ok(latest.items[0].id > capped.items.at(-1).id);
      assert.equal(Object.hasOwn(latest, 'readUpTo'), false);
    });
  });
