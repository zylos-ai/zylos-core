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
import { createDisplayNames } from '../src/lib/workbench/display-names.js';
import { sendJson } from '../src/lib/http.js';
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';

// Real C4 and Dashboard SQLite behind the real conversation list HTTP route.
// Run for conversation list naming, group display names or history route
// changes; skip for styles and text-only changes. The official runner isolates
// HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and this fixture checks them before opening
// anything. Both databases live in a private directory under that TMPDIR; the
// only listener is a loopback server closed in t.after. No runtime, child
// process, PM2 or tmux is started.
function fixture(t) {
  const temporary = fs.realpathSync(os.tmpdir());
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME']) {
    const directory = process.env[key];
    assert.ok(directory && path.isAbsolute(directory), `${key} must be explicit`);
    assert.ok(path.resolve(directory).startsWith(path.dirname(temporary) + path.sep), `${key} must belong to the runner's private root`);
  }
  const root = fs.mkdtempSync(path.join(temporary, 'chat-external-names-'));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const c4 = path.join(root, 'comm-bridge/c4.db'), dashboard = path.join(root, 'dashboard.db');
  for (const file of [c4, dashboard]) assert.ok(file.startsWith(temporary + path.sep), 'fixture databases stay inside private TMPDIR');
  console.log('External display name isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: temporary, databases: [c4, dashboard], tmux: 'not launched' }));
  const db = new Database(c4);
  migrateSchema(db, { isNew: true }); migrateToV2(db);
  db.prepare('INSERT INTO channel_namespaces VALUES (?,?)').run('dash-owned', 'dashboard');
  const store = new Store(dashboard);
  const reader = new C4Reader(root);
  const conversations = new ChatConversations({ store });
  const history = new ChatHistory({ c4Reader: reader, conversations });
  const names = createDisplayNames({ store, zylosDir: root, runC4Db: () => { throw new Error('naming must not read C4 here'); } });
  let id = 0;
  const add = (channel, endpoint, group) => db.prepare(`INSERT INTO conversations(id,timestamp,direction,channel,endpoint_id,session_group,content,status)
    VALUES(?,?,'in',?,?,?,'hello','delivered')`).run(++id, `2026-01-01 12:00:${String(id).padStart(2, '0')}`, channel, endpoint, group);
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const cookie = 'external-names-session';
  store.insertSession(hash(cookie), Date.now());
  const config = { auth: { enabled: true, password: 'scrypt:test' }, chat: { allowRemote: false } };
  const auth = new AuthGate(config, store);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (await auth.handle(req, res, url)) return;
    if (await handleChatHistory(req, res, url, { auth, config, history })) return;
    sendJson(res, 404, { error: 'not_found' });
  });
  t.after(async () => {
    clearInterval(auth._cleanupTimer); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    reader.close(); store.close(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const list = async tab => {
    if (!server.listening) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat/conversations?tab=${tab}`,
      { headers: { cookie: `__Secure-zylos_dashboard_session=${cookie}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    return new Map(body.items.map(item => [item.session_group, item.display_name]));
  };
  return { store, names, add, list };
}

test('external channel list shows a stored group display name and otherwise the session group', async t => {
  const f = fixture(t);
  f.add('lark', 'oc_named', 'lark:group-oc_named');
  f.add('lark', 'oc_plain', 'lark:dm-oc_plain');
  f.add('telegram', 'legacy', '');
  f.names.setName('lark:group-oc_named', 'Product team', 'human');
  const external = await f.list('external');
  assert.equal(external.get('lark:group-oc_named'), 'Product team');
  assert.equal(external.get('lark:dm-oc_plain'), 'lark:dm-oc_plain');
  assert.equal(external.get(''), '旧历史');
  assert.equal(external.size, 3);
});

test('my conversations keep their naming while external names come from the same store', async t => {
  const f = fixture(t);
  f.add('dashboard', 'named', 'dash-owned:named');
  f.add('dashboard', 'plain', 'dash-owned:plain');
  f.add('lark', 'oc_peer', 'lark:dm-oc_peer');
  f.names.setName('dash-owned:named', 'My named chat', 'human');
  f.names.setName('lark:dm-oc_peer', 'Peer chat', 'agent');
  const mine = await f.list('mine');
  assert.equal(mine.get('dash-owned:named'), 'My named chat');
  assert.equal(mine.get('dash-owned:plain'), 'plain');
  assert.equal(mine.has('lark:dm-oc_peer'), false);
  const external = await f.list('external');
  assert.equal(external.get('lark:dm-oc_peer'), 'Peer chat');
  assert.equal(external.has('dash-owned:named'), false);
});

test('external channel list reads a renamed or cleared group display name on the next request', async t => {
  const f = fixture(t);
  f.add('lark', 'oc_team', 'lark:group-oc_team');
  assert.equal((await f.list('external')).get('lark:group-oc_team'), 'lark:group-oc_team');
  f.names.setName('lark:group-oc_team', 'First name', 'human');
  assert.equal((await f.list('external')).get('lark:group-oc_team'), 'First name');
  f.names.setName('lark:group-oc_team', 'Second name', 'human');
  assert.equal((await f.list('external')).get('lark:group-oc_team'), 'Second name');
  f.names.clearName('lark:group-oc_team', 'human');
  assert.equal((await f.list('external')).get('lark:group-oc_team'), 'lark:group-oc_team');
});
