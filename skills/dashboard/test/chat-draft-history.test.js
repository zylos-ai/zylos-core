import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { ChatHistory } from '../src/lib/chat/history.js';
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';

// Real isolated Dashboard and C4 SQLite only. Run for draft schema, naming,
// registration or list merge changes; skip unrelated UI and delivery changes.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR. This fixture owns
// both databases, makes C4 history readonly, and closes handles before cleanup;
// it never starts a runtime, child, network listener, tmux or PM2.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-draft-history-'));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const db = new Database(path.join(root, 'comm-bridge/c4.db'));
  migrateSchema(db, { isNew: true }); migrateToV2(db);
  db.prepare('INSERT INTO channel_namespaces VALUES (?,?)').run('dash-owned', 'dashboard');
  const store = new Store(path.join(root, 'dashboard.db'));
  const reader = new C4Reader(root);
  let now = Date.parse('2026-01-01T00:00:00Z'), sequence = 0;
  const conversations = new ChatConversations({ store, now: () => now, idGenerator: () => `draft-${++sequence}` });
  const history = new ChatHistory({ c4Reader: reader, conversations });
  let message = 0;
  const add = (localId, { channel = 'dashboard', group = `dash-owned:${localId}`, timestamp = new Date(now).toISOString(), content = 'stored body', head = true } = {}) => {
    const id = ++message;
    db.prepare(`INSERT INTO conversations(id,timestamp,direction,channel,endpoint_id,session_group,content,status)
      VALUES(?,?,'in',?,?,?,?,'pending')`).run(id, timestamp, channel, localId, group, content);
    if (head) db.prepare('INSERT OR REPLACE INTO group_heads VALUES(?,?)').run(group, id);
    return id;
  };
  t.after(() => { reader.close(); store.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, store, reader, conversations, history, add, setNow: value => { now = value; } };
}

function pages(history, tab, limit) {
  const items = [];
  let cursor;
  for (let count = 0; count < 30; count++) {
    const result = history.list({ tab, limit, cursor });
    assert.ok(result.items.length <= limit);
    items.push(...result.items);
    if (result.nextCursor === null) return items;
    assert.ok(result.items.length > 0, 'no empty page may advertise a continuation');
    cursor = result.nextCursor;
  }
  assert.fail('bounded pagination did not terminate');
}

test('drafts and stored conversations share stable bounded pages without crossing tabs', t => {
  const f = fixture(t);
  const drafts = Array.from({ length: 6 }, (_, index) => f.conversations.create({ displayName: `Draft ${index}` }));
  f.add('stored-a'); f.add('stored-b');
  f.add('external', { channel: 'telegram', group: 'tg:external' });
  f.add('hidden', { channel: 'internal', group: 'dash-owned:hidden' });
  const reads = [];
  const query = f.history._query.bind(f.history);
  f.history._query = (sql, parameters) => {
    const rows = query(sql, parameters); reads.push({ sql, count: rows.length }); return rows;
  };
  const sourceReads = [];
  const source = f.conversations.listDrafts.bind(f.conversations);
  f.conversations.listDrafts = options => {
    const rows = source(options); sourceReads.push({ options, count: rows.length }); return rows;
  };
  const items = pages(f.history, 'mine', 2);
  assert.equal(items.length, 8);
  assert.equal(new Set(items.map(item => item.id)).size, 8);
  assert.deepEqual(items.filter(item => item.draft).map(item => item.localId), drafts.map(item => item.localId));
  const sorted = [...items].sort((a, b) => b.stamp - a.stamp || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  assert.deepEqual(items.map(item => item.id), sorted.map(item => item.id));
  assert.ok(items.every(item => item.channel === 'dashboard'));
  assert.ok(reads.length && sourceReads.length);
  for (const read of reads) { assert.match(read.sql, /\bLIMIT\b/i); assert.ok(read.count <= 3); }
  for (const read of sourceReads) { assert.equal(read.options.limit, 3); assert.ok(read.count <= 3); }
  const external = pages(f.history, 'external', 1);
  assert.deepEqual(external.map(item => item.session_group), ['tg:external']);
  assert.equal(external[0].draft, false);
  assert.throws(() => f.history.list({ tab: 'external', cursor: f.history.list({ tab: 'mine', limit: 1 }).nextCursor }), { code: 'invalid_chat_cursor' });
});

test('draft refresh uses its updated time and activation removes the blank duplicate', t => {
  const f = fixture(t);
  const first = f.conversations.create({ displayName: 'First' });
  f.setNow(Date.parse('2026-01-02T00:00:00Z'));
  const second = f.conversations.create({ displayName: 'Second' });
  assert.equal(f.history.list({ tab: 'mine' }).items[0].localId, second.localId);
  f.setNow(Date.parse('2026-01-03T00:00:00Z'));
  f.conversations.rename(first.localId, 'Renamed first');
  assert.equal(f.history.list({ tab: 'mine' }).items[0].display_name, 'Renamed first');
  f.conversations.bind(first.localId, 'dash-owned');
  const id = f.add(first.localId);
  f.conversations.markCommitted(first.localId, { id });
  const items = pages(f.history, 'mine', 1);
  assert.equal(items.length, 2);
  const active = items.find(item => item.localId === first.localId);
  assert.equal(active.draft, false); assert.equal(active.count, 1);
  assert.equal(active.display_name, 'Renamed first');
  assert.equal(items.some(item => item.id === first.id), false);
});

test('an uncertain first send with a Core head is omitted as an empty draft even before reconciliation', t => {
  const f = fixture(t);
  const stale = [];
  for (let i = 0; i < 7; i++) {
    const draft = f.conversations.create({ displayName: `Unknown ${i}` });
    f.conversations.bind(draft.localId, 'dash-owned');
    f.conversations.markUnknown(draft.localId, 'preserved input');
    f.add(draft.localId); stale.push(draft.localId);
  }
  const blank = f.conversations.create({ displayName: 'Blank remaining' });
  const items = pages(f.history, 'mine', 1);
  assert.equal(items.length, 8);
  assert.deepEqual(items.filter(item => item.draft).map(item => item.localId), [blank.localId]);
  assert.equal(items.filter(item => stale.includes(item.localId)).length, 7);
  for (const localId of stale) assert.equal(f.conversations.get(localId).pendingContent, 'preserved input');
});

test('group names remain authoritative after activation and workbench renames do not change routing', t => {
  const f = fixture(t);
  const draft = f.conversations.create({ displayName: 'Draft title' });
  f.conversations.bind(draft.localId, 'dash-owned');
  const id = f.add(draft.localId);
  f.store.writeGroupDisplayName(`dash-owned:${draft.localId}`, 'Existing workbench title', 'human');
  f.conversations.markCommitted(draft.localId, { id });
  assert.equal(f.conversations.get(draft.localId).displayName, 'Existing workbench title');
  assert.equal(f.store.db.prepare('SELECT display_name FROM chat_conversations WHERE local_id=?').get(draft.localId).display_name, null);
  f.store.writeGroupDisplayName(`dash-owned:${draft.localId}`, 'Workbench rename', 'human');
  assert.equal(f.history.list({ tab: 'mine' }).items[0].display_name, 'Workbench rename');
  f.conversations.rename(draft.localId, 'Conversation rename');
  assert.equal(f.store.getGroupDisplayName(`dash-owned:${draft.localId}`).display_name, 'Conversation rename');
  assert.equal(f.db.prepare('SELECT endpoint_id,session_group FROM conversations WHERE id=?').get(id).endpoint_id, draft.localId);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM group_heads').get().n, 1);
});

test('a draft source read failure is an explicit history failure rather than an empty success', t => {
  const f = fixture(t); f.conversations.create();
  f.store.close();
  assert.throws(() => f.history.list({ tab: 'mine' }));
});
