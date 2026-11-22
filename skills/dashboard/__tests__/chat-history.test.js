import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../src/lib/store.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { AuthGate } from '../src/lib/auth.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { ChatHistory } from '../src/lib/chat/history.js';
import { handleChatHistory } from '../src/lib/chat/history-routes.js';
import { sendJson } from '../src/lib/http.js';
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';
import { chatStatusCases } from './fixtures/chat-status.js';
import { scheduleEnv } from './fixtures/schedule-env.js';
import { createScheduleTz } from '../src/lib/workbench/schedule-tz.js';
import { CONTENT_PREFIX } from '../../comm-bridge/scripts/c4-content-schema.js';
import { conversationPreview } from '../src/lib/chat/history.js';
import { buildAnnotatedContent } from '../../comm-bridge/scripts/attachment-annotations.js';

const groupId = value => `g:${Buffer.from(value).toString('hex').toUpperCase()}`;
const legacyId = (channel, endpoint) => `l:${Buffer.from(channel).toString('hex').toUpperCase()}:${Buffer.from(endpoint).toString('hex').toUpperCase()}`;
const bad = error => Number(error.statusCode ?? error.status) >= 400;

function fixture(t, withAuth = false) {
  assert.ok(process.env.ZYLOS_DIR && process.env.ZYLOS_DIR !== '/home/agent/zylos');
  const temporary = fs.realpathSync(os.tmpdir());
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME']) {
    const directory = process.env[key];
    assert.ok(directory && path.isAbsolute(directory), `${key} must be explicit`);
    const canonical = fs.existsSync(directory) ? fs.realpathSync(directory)
      : path.join(fs.realpathSync(path.dirname(directory)), path.basename(directory));
    assert.ok(canonical.startsWith(path.dirname(temporary) + path.sep),
      `${key} must belong to the official runner's private root`);
  }
  const root = fs.mkdtempSync(path.join(temporary, 'chat-history-'));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const filename = path.join(root, 'comm-bridge/c4.db');
  assert.equal(fs.realpathSync(path.dirname(filename)), path.dirname(filename));
  assert.ok(filename.startsWith(temporary + path.sep), 'C4 fixture DB must stay inside private TMPDIR');
  console.log('History case isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: temporary, database: filename, tmux: 'not launched' }));
  const db = new Database(filename);
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

// "Mine" pins the Origin conversation first on its first page; the collected
// items are the ordinary conversations after it.
const ORIGIN_ID = 'g:6F726967696E';
function collect(history, tab, limit = 2, expectedCount) {
  const items = [];
  let cursor;
  for (let batch = 0; batch < 100; batch++) {
    const page = history.list({ tab, limit, cursor });
    assert.ok(page.items.filter(row => !row.origin && !Number.isInteger(row.pinOrder)).length <= limit);
    if (tab === 'mine' && batch === 0) assert.equal(page.items[0]?.id, ORIGIN_ID);
    items.push(...(tab === 'mine' && batch === 0 ? page.items.slice(1) : page.items));
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

// Boundary: actual history queries against a private C4 database. Run for quote
// metadata/range/preview changes; no runtime, tmux, PM2 or network is launched.
test('history quote metadata batches visible references and preserves raw message content', t => {
  const f = fixture(t), group = 'dash-owned:a';
  const add = row => f.add({ channel: 'dashboard', endpoint_id: 'a', session_group: group, ...row });
  add({ id: 1, direction: 'out', content: '**Readable** ' + '😀'.repeat(180) });
  add({ id: 2, channel: 'internal', endpoint_id: 'peer', content: '[internal] peer said: peer body' });
  add({ id: 3, content: '[quote c4_id=1]\nfirst reply' });
  add({ id: 4, content: '[quote c4_id=2]\nsecond reply' });
  add({ id: 5, content: '[quote c4_id=1]\nrepeated target' });
  const lookups = [];
  const original = f.history._rowsByIds.bind(f.history);
  f.history._rowsByIds = (...args) => { lookups.push(args[1]); return original(...args); };
  const rows = f.history.messages(groupId(group)).items;
  assert.equal(lookups.length, 1, 'one bounded reference query per page');
  assert.deepEqual(lookups[0], [1, 2]);
  const first = rows.find(row => row.id === 3);
  assert.equal(first.content, '[quote c4_id=1]\nfirst reply');
  assert.deepEqual(first.quote, { id: 1, direction: 'out', timestamp: '2026-01-01 12:00:00',
    internal: false, preview: 'Readable ' + '😀'.repeat(151), available: true });
  assert.equal(Array.from(first.quote.preview).length, 160);
  assert.equal(rows.find(row => row.id === 4).quote.preview, 'peer body');
  assert.equal(rows.find(row => row.id === 4).quote.internal, true);
  assert.equal(Object.hasOwn(rows[0], 'quote'), false);
});

test('history quote references outside the visible range remain unavailable without breaking the page', t => {
  const f = fixture(t), group = 'dash-owned:a';
  const add = row => f.add({ channel: 'dashboard', endpoint_id: 'a', session_group: group, ...row });
  add({ id: 1, session_group: 'dash-owned:b', endpoint_id: 'b', content: 'foreign secret' });
  add({ id: 2, endpoint_id: 'wrong', content: 'wrong endpoint secret' });
  add({ id: 3, channel: 'system', content: 'hidden secret' });
  add({ id: 4, content: '[quote c4_id=1]\nforeign' });
  add({ id: 5, content: '[quote c4_id=2]\nwrong endpoint' });
  add({ id: 6, content: '[quote c4_id=3]\nhidden' });
  add({ id: 1000, content: '[quote c4_id=999]\ndeleted' });
  const rows = f.history.messages(groupId(group)).items;
  assert.equal(rows.length, 4);
  for (const row of rows) assert.deepEqual(row.quote, { id: row.id === 1000 ? 999 : row.id - 3,
    direction: null, internal: false, timestamp: null, preview: '', available: false });
  assert.throws(() => f.history.status(groupId(group), { ids: [999] }), { code: 'chat_message_not_found' });
});

// Real history projections in a private database. Run when nested quote
// previews or internal metadata change; unrelated frontend work may skip.
test('history nested quote previews show the target body and internal metadata follows the target channel', t => {
  const f = fixture(t), group = 'dash-owned:a';
  const add = row => f.add({ channel: 'dashboard', endpoint_id: 'a', session_group: group, ...row });
  add({ id: 1, direction: 'out', content: 'Original answer' });
  add({ id: 2, content: '[quote c4_id=1]\n**Intermediate reply**' });
  add({ id: 3, content: '[quote c4_id=2]\nLatest reply' });
  add({ id: 4, channel: 'internal', direction: 'in', endpoint_id: 'peer',
    content: '[internal] peer said: Incoming' });
  add({ id: 5, channel: 'internal', direction: 'out', endpoint_id: 'peer', content: 'Outgoing' });
  add({ id: 6, content: '[quote c4_id=4]\nQuote inbound' });
  add({ id: 7, content: '[quote c4_id=5]\nQuote outbound' });
  add({ id: 8, direction: 'out', content: '[quote c4_id=1]\nAI quoting earlier answer' });
  add({ id: 9, content: '[quote c4_id=8]\nQuote AI marker' });
  add({ id: 10, channel: 'internal', endpoint_id: 'peer',
    content: '[internal] peer said: [quote c4_id=1]\nInternal quoting earlier answer' });
  add({ id: 11, content: '[quote c4_id=10]\nQuote internal marker' });
  const rows = f.history.messages(groupId(group)).items;
  const nested = rows.find(row => row.id === 3);
  assert.equal(nested.quote.preview, 'Intermediate reply');
  assert.equal(nested.content, '[quote c4_id=2]\nLatest reply');
  assert.equal(rows.find(row => row.id === 2).content, '[quote c4_id=1]\n**Intermediate reply**');
  assert.equal(rows.find(row => row.id === 9).quote.preview, 'AI quoting earlier answer');
  assert.equal(rows.find(row => row.id === 11).quote.preview, 'Internal quoting earlier answer');
  assert.equal(nested.quote.internal, false);
  assert.equal(rows.find(row => row.id === 8).preview, '[quote c4_id=1]\nAI quoting earlier answer');
  assert.equal(Object.hasOwn(rows.find(row => row.id === 8), 'quote'), false);
  assert.equal(rows.find(row => row.id === 10).internal.content,
    '[quote c4_id=1]\nInternal quoting earlier answer');
  for (const [id, target, direction, preview] of [[6, 4, 'in', 'Incoming'], [7, 5, 'out', 'Outgoing']]) {
    assert.deepEqual(rows.find(row => row.id === id).quote, { id: target, direction, internal: true,
      timestamp: '2026-01-01 12:00:00', preview, available: true });
  }
});

test('list and quote previews skip only a valid first-line marker and retain readable attachments', t => {
  const f = fixture(t);
  f.add({ id: 100, channel: 'dashboard', endpoint_id: 'a', session_group: 'dash-owned:a',
    content: '[quote c4_id=99]\n**User words**' });
  assert.equal(f.history.list().items.find(item => !item.origin).preview, 'User words');
  assert.equal(conversationPreview('[quote c4_id=1]\n[quote c4_id=2]\nbody'), '[quote c4_id=1]\n[quote c4_id=2]\nbody');
  assert.equal(conversationPreview('intro\n[quote c4_id=1]\nbody'), 'intro\n[quote c4_id=1]\nbody');
  assert.equal(conversationPreview('[quote c4_id=0]\nbody'), '[quote c4_id=0]\nbody');
  const withFile = buildAnnotatedContent('body',
    [{ kind: 'file', name: 'report.txt', path: '/private/report.txt', size: 100 }]);
  const preview = conversationPreview(withFile);
  assert.match(preview, /report\.txt/);
  assert.doesNotMatch(preview, /quote c4_id|\/private\//);
});

// Real history/list projections and private SQLite. Run for quote eligibility
// changes; UI styling may skip. No runtime, socket or child is started.
test('history treats markers as literal except on earlier Dashboard inbound references', t => {
  const f = fixture(t), group = 'dash-owned:a';
  const marker = '[quote c4_id=1]\nliteral body';
  f.add({ id: 1, channel: 'dashboard', endpoint_id: 'a', session_group: group, content: 'original' });
  for (const row of [
    { id: 2, direction: 'out', channel: 'dashboard', endpoint_id: 'a', session_group: group },
    { id: 3, channel: 'internal', endpoint_id: 'peer', session_group: group },
    { id: 4, channel: 'telegram', endpoint_id: 'external', session_group: 'tg:a' },
    { id: 5, channel: 'internal', endpoint_id: 'peer', session_group: 'tg:a' },
    { id: 6, channel: 'dashboard', endpoint_id: 'b', session_group: 'dash-owned:b', content: '[quote c4_id=6]\nself' },
    { id: 7, channel: 'dashboard', endpoint_id: 'c', session_group: 'dash-owned:c', content: '[quote c4_id=8]\nfuture' },
  ]) f.add({ content: marker, ...row });
  let referenceReads = 0;
  const lookup = f.history._rowsByIds.bind(f.history);
  f.history._rowsByIds = (...args) => { referenceReads++; return lookup(...args); };
  for (const [tab, sessionGroup] of [['mine', group], ['mine', 'dash-owned:b'],
    ['mine', 'dash-owned:c'], ['external', 'tg:a']]) {
    const items = f.history.messages(groupId(sessionGroup), { tab }).items;
    for (const row of items) {
      assert.equal(Object.hasOwn(row, 'quote'), false);
      if (row.id !== 1) assert.ok((row.internal?.content ?? row.preview).startsWith('[quote c4_id='));
    }
    assert.ok(f.history.list({ tab }).items.find(row => row.session_group === sessionGroup).preview.startsWith('[quote c4_id='));
  }
  assert.equal(referenceReads, 0);
  f.add({ id: 8, channel: 'dashboard', endpoint_id: 'a', session_group: group, content: marker });
  const reply = f.history.messages(groupId(group)).items.find(row => row.id === 8);
  assert.equal(reply.preview, 'literal body');
  assert.equal(reply.quote.id, 1);
  assert.equal(reply.quote.available, true);
  assert.equal(referenceReads, 1);
});

test('external list membership excludes relay-only groups and relays affect receive time only', t => {
  const f = fixture(t);
  for (let i = 0; i < 7; i++) f.add({ id: 10 + i * 10, session_group: `tg:${i}` });
  f.add({ id: 85, session_group: 'tg:0', content: 'visible latest', timestamp: '2026-01-02 00:00:00' });
  for (const [i, channel] of ['void', 'internal', 'system', 'scheduler', 'control', 'dashboard'].entries()) {
    f.add({ id: 100 + i, channel, session_group: 'tg:0', content: channel, timestamp: '2026-02-01 00:00:00' });
    f.add({ id: 120 + i, channel, session_group: `hidden:${i}` });
  }
  f.add({ id: 150, session_group: 'origin' });
  f.add({ id: 151, session_group: '*' });
  f.add({ id: 152, direction: 'other', session_group: 'tg:0', content: 'HIDDEN' });
  const items = collect(f.history, 'external', 2, 7);
  assert.equal(f.history._db().pragma('query_only', { simple: true }), 1);
  assert.throws(() => f.history._db().exec("UPDATE conversations SET content='changed' WHERE id=10"), /readonly/);
  assert.deepEqual(items.map(item => item.session_group), ['tg:0', 'tg:1', 'tg:2', 'tg:3', 'tg:4', 'tg:5', 'tg:6']);
  assert.equal(items[0].preview, 'visible latest');
  assert.equal(items[0].previewDirection, 'in');
  assert.equal(items[0].stamp, f.db.prepare("SELECT julianday('2026-02-01 00:00:00') AS stamp").get().stamp);
  const body = f.history.messages(items[0].id, { tab: 'external' });
  assert.deepEqual(body.items.map(row => row.id), [10, 85, 101]);
  assert.equal(body.items.at(-1).internal.content, 'internal');
  assert.equal(body.items.at(-1).internal.peerExists, false);
});

test('the external list leaves legacy history out while its separate channel and endpoint timelines remain readable', t => {
  const f = fixture(t);
  f.add({ id: 1, session_group: '', channel: 'telegram' });
  f.add({ id: 2, session_group: '', channel: 'lark' });
  f.add({ id: 3, session_group: '', channel: 'telegram', endpoint_id: 'other' });
  f.add({ id: 4, session_group: 'tg:established', channel: 'telegram', content: 'GROUPED_ONLY', timestamp: '2026-02-01' });
  const items = collect(f.history, 'external', 1, 1);
  assert.equal(items[0].session_group, 'tg:established');
  for (const [channel, endpoint, id] of [['telegram', 'shared', 1], ['lark', 'shared', 2], ['telegram', 'other', 3]]) {
    assert.deepEqual(f.history.messages(legacyId(channel, endpoint), { tab: 'external' }).items.map(row => row.id), [id]);
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

test('long legacy endpoints remain readable through message cursors', t => {
  const f = fixture(t);
  const endpoint = 'x'.repeat(2300) + '尾';
  f.add({ id: 1, session_group: '', endpoint_id: endpoint, content: 'long endpoint history', timestamp: '2026-02-01' });
  f.add({ id: 2, session_group: '', endpoint_id: endpoint, content: 'latest long endpoint', timestamp: '2026-02-02' });
  f.add({ id: 3, session_group: 'tg:other' });
  f.add({ id: 4, session_group: 'tg:established', endpoint_id: endpoint, content: 'GROUPED_ONLY' });
  const item = { id: legacyId('telegram', endpoint) };
  assert.ok(item.id.length > 4096);
  assert.deepEqual(collect(f.history, 'external', 1, 2).map(row => row.session_group), ['tg:established', 'tg:other']);
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
  f.add({ id: 4, channel: 'telegram', endpoint_id: 'a', session_group: 'dash-owned:a', direction: 'out', content: 'HIDDEN' });
  f.add({ id: 5, channel: 'dashboard', endpoint_id: 'foreign', session_group: 'wrong:foreign' });
  f.add({ id: 6, channel: 'dashboard', endpoint_id: 'foreign', session_group: 'other-owned:foreign' });
  const items = collect(f.history, 'mine', 1, 2);
  assert.equal(items.length, 2);
  assert.equal(items[0].endpoint_id, 'a'); assert.equal(items[0].draft, false);
  assert.equal(items[1].endpoint_id, 'b'); assert.equal(items[1].draft, false);
  assert.deepEqual(f.history.messages(items[0].id, { tab: 'mine' }).items.map(row => row.id), [1]);
  assert.equal(items[0].display_name, 'a');
  assert.equal(f.history.list({ tab: 'external' }).items.length, 0, 'External excludes Dashboard-owned groups even with a non-Dashboard row');
  assert.throws(() => f.history.messages(groupId('other-owned:foreign'), { tab: 'mine' }), bad);
  f.db.prepare("DELETE FROM channel_namespaces WHERE component_name='dashboard'").run();
  assert.deepEqual(f.history.list({ tab: 'mine' }).items.map(item => item.id), [ORIGIN_ID]);
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

// Real indexed C4 list and preview reads in the private fixture. Run when
// conversation activity, membership or previews change. No live runtime/HTTP.
test('received activity moves a row and outbound messages only change its preview', t => {
  const f = fixture(t);
  const own = (id, group, date, more = {}) => f.add({ id, channel: 'dashboard', endpoint_id: group,
    session_group: `dash-owned:${group}`, timestamp: `2026-01-${date}`, ...more });
  own(1, 'a', '01');
  own(2, 'b', '02');
  own(3, 'a', '03', { direction: 'out', content: 'Agent reply' });
  own(4, 'out-only', '01', { direction: 'out', content: 'First message' });
  own(5, 'out-only', '04', { direction: 'out', content: 'Latest preview' });
  f.add({ id: 6, channel: 'dashboard', endpoint_id: 'origin', session_group: 'origin',
    direction: 'out', timestamp: '2026-01-05', content: 'Origin preview' });
  const names = () => f.history.list().items.map(row => row.endpoint_id);
  const byName = name => f.history.list().items.find(row => row.endpoint_id === name);
  const julian = date => f.db.prepare('SELECT julianday(?)').pluck().get(`2026-01-${date}`);
  assert.deepEqual(names(), ['origin', 'b', 'a', 'out-only']);
  assert.deepEqual([byName('a').stamp, byName('a').preview, byName('a').previewDirection], [julian('01'), 'Agent reply', 'out']);
  assert.deepEqual([byName('out-only').stamp, byName('out-only').preview], [julian('01'), 'Latest preview']);
  assert.equal(byName('origin').stamp, julian('05'));

  own(7, 'a', '07', { channel: 'internal', endpoint_id: 'telegram:peer', content: '[internal] telegram:peer said: Relayed' });
  f.add({ id: 8, channel: 'system', session_group: 'origin', timestamp: '2026-01-08', content: 'Task is not a timeline preview' });
  assert.deepEqual(names(), ['origin', 'a', 'b', 'out-only']);
  assert.deepEqual([byName('a').stamp, byName('a').preview, byName('a').previewDirection], [julian('07'), 'Agent reply', 'out']);
  assert.deepEqual([byName('origin').stamp, byName('origin').preview], [julian('08'), 'Origin preview']);
});

// Real Dashboard name/pin data and private C4. Run for list search, pin or
// keyset scope changes. The same isolated fixture owns both databases.
test('name and group searches use chronological pages and retain pin markers', t => {
  const f = fixture(t, true);
  f.history.conversations = new ChatConversations({ store: f.store });
  f.add({ id: 1, session_group: 'tg:needle-group', timestamp: '2026-01-01', content: 'match only message content' });
  f.add({ id: 2, session_group: 'tg:middle', timestamp: '2026-01-02', content: 'unrelated message' });
  f.add({ id: 3, session_group: 'tg:newer', timestamp: '2026-01-03' });
  f.store.writeGroupDisplayName('tg:middle', 'Needle display', 'human');
  f.store.writeGroupDisplayName('tg:newer', 'Needle name', 'human');
  f.history.replacePins([groupId('tg:middle')], 'external');
  const initial = f.history.list({ tab: 'external', limit: 1 });
  assert.deepEqual(initial.items.map(row => row.session_group), ['tg:middle', 'tg:newer']);
  assert.equal(initial.items[0].pinOrder, 0);
  assert.deepEqual(f.history.pinIds('mine'), []);

  const options = { tab: 'external', limit: 1, q: '  NEEDLE  ' };
  const top = f.history.list(options);
  const middle = f.history.list({ ...options, cursor: top.nextCursor });
  const tail = f.history.list({ ...options, cursor: middle.nextCursor });
  assert.deepEqual([top.items[0].session_group, middle.items[0].session_group, tail.items[0].session_group],
    ['tg:newer', 'tg:middle', 'tg:needle-group']);
  assert.equal(middle.items[0].pinOrder, 0);
  assert.equal(tail.nextCursor, null);
  assert.deepEqual(f.history.list({ tab: 'external', q: 'match only message' }).items, []);
  assert.throws(() => f.history.list({ ...options, q: 'changed', cursor: top.nextCursor }), { code: 'invalid_cursor' });
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

test('conversation lists seek by group and load previews only for the page', t => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 5; j++) {
    f.add({ id: 1 + i * 10 + j, session_group: `tg:${i}` });
    f.add({ id: 101 + i * 10 + j, session_group: '', endpoint_id: `legacy-${i}` });
  }
  const db = f.history._db();
  const prepare = db.prepare.bind(db);
  const calls = [];
  db.prepare = sql => {
    const stmt = prepare(sql);
    if (!sql.includes('FROM conversations c')) return stmt;
    const get = stmt.get.bind(stmt);
    stmt.get = (...params) => {
      const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail);
      calls.push({ sql, plan });
      return get(...params);
    };
    return stmt;
  };
  const page = f.history.list({ tab: 'external', limit: 3 });
  assert.equal(page.items.length, 3);
  assert.ok(page.nextCursor);
  assert.equal(calls.filter(({ sql }) => /SELECT.+\.content/.test(sql)).length, 3);
  assert.ok(calls.length < 20);
  for (const { sql, plan } of calls) {
    assert.match(sql, /LIMIT 1/);
    assert.match(plan.join('\n'), /SEARCH c USING (?:COVERING )?INDEX idx_conv_group_id/);
    assert.doesNotMatch(sql, /GROUP BY|COUNT\(\*\)/i);
  }
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
  assert.deepEqual(f.history.messages(a.id, { tab: 'external', direction: 'after', cursor: body.nextCursor }).items.map(row => row.id), []);
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
  const metadata = f.reader.getGroupMessagePage('tg:a', new URLSearchParams()).items;
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
  const open = f.history._db.bind(f.history);
  f.history._db = (...args) => { reads++; return open(...args); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.apiPath = url.pathname;
    if (await auth.handle(req, res, url)) return;
    if (await handleChatHistory(req, res, url, { auth, config, history: f.history })) return;
    sendJson(res, 404, { error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { clearInterval(auth._cleanupTimer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const observations = [];
  const request = async (route, identity = 'cookie', locale) => {
    const headers = identity === 'cookie' ? { cookie: `__Secure-zylos_dashboard_session=${cookie}` } :
      tokens[identity] ? { authorization: `Bearer ${tokens[identity]}` } : {};
    if (locale !== undefined) headers['X-Zylos-Locale'] = locale;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { headers });
    const result = { status: response.status, body: await response.json() };
    observations.push({ method: 'GET', route, identity, ...result, fixtureBoundary: 'Real AuthGate, ChatHistory, C4Reader and isolated SQLite databases; message/group fixtures.' });
    return result;
  };
  const id = f.history.list({ tab: 'external' }).items[0].id;
  const routes = ['/api/conversations?tab=external', `/api/conversations/${id}/messages?tab=external`,
    `/api/conversations/${id}/status?tab=external&ids=1`];
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
    assert.equal((await request('/api/conversations?tab=external', 'cookie', locale)).body.items[0].preview, expected);
    const messages = await request(`/api/conversations/${id}/messages?tab=external`, 'cookie', locale);
    assert.equal(messages.body.items.find(row => row.id === 3).preview, expected);
  }
  assert.equal((await request('/api/conversations?tab=external', 'cookie', 'fr')).body.items[0].preview, 'Result\n[代码]');
  for (const [param, query] of [
    ['offset', 'offset=1'], ['anchor', 'anchor=x'], ['tab', 'tab=unknown'], ['limit', 'limit=101'],
    ['tab', 'tab=external&tab=mine'], ['locale', 'locale=fr'], ['q', `q=${'x'.repeat(65)}`],
  ]) {
    const response = await request(`/api/conversations?${query}`);
    assert.equal(response.status, 400);
    assert.deepEqual([response.body.error.code, response.body.error.param], ['invalid_parameter', param]);
  }
  const staleCursor = await request('/api/conversations?cursor=garbage');
  assert.equal(staleCursor.status, 400);
  assert.equal(staleCursor.body.error.code, 'invalid_cursor');
  assert.equal((await request('/api/chat/conversations')).status, 404);
  for (const suffix of ['tab=external&ids=1&ids=3', 'tab=external&ids=1,1', 'tab=external&ids=1x', 'tab=external&ids=', 'tab=external&ids=999'])
    assert.ok((await request(`/api/conversations/${id}/status?${suffix}`)).status >= 400);
  assert.equal((await request('/api/conversations/%E0%A4%A/messages?tab=external')).status, 400);
  if (process.env.DASHBOARD_CHAT_HISTORY_EVIDENCE) {
    fs.mkdirSync(path.dirname(process.env.DASHBOARD_CHAT_HISTORY_EVIDENCE), { recursive: true });
    fs.writeFileSync(process.env.DASHBOARD_CHAT_HISTORY_EVIDENCE, JSON.stringify(observations, null, 2));
  }
});

// The conversation list and message routes report the instance time zone through the schedule page's reader (the real
// scheduler tz.js on a temporary installation's .env); message times and daily charts are shown in it. The status
// route does not carry it.
// Integration. Isolation: HOME, PM2_HOME and TMPDIR are isolated by the test runner; this test uses a private c4.db
// from fixture(), a temporary installation from scheduleEnv whose .env is the only one read, and points the process's
// ZYLOS_DIR there for this test only (restored in teardown); both roots are removed in teardown. Run when the chat
// history routes, the schedule time zone reader or scheduler tz.js changes; changes limited to page drawing may skip it.
const TZ_URL = new URL('../../scheduler/scripts/tz.js', import.meta.url).href;
let tzImport = 0;
test('conversation lists and message pages carry the instance time zone from .env, and null when it cannot be read', async t => {
  const f = fixture(t);
  f.add({ id: 1 });
  const id = f.history.list({ tab: 'external' }).items[0].id;
  const install = scheduleEnv(t, { tz: 'Asia/Shanghai', link: false });
  const previous = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = install.zylosDir;
  t.after(() => { process.env.ZYLOS_DIR = previous; });
  const auth = { enabled: true, resolveAuthContext: () => ({ kind: 'cookie', scope: 'admin' }) };
  const call = async (route, instanceTz) => {
    let status, body;
    const res = { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
    assert.equal(await handleChatHistory({ method: 'GET', headers: {} }, res, new URL(route, 'http://localhost'),
      { auth, config: {}, history: f.history, instanceTz }), true);
    return { status, body };
  };
  const reader = () => createScheduleTz({ zylosDir: install.zylosDir, tzModule: `${TZ_URL}?case=${++tzImport}` });
  const messages = `/api/conversations/${encodeURIComponent(id)}/messages?tab=external`;
  let page = await call(messages, reader());
  assert.equal(page.status, 200); assert.equal(page.body.tz, 'Asia/Shanghai'); assert.deepEqual(page.body.items.map(row => row.id), [1]);
  fs.writeFileSync(path.join(install.zylosDir, '.env'), 'TZ=America/Los_Angeles\n');
  assert.equal((await call(messages, reader())).body.tz, 'America/Los_Angeles', 'a changed .env is read on the next page');
  fs.writeFileSync(path.join(install.zylosDir, '.env'), 'TZ=Not/AZone\n');
  assert.equal((await call(messages, reader())).body.tz, null, 'an invalid zone is unknown, so the page falls back to UTC');
  assert.equal((await call(messages, async () => { throw new Error('unreadable'); })).body.tz, null);
  assert.equal((await call(messages, null)).body.tz, null);
  fs.writeFileSync(path.join(install.zylosDir, '.env'), 'TZ=Asia/Shanghai\n');
  const list = await call('/api/conversations?tab=external', reader());
  assert.equal(list.status, 200); assert.equal(list.body.tz, 'Asia/Shanghai', 'the conversation list carries the zone for its times too');
  assert.equal((await call('/api/conversations?tab=external', null)).body.tz, null);
  const status = await call(`/api/conversations/${encodeURIComponent(id)}/status?tab=external&ids=1`, reader());
  assert.equal(status.status, 200); assert.equal('tz' in status.body, false, 'delivery status reads carry no zone');
});

// Integration: real read-only C4 SQLite and Dashboard display-name storage.
// Run for internal history/scope/attachment projection changes; rendering-only
// changes may skip. Official runner owns HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR;
// fixture() owns private DBs and removes them at teardown, with no child/tmux.
test('internal rows preserve raw facts and project peers on both histories without changing summaries', t => {
  const f = fixture(t, true);
  const conversations = new ChatConversations({ store: f.store });
  f.history.conversations = conversations;
  f.store.writeGroupDisplayName('tg:a', 'Telegram 对话', 'human');
  f.store.writeGroupDisplayName('dash-owned:one', '我的工作', 'human');
  f.add({ id: 1, channel: 'dashboard', endpoint_id: 'one', session_group: 'dash-owned:one', content: 'own external' });
  f.add({ id: 2, content: 'telegram external' });
  const body = '转达：你好 🌏';
  const prefix = '[internal] Yourself, from your "dash-owned:one" session group, said: ';
  f.add({ id: 3, channel: 'internal', direction: 'out', endpoint_id: 'tg:a', session_group: 'dash-owned:one', content: body });
  f.add({ id: 4, channel: 'internal', endpoint_id: 'dash-owned:one', content: prefix + body });
  f.add({ id: 5, channel: 'internal', endpoint_id: 'dash-owned:one', content: '[internal] Yourself, from your "wrong:group" session group, said: literal' });
  f.add({ id: 6, channel: 'internal', endpoint_id: 'missing:peer', content: 'missing body' });
  f.add({ id: 7, channel: 'internal', endpoint_id: 'tg:a', session_group: 'internal:only' });
  f.add({ id: 8, channel: 'internal', endpoint_id: 'tg:a', session_group: 'origin' });
  f.add({ id: 9, channel: 'internal', endpoint_id: 'internal:only', content: 'unlisted peer' });
  const own = f.history.messages(groupId('dash-owned:one'), { tab: 'mine' }).items;
  const external = f.history.messages(groupId('tg:a'), { tab: 'external' }).items;
  assert.deepEqual(own.map(row => row.id), [1, 3]);
  assert.deepEqual(external.map(row => row.id), [2, 4, 5, 6, 9]);
  assert.equal(own[1].direction, 'out');
  assert.equal(own[1].content, body);
  assert.deepEqual(own[1].internal, { peerSessionGroup: 'tg:a', peerDisplayName: 'Telegram 对话', peerExists: true, peerChannel: 'telegram', content: body });
  assert.equal(external[1].direction, 'in');
  assert.equal(external[1].content, prefix + body);
  assert.deepEqual(external[1].internal, { peerSessionGroup: 'dash-owned:one', peerDisplayName: '我的工作', peerExists: true, peerChannel: 'dashboard', content: body });
  assert.equal(external[2].internal.content, external[2].content, 'mismatched sender prefix is literal');
  assert.equal(external[3].internal.peerExists, false);
  assert.equal(external[3].internal.peerDisplayName, 'missing:peer');
  assert.equal(external[3].internal.peerChannel, null);
  assert.equal(external[4].internal.peerExists, false, 'internal-only group does not create a navigable peer');
  for (const [tab, id, expected] of [['mine', 1, 'own external'], ['external', 2, 'telegram external']]) {
    const list = f.history.list({ tab }).items.filter(item => !item.origin);
    assert.equal(list.length, 1);
    assert.equal(list[0].preview, expected);
    assert.equal(list[0].channel, tab === 'mine' ? 'dashboard' : 'telegram');
    const recent = f.reader.getGroupMessagePage(list[0].session_group, new URLSearchParams()).items;
    assert.equal(recent.length, 1);
    assert.equal(recent[0].id, id);
  }
  assert.throws(() => f.history.messages(groupId('dash-owned:one'), { tab: 'external' }), bad);
  assert.throws(() => f.history.messages(groupId('tg:a'), { tab: 'mine' }), bad);
  assert.throws(() => f.history.messages(groupId('internal:only'), { tab: 'external' }), bad);
  assert.throws(() => f.history.status(groupId('dash-owned:one'), { tab: 'mine', ids: [3] }), bad);
  assert.equal(Object.hasOwn(external[1], 'deliveryState'), false);
});

// Real SQLite/history projection under the official runner's isolated paths.
// Run for received-prefix changes; skip for layout-only work. fixture() owns
// the private DB and closes/removes it; no HTTP, model, PM2 or tmux launch.
test('received internal prefixes match the exact endpoint in both stored formats and retain raw content', t => {
  const f = fixture(t);
  f.add({ id: 1 });
  const endpoint = 'dash:peer.[one]';
  const cases = [
    ['in', `[internal] Yourself, from your "${endpoint}" session group, said: modern body`, 'modern body'],
    ['in', `[internal] ${endpoint} said: legacy body`, 'legacy body'],
    ['in', '[internal] wrong:peer said: literal'],
    ['in', '[internal] dash:peerXone said: literal'],
    ['in', '[internal] Yourself, from your "wrong:peer" session group, said: literal'],
    ['in', `[internal] ${endpoint} said:missing space`],
    ['in', `quoted [internal] ${endpoint} said: literal`],
    ['out', `[internal] ${endpoint} said: outgoing literal`],
    ['out', `[internal] Yourself, from your "${endpoint}" session group, said: outgoing literal`],
  ];
  for (const [index, [direction, content]] of cases.entries()) {
    f.add({ id: index + 2, channel: 'internal', endpoint_id: endpoint, direction, content });
  }
  const rows = f.history.messages(groupId('tg:a'), { tab: 'external' }).items.slice(1);
  assert.equal(rows.length, cases.length);
  for (const [index, [direction, raw, display = raw]] of cases.entries()) {
    assert.equal(rows[index].direction, direction);
    assert.equal(rows[index].content, raw, 'stored message remains available as raw detail');
    assert.equal(rows[index].internal.content, display);
  }
});

// Same runner/private database lifecycle as above. Run for internal pagination,
// prefix or recheck changes; skip for layout-only work. No network/process/tmux.
test('internal history pages and rechecks stay scoped and never resolve relayed attachments', t => {
  const f = fixture(t);
  f.add({ id: 1, channel: 'dashboard', endpoint_id: 'one', session_group: 'dash-owned:one' });
  const seen = [];
  f.history.attachments = { metadata(rows) { seen.push(...rows.map(row => row.id)); return new Map(); } };
  const raw = '[internal] Yourself, from your "tg:a" session group, said: file relay';
  f.add({ id: 3, channel: 'internal', endpoint_id: 'tg:a', session_group: 'dash-owned:one', content: raw });
  f.add({ id: 5, channel: 'internal', endpoint_id: 'tg:a', session_group: 'dash-owned:one', direction: 'out', content: raw });
  f.add({ id: 6, channel: 'internal', endpoint_id: 'tg:a', session_group: 'elsewhere:one' });
  const id = groupId('dash-owned:one');
  const first = f.history.messages(id, { tab: 'mine', limit: 1 });
  assert.deepEqual(first.items.map(row => row.id), [5]);
  assert.equal(first.items[0].internal.content, raw, 'outbound prefix-looking text stays literal');
  const older = f.history.messages(id, { tab: 'mine', limit: 1, cursor: first.nextCursor, recheckIds: [5] });
  assert.deepEqual(older.items.map(row => row.id), [3]);
  assert.equal(older.items[0].internal.content, 'file relay');
  assert.deepEqual(older.attachmentUpdates, [{ id: 5, attachments: [] }]);
  assert.deepEqual(seen, [], 'internal rows never reach attachment lookup');
  f.add({ id: 9, channel: 'internal', endpoint_id: 'missing:peer', session_group: 'dash-owned:one', content: '[internal] malformed' });
  const after = f.history.messages(id, { tab: 'mine', direction: 'after', cursor: first.afterCursor });
  assert.deepEqual(after.items.map(row => row.id), [9]);
  assert.equal(after.items[0].internal.content, '[internal] malformed');
  assert.throws(() => f.history.messages(id, { tab: 'mine', recheckIds: [6] }), bad);
  f.history.messages(id, { tab: 'mine', limit: 100 });
  assert.deepEqual(seen, [1]);
});

// Real history API projection and private SQLite, no service/runtime starts.
// Run for shared quote previews; skip unrelated browser or transport changes.
test('history quote previews retain line breaks and existing attachment labels', t => {
  const f = fixture(t);
  f.add({ id: 1, channel: 'dashboard', endpoint_id: 'a', session_group: 'dash-owned:a', direction: 'out',
    content: buildAnnotatedContent('[quote c4_id=9]\n**First line**\nsecond line',
      [{ kind: 'file', name: 'report.txt', path: '/private/report.txt', size: 3 }]) });
  f.add({ id: 2, channel: 'dashboard', endpoint_id: 'a', session_group: 'dash-owned:a',
    content: '[quote c4_id=1]\nCurrent words' });
  const result = f.history.messages(groupId('dash-owned:a')).items.find(row => row.id === 2);
  assert.equal(result.quote.preview, 'First line\nsecond line\n[文件] report.txt');
});
