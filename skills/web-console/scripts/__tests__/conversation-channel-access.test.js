import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import { createConversationHistoryHandler } from '../conversation-history.js';
import * as c4Schema from '../../../comm-bridge/scripts/c4-schema.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'console-history-'));
  const db = new Database(path.join(directory, 'c4.db'));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE conversations (
    id INTEGER PRIMARY KEY, direction TEXT, channel TEXT, endpoint_id TEXT,
    content TEXT, timestamp TEXT, session_group TEXT
  )`);
  const insert = db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run(1, 'out', 'dashboard', 'own', 'dashboard-body-private', '2026-01-01 00:00:01', 'console:own');
  insert.run(2, 'out', 'void', 'internal', 'void-body-private', '2026-01-01 00:00:02', 'console:own');
  insert.run(3, 'in', 'web-console', 'local', 'console-first', '2026-01-01 00:00:03', 'dashboard:local');
  insert.run(4, 'out', 'web-console', 'local', 'console-second', '2026-01-01 00:00:04', 'dashboard:local');
  insert.run(5, 'out', 'telegram', 'team', 'other-channel', '2026-01-01 00:00:05', 'dashboard:team');
  const app = express();
  let cleaned = 0;
  app.get('/api/conversations', createConversationHistoryHandler(db, row => { cleaned += 1; return row; }));
  const server = http.createServer(app);
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    db,
    cleaned: () => cleaned,
    async read(query = '') {
      const response = await fetch(`${origin}/api/conversations${query}`);
      return { status: response.status, body: await response.json() };
    },
  };
}

// Handler/SQLite integration. Run when channel filtering changes; skip unrelated
// UI edits. Only a temporary C4 fixture and private loopback server are opened;
// no services, tmux, PM2 or live DB access.
test('conversation history always excludes Dashboard and internal channels', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (const query of ['?channel=dashboard', '?channel=void']) {
    const response = await f.read(query);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, []);
    assert.doesNotMatch(JSON.stringify(response.body), /dashboard-body-private|void-body-private/);
    assert.equal(f.cleaned(), 0);
  }
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations WHERE channel = 'dashboard'").get().n, 1);
});

// Same isolation and run/skip boundaries as above. Namespace-like group values
// deliberately differ from channel names to catch filtering by the wrong field.
test('conversation history preserves ordinary channel selection and pagination', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let response = await f.read();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.map(row => row.content), ['console-first', 'console-second']);
  response = await f.read('?channel=web-console&limit=1');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.map(row => row.content), ['console-second']);
  response = await f.read('?channel=telegram');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.map(row => row.content), ['other-channel']);
  response = await f.read('?channel=dashboard%27%20OR%201%3D1--');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, []);
});

// Actual server entrypoint/HTTP/SQLite integration. Run when history filtering
// or server route wiring changes; skip unrelated UI edits. HOME, ZYLOS_DIR,
// PM2_HOME and the short TMPDIR/TMUX_TMPDIR are private, with a full fixture C4
// schema and an empty .env. Only loopback port 0 is used. Teardown awaits child
// exit before removing the fixture; no messages, live DB or live tmux access.
test('server history route excludes private channels and preserves ordinary history', { timeout: 15000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'console-server-'));
  let child;
  let exited;
  t.after(async () => {
    if (child) {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await exited;
      } finally { clearTimeout(timer); }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const home = path.join(directory, 'home');
  const root = path.join(home, 'zylos');
  const tmp = path.join(directory, 'tmp');
  for (const dir of [home, root, tmp, path.join(root, 'comm-bridge'), path.join(root, '.zylos')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(root, '.env'), '');
  fs.writeFileSync(path.join(root, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'single' }));
  const configPath = path.join(root, 'components', 'dashboard', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = { chat: { allowRemote: false } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const dbPath = path.join(root, 'comm-bridge', 'c4.db');
  const db = new Database(dbPath);
  try {
    guardDatabase(db, c4Schema);
    const insert = db.prepare(`INSERT INTO conversations
      (direction, channel, endpoint_id, content, timestamp, session_group)
      VALUES ('out', ?, 'console', ?, ?, ?)`);
    insert.run('dashboard', 'dashboard-body-private', '2026-01-01 00:00:01', 'console:own');
    insert.run('void', 'void-body-private', '2026-01-01 00:00:02', 'console:own');
    insert.run('web-console', 'console-first', '2026-01-01 00:00:03', 'dashboard:local');
    insert.run('web-console', 'console-second', '2026-01-01 00:00:04', 'dashboard:local');
    insert.run('telegram', 'other-channel', '2026-01-01 00:00:05', 'dashboard:team');
  } finally { db.close(); }
  const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
  const packageRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const env = {
    PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC',
    HOME: home, ZYLOS_DIR: root, PM2_HOME: path.join(home, '.pm2'),
    TMPDIR: tmp, TMUX_TMPDIR: tmp, ZYLOS_PACKAGE_ROOT: packageRoot,
    WEB_CONSOLE_PORT: '0', WEB_CONSOLE_BIND: '127.0.0.1',
    WEB_CONSOLE_SKILLS_DIR: fileURLToPath(new URL('../../../', import.meta.url)),
  };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    assert.ok(env[key].startsWith(directory + path.sep), key);
  }
  assert.ok(Buffer.byteLength(path.join(tmp, `tmux-${process.getuid()}`, 'default')) < 104);
  assert.equal(env.TMUX, undefined);
  t.diagnostic(JSON.stringify({ HOME: home, ZYLOS_DIR: root, PM2_HOME: env.PM2_HOME, TMPDIR: tmp,
    TMUX_TMPDIR: tmp, dbPath, WEB_CONSOLE_PORT: env.WEB_CONSOLE_PORT, serverPath }));
  child = spawn(process.execPath, [serverPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  exited = new Promise(resolve => child.once('close', resolve));
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out\n${stdout}\n${stderr}`)), 8000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}\n${stdout}\n${stderr}`)); });
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk).slice(-8192);
      const match = stdout.match(/Web Console server running on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  async function read(query = '') {
    const response = await fetch(`${origin}/api/conversations${query}`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    return response.json();
  }
  for (const allowRemote of [false, true]) {
    config.chat.allowRemote = allowRemote;
    fs.writeFileSync(configPath, JSON.stringify(config));
    for (const channel of ['dashboard', 'void']) assert.deepEqual(await read(`?channel=${channel}`), []);
    assert.deepEqual((await read()).map(row => row.content), ['console-first', 'console-second']);
    assert.deepEqual((await read('?channel=web-console&limit=1')).map(row => row.content), ['console-second']);
    assert.deepEqual((await read('?channel=telegram')).map(row => row.content), ['other-channel']);
    assert.deepEqual(await read('?channel=dashboard%27%20OR%201%3D1--'), []);
  }
});
