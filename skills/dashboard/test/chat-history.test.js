import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { AuthGate } from '../src/lib/auth.js';
import { ChatHistory } from '../src/lib/chat/history.js';
import { handleChatHistory } from '../src/lib/chat/history-routes.js';
import { sendJson } from '../src/lib/http.js';
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';
import { chatStatusCases } from './fixtures/chat-status.js';
import { CONTENT_PREFIX } from '../../comm-bridge/scripts/c4-content-schema.js';

const groupId = value => `g:${Buffer.from(value).toString('hex').toUpperCase()}`;
const legacyId = (channel, endpoint) => `l:${Buffer.from(channel).toString('hex').toUpperCase()}:${Buffer.from(endpoint).toString('hex').toUpperCase()}`;
const bad = error => Number(error.statusCode ?? error.status) >= 400;

function fixture(t, withAuth = false) {
  assert.ok(process.env.ZYLOS_DIR && process.env.ZYLOS_DIR !== '/home/agent/zylos');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-history-'));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const db = new Database(path.join(root, 'comm-bridge/c4.db'));
  migrateSchema(db, { isNew: true });
  migrateToV2(db);
  db.prepare('INSERT INTO channel_namespaces VALUES (?,?)').run('dash-owned', 'dashboard');
  const store = withAuth ? new Store(path.join(root, 'dashboard.db')) : null;
  const reader = new C4Reader(root);
  const history = new ChatHistory({ c4Reader: reader });
  const insert = db.prepare(`INSERT INTO conversations
    (id,timestamp,direction,channel,endpoint_id,session_group,content,status,delivery_action)
    VALUES (@id,@timestamp,@direction,@channel,@endpoint_id,@session_group,@content,@status,@delivery_action)`);
  const add = row => insert.run({ timestamp: '2026-01-01 12:00:00', direction: 'in', channel: 'telegram',
    endpoint_id: 'shared', session_group: 'tg:a', content: `body-${row.id}`, status: 'delivered', delivery_action: null, ...row });
  t.after(() => { reader.close(); store?.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, store, reader, history, add };
}

function collect(history, tab, limit = 2, expectedCount) {
  const items = [];
  let cursor;
  for (let batch = 0; batch < 100; batch++) {
    const page = history.list({ tab, limit, cursor });
    assert.ok(page.items.length <= limit);
    items.push(...page.items);
    if (expectedCount !== undefined && items.length === expectedCount) {
      assert.ok(page.items.length > 0);
      assert.equal(page.nextCursor, null, 'Last nonempty page must not advertise another page');
    }
    if (!page.nextCursor) {
      if (expectedCount !== undefined) assert.equal(items.length, expectedCount);
      return items;
    }
    assert.notEqual(page.nextCursor, cursor);
    cursor = page.nextCursor;
  }
  assert.fail('Pagination did not terminate');
}

test('external lists use stable bounded pages and one allowed-row scope for metadata and content', t => {
  const f = fixture(t);
  for (let i = 0; i < 7; i++) f.add({ id: 10 + i * 10, session_group: `tg:${i}` });
  f.add({ id: 85, session_group: 'tg:0', content: 'visible latest', timestamp: '2026-01-02 00:00:00' });
  for (const [i, channel] of ['void', 'internal', 'system', 'scheduler', 'control', 'dashboard'].entries()) {
    f.add({ id: 100 + i, channel, session_group: 'tg:0', content: 'HIDDEN', timestamp: '2026-02-01 00:00:00' });
    f.add({ id: 120 + i, channel, session_group: `hidden:${i}` });
  }
  f.add({ id: 150, session_group: 'origin' });
  f.add({ id: 151, session_group: '*' });
  f.add({ id: 152, direction: 'other', session_group: 'tg:0', content: 'HIDDEN' });
  const queries = [];
  const query = f.history._query.bind(f.history);
  f.history._query = (sql, params) => {
    const rows = query(sql, params);
    queries.push({ sql, rows: rows.length });
    return rows;
  };
  const items = collect(f.history, 'external', 2, 7);
  assert.equal(f.history._db().pragma('query_only', { simple: true }), 1);
  assert.throws(() => f.history._db().exec("UPDATE conversations SET content='changed' WHERE id=10"), /readonly/);
  assert.equal(items.length, 7);
  assert.equal(new Set(items.map(item => item.id)).size, 7);
  assert.equal(items[0].session_group, 'tg:0');
  assert.equal(items[0].count, 2);
  assert.equal(items[0].preview, 'visible latest');
  assert.equal(items[0].previewDirection, 'in');
  assert.equal(items[0].stamp, f.db.prepare("SELECT julianday('2026-01-02 00:00:00') AS stamp").get().stamp);
  assert.deepEqual(items.slice(1).map(item => item.session_group), ['tg:1', 'tg:2', 'tg:3', 'tg:4', 'tg:5', 'tg:6']);
  assert.ok(queries.length > 1);
  for (const query of queries) { assert.match(query.sql, /\bLIMIT\b/i); assert.ok(query.rows <= 3); }
  const body = f.history.messages(items[0].id, { tab: 'external' });
  assert.deepEqual(body.items.map(row => row.id), [10, 85]);
  assert.ok(body.items.every(row => row.content !== 'HIDDEN'));
});

test('legacy history is separated by channel and endpoint without creating group membership', t => {
  const f = fixture(t);
  f.add({ id: 1, session_group: '', channel: 'telegram' });
  f.add({ id: 2, session_group: '', channel: 'lark' });
  f.add({ id: 3, session_group: '', channel: 'telegram', endpoint_id: 'other' });
  f.add({ id: 4, session_group: 'tg:established', channel: 'telegram', content: 'GROUPED_ONLY', timestamp: '2026-02-01' });
  const items = collect(f.history, 'external', 1, 4);
  assert.equal(items.length, 4);
  assert.equal(new Set(items.map(item => item.id)).size, 4);
  for (const item of items.filter(item => item.session_group === '')) {
    assert.ok(!item.session_group);
    assert.match(item.display_name, /旧历史/);
    const page = f.history.messages(item.id, { tab: 'external' });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].channel, item.channel);
    assert.equal(page.items[0].endpoint_id, item.endpoint_id);
    assert.equal(item.count, 1);
    assert.ok(!item.preview.includes('GROUPED_ONLY'));
    assert.ok(page.items.every(row => row.session_group === '' && row.content !== 'GROUPED_ONLY'));
  }
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations WHERE session_group='' ").get().n, 3);
});

test('list previews project structured content before applying the character budget', t => {
  const f = fixture(t);
  const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
  const envelope = structuredClone(fixtures.valid[0].envelope);
  envelope.fallbackText = 'Readable conversation summary';
  envelope.metadata = { private: 'HOST_FIELD_SENTINEL', padding: 'x'.repeat(1000) };
  const valid = CONTENT_PREFIX + JSON.stringify(envelope);
  f.add({ id: 1, session_group: 'tg:valid', content: valid });
  f.add({ id: 2, session_group: 'tg:invalid', content: valid.slice(0, -1) });
  f.add({ id: 3, session_group: 'tg:plain', content: 'ordinary text' });
  f.add({ id: 4, session_group: 'tg:long', content: 'a'.repeat(200) });
  const items = f.history.list({ tab: 'external' }).items;
  const preview = group => items.find(item => item.session_group === group).preview;
  assert.equal(preview('tg:valid'), envelope.fallbackText);
  assert.equal(preview('tg:invalid'), '无法显示的消息');
  assert.equal(preview('tg:plain'), 'ordinary text');
  assert.equal(preview('tg:long'), 'a'.repeat(160));
  for (const item of items) {
    assert.ok(!item.preview.includes('HOST_FIELD_SENTINEL'));
    assert.ok(!item.preview.includes('metadata'));
    assert.ok(!item.preview.includes(CONTENT_PREFIX));
  }
});

test('long legacy endpoints remain readable through list and message cursors', t => {
  const f = fixture(t);
  const endpoint = 'x'.repeat(2300) + '尾';
  f.add({ id: 1, session_group: '', endpoint_id: endpoint, content: 'long endpoint history', timestamp: '2026-02-01' });
  f.add({ id: 2, session_group: '', endpoint_id: endpoint, content: 'latest long endpoint', timestamp: '2026-02-02' });
  f.add({ id: 3, session_group: 'tg:other' });
  f.add({ id: 4, session_group: 'tg:established', endpoint_id: endpoint, content: 'GROUPED_ONLY' });
  const first = f.history.list({ tab: 'external', limit: 1 });
  const item = first.items[0];
  assert.ok(item.id.length > 4096);
  assert.equal(item.id, legacyId('telegram', endpoint));
  assert.equal(item.count, 2);
  assert.equal(item.preview, 'latest long endpoint');
  const rest = collect({ list: options => f.history.list({ ...options, cursor: options.cursor ?? first.nextCursor }) }, 'external', 1, 2);
  assert.equal(rest.some(row => row.id === item.id), false);
  const latest = f.history.messages(item.id, { tab: 'external', limit: 1 });
  assert.deepEqual(latest.items.map(row => row.id), [2]);
  const older = f.history.messages(item.id, { tab: 'external', cursor: latest.nextCursor });
  assert.deepEqual(older.items.map(row => row.id), [1]);
  const empty = f.history.messages(item.id, { tab: 'external', direction: 'after', cursor: latest.afterCursor });
  assert.deepEqual(empty.items, []);
  f.add({ id: 5, session_group: '', endpoint_id: endpoint });
  assert.deepEqual(f.history.messages(item.id, { tab: 'external', direction: 'after', cursor: empty.afterCursor }).items.map(row => row.id), [5]);
  assert.deepEqual(f.history.status(item.id, { tab: 'external', ids: [1, 2] }).items.map(row => row.id).sort(), [1, 2]);
  assert.throws(() => f.history.status(item.id, { tab: 'external', ids: [4] }), { statusCode: 404, code: 'chat_message_not_found' });
});

test('mine requires the Dashboard namespace binding and exact local endpoint routing', t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO channel_namespaces VALUES (?,?)').run('other-owned', 'another-component');
  f.add({ id: 1, channel: 'dashboard', endpoint_id: 'a', session_group: 'dash-owned:a' });
  f.add({ id: 2, channel: 'dashboard', endpoint_id: 'b', session_group: 'dash-owned:b' });
  f.add({ id: 3, channel: 'dashboard', endpoint_id: 'wrong', session_group: 'dash-owned:a', content: 'HIDDEN' });
  f.add({ id: 4, channel: 'telegram', endpoint_id: 'a', session_group: 'dash-owned:a', content: 'HIDDEN' });
  f.add({ id: 5, channel: 'dashboard', endpoint_id: 'foreign', session_group: 'wrong:foreign' });
  f.add({ id: 6, channel: 'dashboard', endpoint_id: 'foreign', session_group: 'other-owned:foreign' });
  const items = collect(f.history, 'mine', 1, 2);
  assert.equal(items.length, 2);
  assert.equal(items[0].endpoint_id, 'a'); assert.equal(items[0].draft, false); assert.equal(items[0].count, 1);
  assert.equal(items[1].endpoint_id, 'b'); assert.equal(items[1].draft, false); assert.equal(items[1].count, 1);
  assert.deepEqual(f.history.messages(items[0].id, { tab: 'mine' }).items.map(row => row.id), [1]);
  assert.equal(items[0].display_name, 'a');
  assert.throws(() => f.history.messages(groupId('other-owned:foreign'), { tab: 'mine' }), bad);
  f.db.prepare("DELETE FROM channel_namespaces WHERE component_name='dashboard'").run();
  assert.deepEqual(f.history.list({ tab: 'mine' }).items, []);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM channel_namespaces WHERE component_name='dashboard'").get().n, 0);
});

test('refresh rebuilds ordering after a conversation becomes active', t => {
  const f = fixture(t);
  f.add({ id: 1, session_group: 'tg:a' });
  f.add({ id: 3, session_group: 'tg:b', timestamp: '2026-01-02 00:00:00' });
  assert.equal(f.history.list({ tab: 'external', limit: 1 }).items[0].session_group, 'tg:b');
  f.add({ id: 9, session_group: 'tg:a', timestamp: '2026-01-03 00:00:00' });
  assert.equal(f.history.list({ tab: 'external', limit: 1 }).items[0].session_group, 'tg:a');
});

test('message pages use C4 ids across gaps and later polling never crosses groups', t => {
  const f = fixture(t);
  for (const id of [1, 5, 12, 20, 41]) f.add({ id });
  f.add({ id: 40, session_group: 'tg:b' });
  const item = f.history.list({ tab: 'external' }).items.find(item => item.session_group === 'tg:a');
  const latest = f.history.messages(item.id, { tab: 'external', limit: 2 });
  assert.deepEqual(latest.items.map(row => row.id), [20, 41]);
  const older = f.history.messages(item.id, { tab: 'external', limit: 2, cursor: latest.nextCursor });
  assert.deepEqual(older.items.map(row => row.id), [5, 12]);
  const first = f.history.messages(item.id, { tab: 'external', limit: 2, cursor: older.nextCursor });
  assert.deepEqual(first.items.map(row => row.id), [1]); assert.ok(!first.nextCursor);
  let after = latest.afterCursor;
  f.add({ id: 50 }); f.add({ id: 52 }); f.add({ id: 54 });
  const increment = f.history.messages(item.id, { tab: 'external', direction: 'after', limit: 2, cursor: after });
  assert.deepEqual(increment.items.map(row => row.id), [50, 52]);
  assert.ok(increment.nextCursor);
  const tail = f.history.messages(item.id, { tab: 'external', direction: 'after', limit: 2, cursor: increment.nextCursor });
  assert.deepEqual(tail.items.map(row => row.id), [54]); assert.ok(!tail.nextCursor);
  after = tail.afterCursor;
  const empty = f.history.messages(item.id, { tab: 'external', direction: 'after', cursor: after });
  assert.deepEqual(empty.items, []); assert.ok(!empty.nextCursor);
  const emptyAgain = f.history.messages(item.id, { tab: 'external', direction: 'after', cursor: empty.afterCursor });
  assert.deepEqual(emptyAgain.items, []); assert.equal(emptyAgain.nextCursor, null);
  f.add({ id: 60 });
  const newMessage = f.history.messages(item.id, { tab: 'external', direction: 'after', cursor: emptyAgain.afterCursor });
  assert.deepEqual(newMessage.items.map(row => row.id), [60]);
});

test('default and maximum batches stay bounded at the real SQL query wrapper', t => {
  const f = fixture(t);
  for (let id = 1; id <= 105; id++) f.add({ id, session_group: `tg:${String(id).padStart(3, '0')}` });
  assert.equal(f.history.list({ tab: 'external' }).items.length, 50);
  assert.equal(f.history.list({ tab: 'external', limit: 100 }).items.length, 100);
  f.db.prepare("UPDATE conversations SET session_group='tg:body'").run();
  const id = f.history.list({ tab: 'external' }).items[0].id;
  const queries = [];
  const query = f.history._query.bind(f.history);
  f.history._query = (sql, params) => {
    const rows = query(sql, params);
    queries.push({ sql, params, length: rows.length });
    return rows;
  };
  assert.equal(f.history.messages(id, { tab: 'external' }).items.length, 50);
  assert.equal(f.history.messages(id, { tab: 'external', limit: 100 }).items.length, 100);
  for (const entry of queries) {
    assert.match(entry.sql, /\bLIMIT\b/i);
    assert.ok(entry.length <= (entry.params.limit ?? 1));
    assert.ok(entry.length <= 101);
  }
});

test('list summaries page before preview queries and previews use indexed group or endpoint lookups', t => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 5; j++) {
    f.add({ id: 1 + i * 10 + j, session_group: `tg:${i}` });
    f.add({ id: 101 + i * 10 + j, session_group: '', endpoint_id: `legacy-${i}` });
  }
  const calls = [];
  const query = f.history._query.bind(f.history);
  f.history._query = (sql, params) => {
    const rows = query(sql, params);
    const plan = f.history._db().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params).map(row => row.detail);
    calls.push({ sql, rows: rows.length, plan });
    return rows;
  };
  let cursor;
  const previewIndexes = new Set();
  let total = 0;
  for (let batch = 0; batch < 3; batch++) {
    calls.length = 0;
    const page = f.history.list({ tab: 'external', limit: 3, cursor });
    total += page.items.length;
    assert.ok(calls.length >= 1);
    const [summary, ...previews] = calls;
    assert.match(summary.sql, /\bLIMIT\b/i);
    assert.ok(summary.rows <= 4);
    assert.equal(summary.plan.some(detail => /CORRELATED SCALAR SUBQUERY/.test(detail)), false, summary.plan.join('\n'));
    assert.equal(/SELECT\s+(?:\w+\.)?content\b/i.test(summary.sql), false);
    assert.equal(previews.length, page.items.length);
    assert.ok(previews.length <= 3);
    for (const preview of previews) {
      assert.match(preview.sql, /\bLIMIT\s+1\b/i);
      assert.ok(preview.rows <= 1);
      const index = preview.plan.join('\n').match(/SEARCH\b[^\n]*\bUSING INDEX (idx_conv_group_id|idx_conv_channel_endpoint)\b/);
      assert.ok(index, preview.plan.join('\n'));
      previewIndexes.add(index[1]);
    }
    cursor = page.nextCursor;
    if (total === 8) assert.equal(cursor, null);
    else assert.ok(cursor);
  }
  assert.equal(total, 8);
  assert.deepEqual([...previewIndexes].sort(), ['idx_conv_channel_endpoint', 'idx_conv_group_id']);
});

test('null and invalid timestamps page in a stable zero-time bucket', t => {
  const f = fixture(t);
  f.add({ id: 1, session_group: 'tg:valid' });
  f.add({ id: 2, session_group: 'tg:null', timestamp: null });
  f.add({ id: 3, session_group: 'tg:invalid', timestamp: 'not-a-date' });
  f.add({ id: 4, session_group: 'tg:empty', timestamp: '' });
  const items = collect(f.history, 'external', 1, 4);
  assert.equal(items[0].session_group, 'tg:valid');
  assert.deepEqual(items.slice(1).map(item => item.session_group), ['tg:empty', 'tg:invalid', 'tg:null']);
  assert.ok(items.slice(1).every(item => item.stamp === 0));
  assert.equal(new Set(items.map(item => item.id)).size, 4);
});

test('malformed parameters and cursors reject instead of falling back to whole history', t => {
  const f = fixture(t);
  f.add({ id: 1 }); f.add({ id: 3 }); f.add({ id: 5, session_group: 'tg:b' });
  const list = f.history.list({ tab: 'external', limit: 1 });
  const a = collect(f.history, 'external', 2, 2).find(item => item.session_group === 'tg:a');
  const b = collect(f.history, 'external', 2, 2).find(item => item.session_group === 'tg:b');
  const body = f.history.messages(a.id, { tab: 'external', limit: 1 });
  for (const limit of [0, -1, 101, 1.5, '', '01', '1e1', '2x', NaN, Infinity]) {
    assert.throws(() => f.history.list({ tab: 'external', limit }), bad);
    assert.throws(() => f.history.messages(a.id, { tab: 'external', limit }), bad);
  }
  for (const cursor of ['garbage', list.nextCursor.slice(0, -3) + 'xxx', body.nextCursor])
    assert.throws(() => f.history.list({ tab: 'external', cursor }), bad);
  assert.throws(() => f.history.list({ tab: 'mine', cursor: list.nextCursor }), bad);
  assert.throws(() => f.history.list({ tab: 'unknown' }), bad);
  for (const cursor of [list.nextCursor, 'garbage'])
    assert.throws(() => f.history.messages(a.id, { tab: 'external', cursor }), bad);
  assert.throws(() => f.history.messages(b.id, { tab: 'external', cursor: body.nextCursor }), bad);
  assert.throws(() => f.history.messages(a.id, { tab: 'mine', cursor: body.nextCursor }), bad);
  assert.throws(() => f.history.messages(a.id, { tab: 'external', direction: 'after', cursor: body.nextCursor }), bad);
  assert.throws(() => f.history.messages(a.id, { tab: 'external', direction: 'after' }), bad);
  for (const id of ['garbage', groupId('origin'), legacyId('telegram', 'missing')])
    assert.throws(() => f.history.messages(id, { tab: 'external' }), bad);
});

test('authoritative status branches preserve raw facts and reject ids from another conversation', t => {
  const f = fixture(t);
  chatStatusCases.forEach((row, index) => f.add({ id: index + 1, status: row.status, delivery_action: row.delivery_action }));
  f.add({ id: 30, direction: 'out', status: 'delivered' });
  f.add({ id: 40, session_group: 'tg:b' });
  const a = f.history.list({ tab: 'external' }).items.find(item => item.session_group === 'tg:a');
  const result = f.history.status(a.id, { tab: 'external', ids: chatStatusCases.map((_, i) => i + 1) });
  assert.equal(result.items.length, chatStatusCases.length);
  for (let i = 0; i < chatStatusCases.length; i++) {
    const item = result.items.find(row => row.id === i + 1);
    assert.ok(item);
    assert.equal(item.status, chatStatusCases[i].status);
    assert.equal(item.delivery_action, chatStatusCases[i].delivery_action);
    assert.equal(item.deliveryState, chatStatusCases[i].expected);
  }
  const outbound = f.history.status(a.id, { tab: 'external', ids: [30] }).items[0];
  assert.notEqual(outbound.deliveryState, 'delivered');
  for (const ids of [[40], [999], [1, 40], [0], [-1], [1.5], [], [1, 1]])
    assert.throws(() => f.history.status(a.id, { tab: 'external', ids }), bad);
});

test('status batches accept one hundred real ids and reject one hundred one before querying them', t => {
  const f = fixture(t);
  const ids = Array.from({ length: 101 }, (_, i) => i + 1);
  ids.forEach(id => f.add({ id }));
  const id = f.history.list({ tab: 'external' }).items[0].id;
  const accepted = f.history.status(id, { tab: 'external', ids: ids.slice(0, 100) });
  assert.equal(accepted.items.length, 100);
  assert.deepEqual(accepted.items.map(row => row.id).sort((a, b) => a - b), ids.slice(0, 100));
  assert.throws(() => f.history.status(id, { tab: 'external', ids }), { statusCode: 400, code: 'invalid_chat_message_ids' });
});

test('unavailable and corrupt databases fail explicitly and existing metadata reads remain content-free', t => {
  const f = fixture(t);
  f.add({ id: 1, content: 'PRIVATE' });
  const a = f.history.list({ tab: 'external' }).items[0];
  const metadata = f.reader.getGroupMessages('tg:a', { since: '2026-01-01', until: '2026-01-02' });
  assert.equal(metadata.length, 1); assert.equal(Object.hasOwn(metadata[0], 'content'), false);
  assert.deepEqual(Object.keys(metadata[0]).sort(), ['channel', 'direction', 'id', 'timestamp']);
  const missing = new C4Reader(path.join(f.root, 'missing'));
  t.after(() => missing.close());
  assert.throws(() => new ChatHistory({ c4Reader: missing }).list({ tab: 'external' }), bad);
  f.db.exec('ALTER TABLE conversations RENAME TO unavailable_conversations');
  assert.throws(() => f.history.list({ tab: 'external' }), bad);
  assert.throws(() => f.history.messages(a.id, { tab: 'external' }), bad);
  assert.throws(() => f.history.status(a.id, { tab: 'external', ids: [1] }), bad);
});

// Integration: real auth, history routes, SQLite and private loopback only.
// Run for history scope/routes/auth changes; skip for styles or text changes.
// Uses runner-isolated HOME/ZYLOS_DIR/PM2_HOME/TMPDIR, no process or tmux launch.
test('HTTP history routes enforce access before reading and reject ambiguous query parameters', async t => {
  const f = fixture(t, true);
  f.add({ id: 1, content: 'PRIVATE_HISTORY' }); f.add({ id: 3 });
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const cookie = 'history-browser-session';
  f.store.insertSession(hash(cookie), Date.now());
  const tokens = { read: `zylos_st_${'a'.repeat(64)}`, admin: `zylos_st_${'b'.repeat(64)}` };
  for (const scope of ['read', 'admin']) {
    const key = f.store.insertApiKey({ name: scope, keyHash: 'unused', scope });
    f.store.insertApiSession({ tokenHash: hash(tokens[scope]), apiKeyId: key.lastInsertRowid, scope,
      createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
  }
  const config = { auth: { enabled: true, password: 'scrypt:test' }, chat: { allowRemote: false } };
  const auth = new AuthGate(config, f.store);
  let reads = 0;
  const query = f.history._query.bind(f.history);
  f.history._query = (...args) => { reads++; return query(...args); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (await auth.handle(req, res, url)) return;
    if (await handleChatHistory(req, res, url, { auth, config, history: f.history })) return;
    sendJson(res, 404, { error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { clearInterval(auth._cleanupTimer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = async (route, identity = 'cookie', locale) => {
    const headers = identity === 'cookie' ? { cookie: `__Secure-zylos_dashboard_session=${cookie}` } :
      tokens[identity] ? { authorization: `Bearer ${tokens[identity]}` } : {};
    if (locale !== undefined) headers['X-Zylos-Locale'] = locale;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { headers });
    return { status: response.status, body: await response.json() };
  };
  const id = f.history.list({ tab: 'external' }).items[0].id;
  const routes = ['/api/chat/conversations?tab=external', `/api/chat/conversations/${id}/messages?tab=external`,
    `/api/chat/conversations/${id}/status?tab=external&ids=1`];
  for (const allow of [false, true]) {
    config.chat.allowRemote = allow;
    for (const route of routes) for (const identity of ['none', 'read', 'admin', 'cookie']) {
      const before = reads;
      const response = await request(route, identity);
      const permitted = identity === 'cookie' || identity === 'admin' && allow;
      assert.equal(response.status, permitted ? 200 : identity === 'none' ? 401 : 403);
      if (!permitted) { assert.equal(reads, before); assert.ok(!JSON.stringify(response.body).includes('PRIVATE_HISTORY')); }
      else assert.ok(reads > before);
    }
  }
  f.db.prepare('UPDATE conversations SET content=? WHERE id=3').run('**Result**\n\n```js\nsecret()\n```');
  for (const locale of ['zh', 'en']) {
    const expected = 'Result\n' + (locale === 'en' ? '[Code]' : '[代码]');
    assert.equal((await request('/api/chat/conversations?tab=external', 'cookie', locale)).body.items[0].preview, expected);
    const messages = await request(`/api/chat/conversations/${id}/messages?tab=external`, 'cookie', locale);
    assert.equal(messages.body.items.find(row => row.id === 3).preview, expected);
  }
  assert.equal((await request('/api/chat/conversations?tab=external', 'cookie', 'fr')).body.items[0].preview, 'Result\n[代码]');
  for (const suffix of ['locale=fr', 'locale=en&locale=zh', 'tab=external&tab=mine', 'tab=external&extra=1', 'limit=', 'limit=0', 'limit=101', 'cursor=garbage'])
    assert.equal((await request(`/api/chat/conversations?${suffix}`)).status, 400);
  for (const suffix of ['tab=external&ids=1&ids=3', 'tab=external&ids=1,1', 'tab=external&ids=1x', 'tab=external&ids=', 'tab=external&ids=999'])
    assert.ok((await request(`/api/chat/conversations/${id}/status?${suffix}`)).status >= 400);
  assert.equal((await request('/api/chat/conversations/%E0%A4%A/messages?tab=external')).status, 400);
  config.auth.enabled = false;
  const before = reads;
  assert.equal((await request(routes[0])).status, 403); assert.equal(reads, before);
});
