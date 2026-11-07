import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { C4Reader } from '../src/lib/c4-reader.js';
import { ChatHistory, chatAttachmentPreview } from '../src/lib/chat/history.js';
import { handleChatHistory } from '../src/lib/chat/history-routes.js';
import { sendJson } from '../src/lib/http.js';
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';
import { CONTENT_PREFIX } from '../../comm-bridge/scripts/c4-content-schema.js';
import { buildAttachmentAnnotation } from '../../web-console/scripts/attachment-utils.js';

const groupId = value => `g:${Buffer.from(value).toString('hex').toUpperCase()}`;
const annotation = buildAttachmentAnnotation({ path: '/private/managed/report.pdf', name: 'report.pdf', size: 12, kind: 'file' });

function fixture(t, attachments) {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key] && !process.env[key].startsWith('/home/agent/zylos'), `${key} must be isolated`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-history-'));
  const dbPath = path.join(root, 'comm-bridge/c4.db');
  fs.mkdirSync(path.dirname(dbPath));
  console.log(JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, dbPath,
    tmuxSocket: path.join(root, 'private-tmux.sock'), runtimeLaunches: 0, pm2Launches: 0 }));
  const db = new Database(dbPath);
  migrateSchema(db, { isNew: true });
  migrateToV2(db);
  db.prepare('INSERT INTO channel_namespaces VALUES (?,?)').run('dash-owned', 'dashboard');
  const reader = new C4Reader(root);
  const history = new ChatHistory({ c4Reader: reader, attachments });
  const insert = db.prepare(`INSERT INTO conversations
    (id,timestamp,direction,channel,endpoint_id,session_group,content,status)
    VALUES (@id,'2026-01-01 12:00:00',@direction,@channel,@endpoint_id,@session_group,@content,'delivered')`);
  const add = row => insert.run({ direction: 'in', channel: 'dashboard', endpoint_id: 'a',
    session_group: 'dash-owned:a', content: annotation, ...row });
  t.after(() => { reader.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { history, db, add };
}

test('attachment list previews show names without managed paths and preserve text', t => {
  const f = fixture(t);
  f.add({ id: 1, content: `Readable text\n${annotation}` });
  const preview = f.history.list().items[0].preview;
  assert.equal(preview, 'Readable text\n[文件] report.pdf');
  assert.equal(preview.includes('/private/managed'), false);
  f.add({ id: 2, channel: 'web-console', endpoint_id: 'console', session_group: 'wc:console',
    content: `[MEDIA:image]/private/source.png\n${annotation}` });
  const external = f.history.list({ tab: 'external' }).items[0];
  assert.equal(external.preview, '[媒体] 原渠道附件\n[文件] report.pdf');
  assert.equal(external.preview.includes('/private/'), false);
  assert.equal(chatAttachmentPreview('[MEDIA:image]/private/source.png'), '[MEDIA:image]/private/source.png');
  assert.equal(chatAttachmentPreview('  ordinary text\n'), '  ordinary text\n');
});

test('unknown attachment blocks retain a generic invalid-message preview', () => {
  const raw = CONTENT_PREFIX + JSON.stringify({ version: 1, kind: 'message', messageId: 'message-1',
    fallbackText: 'SECRET_ID_REFERENCE', blocks: [{ id: 'file-1', type: 'x-zylos.file', schemaVersion: 1,
      data: { attachmentId: 'SECRET_ID_REFERENCE', nameSnapshot: 'report.pdf' }, fallbackText: 'file' }] });
  assert.equal(chatAttachmentPreview(raw, { c4Id: 7 }), '无法显示的消息');
});

test('history uses one metadata batch and refreshes unavailable rows without a new message', t => {
  let available = false;
  const calls = [];
  const attachments = { metadata(rows) {
    calls.push(rows.map(row => row.id));
    return new Map(rows.map(row => [row.id, [{ id: 'attachment-1', name: 'report.pdf', kind: 'file',
      size: 12, mime: 'application/octet-stream', available }]]));
  } };
  const f = fixture(t, attachments);
  for (let id = 1; id <= 20; id++) f.add({ id });
  const id = groupId('dash-owned:a');
  const first = f.history.messages(id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 20);
  assert.equal(first.items[0].attachments[0].available, false);
  available = true;
  const next = f.history.messages(id, { direction: 'after', cursor: first.afterCursor, recheckIds: '1,2' });
  assert.equal(next.items.length, 0);
  assert.equal(next.attachmentUpdates.length, 2);
  assert.equal(next.attachmentUpdates[0].attachments[0].available, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].length, 2);
  for (const row of next.attachmentUpdates) {
    assert.equal(Object.hasOwn(row, 'content'), false);
    assert.equal(Object.hasOwn(row.attachments[0], 'path'), false);
  }
});

test('metadata refresh caps each batch at one hundred and rejects foreign or hidden rows before metadata', t => {
  const calls = [];
  const f = fixture(t, { metadata(rows) {
    assert.ok(rows.length <= 100);
    calls.push(rows.length);
    return new Map(rows.map(row => [row.id, []]));
  } });
  for (let id = 1; id <= 200; id++) f.add({ id });
  f.add({ id: 201, endpoint_id: 'b', session_group: 'dash-owned:b' });
  f.add({ id: 202, endpoint_id: 'wrong' });
  const id = groupId('dash-owned:a');
  const firstHundred = Array.from({ length: 100 }, (_, index) => index + 1);
  const response = f.history.messages(id, { limit: 100, recheckIds: firstHundred.join(',') });
  assert.equal(response.items.length, 100);
  assert.equal(response.attachmentUpdates.length, 100);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], 100);
  assert.equal(calls[1], 100);
  for (const value of ['', '0', '-1', '1.5', '01', '1,1', '201', '202', '999', '9007199254740992',
    Array.from({ length: 101 }, (_, index) => index + 1).join(',')]) {
    assert.throws(() => f.history.messages(id, { recheckIds: value }), error => error.statusCode >= 400);
  }
  assert.equal(calls.length, 2);
});

test('external attachment metadata is unavailable and never queries the Dashboard attachment store', t => {
  const f = fixture(t, { metadata() { assert.fail('External attachment must not read managed records'); } });
  f.add({ id: 1, channel: 'web-console', endpoint_id: 'console', session_group: 'wc:console' });
  const result = f.history.messages(groupId('wc:console'), { tab: 'external' });
  const file = result.items[0].attachments[0];
  assert.equal(file.name, 'report.pdf');
  assert.equal(file.available, false);
  assert.equal(file.external, true);
  assert.equal(Object.hasOwn(file, 'path'), false);
});

// Integration boundary: real history route and private SQLite over loopback.
// Run for attachment refresh query/scope changes; unrelated UI may skip.
// Runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; no runtime/tmux/PM2 is launched.
test('history HTTP exposes bounded refresh and rejects repeated or misplaced refresh parameters', async t => {
  const f = fixture(t, { metadata: rows => new Map(rows.map(row => [row.id, []])) });
  f.add({ id: 1 });
  const auth = { enabled: true, resolveAuthContext: () => ({ kind: 'cookie', scope: 'admin' }) };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (await handleChatHistory(req, res, url, { auth, config: {}, history: f.history })) return;
    sendJson(res, 404, { error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = `/api/chat/conversations/${groupId('dash-owned:a')}/messages`;
  const good = await fetch(`${base}${route}?recheckIds=1`);
  assert.equal(good.status, 200);
  assert.equal((await good.json()).attachmentUpdates[0].id, 1);
  for (const target of [`${route}?recheckIds=1&recheckIds=2`, `${route}?recheckIds=`,
    '/api/chat/conversations?recheckIds=1', route.replace('/messages', '/status') + '?ids=1&recheckIds=1']) {
    assert.equal((await fetch(base + target)).status, 400);
  }
});
