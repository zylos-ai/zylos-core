import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { createConversationHistoryHandler } from '../conversation-history.js';

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

// Real history route/SQLite integration. Run when channel filtering or route
// wiring changes; skip unrelated UI edits. Only a temporary C4 fixture and a
// private loopback server are opened; no services, tmux, PM2 or live DB access.
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
