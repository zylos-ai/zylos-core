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

import { ChatHistory } from '../src/lib/chat/history.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { handleChatHistory } from '../src/lib/chat/history-routes.js';
import { sendJson } from '../src/lib/http.js';
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';

const groupId = value => `g:${Buffer.from(value).toString('hex').toUpperCase()}`;

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

// Real history projections in a private database. Run when nested quote
// previews or internal metadata change; unrelated frontend work may skip.

// Real history/list projections and private SQLite. Run for quote eligibility
// changes; UI styling may skip. No runtime, socket or child is started.

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

// Real indexed C4 list and preview reads in the private fixture. Run when
// conversation activity, membership or previews change. No live runtime/HTTP.

// Real Dashboard name/pin data and private C4. Run for list search, pin or
// keyset scope changes. The same isolated fixture owns both databases.

test('Dashboard history quotes replies to earlier owner messages', t => {
  const { add, history } = fixture(t);
  const dialog = { channel: 'dashboard', endpoint_id: 'a', session_group: 'dash-owned:a' };
  add({ ...dialog, id: 1, content: 'First question' });
  add({ ...dialog, id: 2, content: 'Latest question' });
  add({ ...dialog, id: 3, direction: 'out', endpoint_id: 'a|msg:1', content: 'Earlier reply' });
  add({ ...dialog, id: 4, endpoint_id: 'b', session_group: 'dash-owned:b', content: 'Unrelated question' });
  add({ ...dialog, id: 5, direction: 'out', endpoint_id: 'a|msg:2', content: 'Latest reply' });
  const id = groupId(dialog.session_group);
  const { items, unreadCount } = history.messages(id, { anchor: 'read' });
  const earlier = items.find(row => row.id === 3);
  const latest = items.find(row => row.id === 5);
  assert.deepEqual(earlier.quote, { id: 1, direction: 'in', internal: false,
    timestamp: '2026-01-01 12:00:00', preview: 'First question', available: true });
  assert.equal(latest.quote, undefined);
  assert.equal(unreadCount, 2);
  const summary = history.list().items.find(row => row.id === id);
  assert.equal(summary.preview, 'Latest reply');
  assert.equal(summary.endpoint_id, 'a');
});

test('Mine list and read anchor report the same unread count', t => {
  const { add, history, store } = fixture(t, true);
  history.conversations = new ChatConversations({ store });
  const dialog = { channel: 'dashboard', endpoint_id: 'a', session_group: 'dash-owned:a' };
  const id = groupId(dialog.session_group);
  add({ ...dialog, id: 1, direction: 'out' });
  history.markRead(id, 1);
  add({ ...dialog, id: 2, direction: 'out' });
  add({ ...dialog, id: 3, channel: 'internal', direction: 'out', endpoint_id: 'dash-owned:b' });
  add({ ...dialog, id: 4, channel: 'internal', direction: 'in', endpoint_id: 'dash-owned:b' });
  add({ ...dialog, id: 5, direction: 'out' });
  add({ ...dialog, id: 6 });

  const { items, summary } = history.list({ includeSummary: true });
  const row = items.find(item => item.id === id);
  const anchor = history.messages(id, { anchor: 'read' });
  assert.equal(row.unreadCount, 2);
  assert.equal(row.unreadCount, anchor.unreadCount);
  assert.equal(row.unread, true);
  assert.equal(summary.unread_conversations, 1);
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

// Integration: real auth, history routes, SQLite and private loopback only.
// Run for history scope/routes/auth changes; skip for styles or text changes.
// Uses runner-isolated HOME/ZYLOS_DIR/PM2_HOME/TMPDIR, no process or tmux launch.
test('HTTP history routes enforce access before reading and reject ambiguous query parameters', async t => {
  const f = fixture(t, true);
  f.add({ id: 1, content: 'PRIVATE_HISTORY' }); f.add({ id: 3 });
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const cookie = 'history-browser-session';
  f.store.insertSession(hash(cookie), Date.now());
  const tokens = {
    read: `zylos_st_${'a'.repeat(64)}`,
    admin: `zylos_st_${'b'.repeat(64)}`,
    'conversations.read': `zylos_st_${'c'.repeat(64)}`,
  };
  for (const scope of Object.keys(tokens)) {
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
  f.add({ id: 4, channel: 'dashboard', endpoint_id: 'project', session_group: 'dash-owned:project',
    direction: 'out', timestamp: '2026-01-01 12:00:01', content: '**Agent reply**' });
  const mine = '/api/conversations?tab=mine';
  const adminList = await request(mine, 'admin');
  assert.equal(adminList.status, 200);
  assert.deepEqual(adminList.body.summary, {
    latest: { at: '2026-01-01T12:00:01.000Z', title: 'project', preview: 'Agent reply' },
    unread_conversations: 1,
  });
  const customList = await request(mine, 'conversations.read');
  assert.equal(customList.status, 200);
  assert.equal(Object.hasOwn(customList.body, 'summary'), false);

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

// Integration: real read-only C4 SQLite and Dashboard display-name storage.
// Run for internal history/scope/attachment projection changes; rendering-only
// changes may skip. Official runner owns HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR;
// fixture() owns private DBs and removes them at teardown, with no child/tmux.

// Real SQLite/history projection under the official runner's isolated paths.
// Run for received-prefix changes; skip for layout-only work. fixture() owns
// the private DB and closes/removes it; no HTTP, model, PM2 or tmux launch.

// Same runner/private database lifecycle as above. Run for internal pagination,
// prefix or recheck changes; skip for layout-only work. No network/process/tmux.

// Real history API projection and private SQLite, no service/runtime starts.
// Run for shared quote previews; skip unrelated browser or transport changes.
