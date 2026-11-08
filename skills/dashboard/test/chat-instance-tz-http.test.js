import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { mock } from 'node:test';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { VersionChecker } from '../src/lib/version-checker.js';
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';
import { scheduleEnv } from './fixtures/schedule-env.js';

// The actual HTTP server must hand the instance time zone reader to the chat message route.
mock.method(VersionChecker.prototype, 'start', () => {});

// HTTP integration. Covers: the real server entry wires the instance .env TZ reader into
// GET /api/chat/conversations/:id/messages (login cookie, real c4.db, real scheduler tz.js), and a changed .env
// shows on the next page without a restart. Run when the server wiring, the chat history route or the time zone
// reader changes; changes limited to chart drawing may skip it. Isolation: a temporary HOME, ZYLOS_DIR, PM2_HOME,
// short TMPDIR and tmux directory from scheduleEnv (asserted to stay under its root), private c4.db and
// dashboard.db inside it, process ZYLOS_DIR pointed there for this file only; server, timers and stores are closed
// and the root removed in teardown.
test('the server answers message pages with the instance time zone from .env', { timeout: 20_000 }, async t => {
  const install = scheduleEnv(t, { tz: 'Asia/Shanghai', link: false });
  const { zylosDir } = install;
  assert.ok(zylosDir !== '/home/agent/zylos' && zylosDir.startsWith(install.root + path.sep));
  console.log('Instance time zone HTTP isolation:', JSON.stringify({ ZYLOS_DIR: zylosDir, HOME: install.env.HOME,
    PM2_HOME: install.env.PM2_HOME, TMPDIR: install.env.TMPDIR }));

  const configDir = path.join(zylosDir, 'components', 'dashboard');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'secret' } }));
  fs.mkdirSync(path.join(zylosDir, 'comm-bridge'), { recursive: true });
  const c4 = new Database(path.join(zylosDir, 'comm-bridge', 'c4.db'));
  migrateSchema(c4, { isNew: true });
  migrateToV2(c4);
  c4.prepare(`INSERT INTO conversations (id,timestamp,direction,channel,endpoint_id,session_group,content,status,delivery_action)
    VALUES (1,'2026-11-01 16:30:00','in','telegram','shared','tg:a','hello','delivered',NULL)`).run();
  c4.close();

  const previous = { ZYLOS_DIR: process.env.ZYLOS_DIR, DASHBOARD_PORT: process.env.DASHBOARD_PORT };
  process.env.ZYLOS_DIR = zylosDir;
  process.env.DASHBOARD_PORT = '0';
  let server;
  const stores = new Set(), timers = new Set();
  const migrate = Store.prototype.migrate, schedule = globalThis.setInterval;
  t.mock.method(Store.prototype, 'migrate', function (...args) { stores.add(this); return migrate.apply(this, args); });
  t.mock.method(globalThis, 'setInterval', (...args) => { const timer = schedule(...args); timers.add(timer); return timer; });
  t.after(async () => {
    for (const timer of timers) clearInterval(timer);
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await server.closeAttachments?.();
    }
    for (const store of stores) if (store.db.open) store.close();
    for (const [key, value] of Object.entries(previous)) if (value == null) delete process.env[key]; else process.env[key] = value;
  });

  const { createServer } = await import(new URL(`../src/index.js?instance-tz=${Date.now()}`, import.meta.url).href);
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'secret' }) });
  await login.text();
  assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('__Secure-zylos_dashboard_session=')).split(';')[0];
  const get = async route => {
    const response = await fetch(origin + route, { headers: { cookie } });
    const body = await response.json();
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(body)}`);
    return body;
  };

  const list = await get('/api/chat/conversations?tab=external');
  assert.equal(list.items.length, 1);
  const messages = `/api/chat/conversations/${encodeURIComponent(list.items[0].id)}/messages?tab=external`;
  const first = await get(messages);
  assert.ok(first.items.some(row => row.id === 1));
  assert.equal(first.tz, 'Asia/Shanghai', 'the page reads daily chart dates in the instance .env TZ');
  fs.writeFileSync(path.join(zylosDir, '.env'), 'TZ=America/Los_Angeles\n');
  assert.equal((await get(messages)).tz, 'America/Los_Angeles', 'a changed .env shows on the next page without a restart');
});
