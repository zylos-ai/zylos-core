import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../src/lib/store.js';
import { ChatAttachments } from '../src/lib/chat/attachments.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { ChatSender } from '../src/lib/chat/send.js';

import { handleChatAttachments } from '../src/lib/chat/attachment-routes.js';
import { handleChatConversations } from '../src/lib/chat/write-routes.js';
import { sendJson } from '../src/lib/http.js';
import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../comm-bridge/scripts/c4-schema.js';

// Covers local upload/download and attachment send routing using real stores,
// formatter and sender. Run for these entry points; UI-only changes may skip.
// Official runner isolates environment before imports; no PM2/tmux/runtime is
// started. Only receive and authentication identities are fixture boundaries.
async function fixture(t) {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key] && !process.env[key].startsWith(os.userInfo().homedir + path.sep), `${key} must be isolated`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-http-'));
  console.log(JSON.stringify({ isolated: true, home: process.env.HOME, zylosDir: root,
    pm2Home: process.env.PM2_HOME, tmpdir: process.env.TMPDIR, privateSocket: path.join(root, 'tmux.sock'),
    dashboardPath: path.join(root, 'components/dashboard/dashboard.db'), corePath: path.join(root, 'comm-bridge/c4.db') }));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  fs.writeFileSync(path.join(root, '.env'), 'DASHBOARD_MAX_UPLOAD_MB=1\n');
  const db = new Database(path.join(root, 'comm-bridge', 'c4.db'));
  guardDatabase(db, schema);
  db.prepare("INSERT INTO channel_namespaces(namespace,component_name) VALUES('dash','dashboard')").run();
  const store = new Store(path.join(root, 'components/dashboard/dashboard.db'));
  const conversations = new ChatConversations({ store });
  const draft = conversations.create();
  const c4Reader = { _open: () => db };
  const attachments = new ChatAttachments({ store, c4Reader, zylosDir: root });
  let receives = 0;
  const sender = new ChatSender({ conversations, c4Reader, attachments, zylosDir: root,
    loadCore: async () => ({ ensureChannelNamespace: () => {
      db.prepare("INSERT OR IGNORE INTO channel_namespaces(namespace,component_name) VALUES('dash','dashboard')").run();
      return { componentName: 'dashboard', namespace: 'dash' };
    },
      async receive(args) {
        receives++;
        const localId = args[args.indexOf('--endpoint') + 1];
        const content = args[args.indexOf('--content') + 1];
        const result = db.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,session_group,content,status,delivery_action)
          VALUES('in','dashboard',?,?,?,'failed','suppressed')`).run(localId, `dash:${localId}`, content);
        return { ok: true, id: Number(result.lastInsertRowid), action: 'suppressed' };
      } }) });
  const config = { chat: { allowRemote: false } };
  let mode = 'multi';
  const auth = { enabled: true, resolveAuthContext(req) {
    const identity = req.headers['x-fixture-identity'] || 'cookie';
    req._authContext = identity === 'none' ? null : { kind: identity === 'cookie' ? 'cookie' : 'api',
      scope: identity === 'read' ? 'read' : 'admin', principalId: identity };
    return req._authContext;
  } };
  let duringBody = false;
  let requestHeaders;
  const server = http.createServer(async (req, res) => {
    requestHeaders = req.headers;
    if (duringBody) req.once('end', () => db.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,session_group,content)
      VALUES('in','telegram','other','other:group','during body')`).run());
    const url = new URL(req.url, 'http://localhost');
    if (await handleChatAttachments(req, res, url, { auth, config, sender, attachments, readMode: () => mode })) return;
    if (await handleChatConversations(req, res, url, { auth, config, conversations, sender, readMode: () => mode })) return;
    sendJson(res, 404, { error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await attachments.close(); store.close(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const route = `/api/conversations/${encodeURIComponent(draft.id)}`;
  const request = (suffix, { identity = 'cookie', headers = {}, ...options } = {}) => fetch(base + route + suffix,
    { ...options, signal: AbortSignal.timeout(10000), headers: { origin: base, 'x-fixture-identity': identity, ...headers } });
  const form = (bytes = Buffer.from('hello'), name = 'report.txt', type = 'text/plain') => {
    const body = new FormData(); body.append('file', new Blob([bytes], { type }), name); return body;
  };
  return { root, base, route, db, store, draft, sender, attachments, config, request, form,
    setMode: value => { mode = value; }, receives: () => receives, addDuringBody: () => { duringBody = true; },
    lastRequestHeaders: () => requestHeaders };
}

function multipart(parts, boundary = 'bounded-upload') {
  return { body: Buffer.from(parts.map(({ headers, body }) => `--${boundary}\r\n${headers.join('\r\n')}\r\n\r\n${body}\r\n`).join('')
    + `--${boundary}--\r\n`), contentType: `multipart/form-data; boundary="${boundary}"` };
}

const filePart = (name = 'report.txt', headers = []) => ({ headers: [
  `Content-Disposition: form-data; name="file"; filename="${name}"`, 'Content-Type: text/plain', ...headers,
], body: 'hello' });
const textPart = (name = 'label', body = 'value') => ({ headers: [`Content-Disposition: form-data; name="${name}"`], body });

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'streaming condition timed out');
    await delay(10);
  }
}

function openUpload(t, f) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(f.base + f.route + '/uploads', { method: 'POST',
      headers: { origin: f.base, 'content-type': 'multipart/form-data; boundary=streaming-upload' } }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 4096) res.destroy(new Error('unexpected upload response size'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('upload timeout')));
  });
  response.catch(() => {});
  t.after(() => request.destroy());
  request.write('--streaming-upload\r\nContent-Disposition: form-data; name="file"; filename="stream.txt"\r\nContent-Type: text/plain\r\n\r\n');
  return { request, response };
}

const partialFiles = f => fs.readdirSync(f.attachments.mediaDir).filter(name => name.endsWith('.part'));

test('permission loss before the upload finishes rejects without publishing the streamed file', async t => {
  const f = await fixture(t);
  const { request, response } = openUpload(t, f);
  request.write(Buffer.alloc(32768));
  await waitFor(() => partialFiles(f).length === 1);
  f.setMode('single');
  request.end('\r\n--streaming-upload--\r\n');
  const result = await response;
  assert.equal(result.status, 403);
  assert.equal(Object.hasOwn(result.body, 'id'), false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_attachments').get().n, 0);
  assert.equal(fs.readdirSync(f.attachments.mediaDir).length, 0);
});

test('upload and config gate authentication, remote access, mode and registered ownership', async t => {
  const f = await fixture(t);
  for (const identity of ['none', 'admin', 'read']) {
    assert.equal((await f.request('/uploads/config', { identity })).status, 403);
    assert.equal((await f.request('/uploads', { method: 'POST', identity, body: 'invalid body' })).status, 403);
  }
  f.config.chat.allowRemote = true;
  assert.equal((await f.request('/uploads/config', { identity: 'admin' })).status, 200);
  assert.equal((await f.request('/uploads/config', { identity: 'read' })).status, 403);
  f.setMode('single');
  assert.equal((await f.request('/uploads/config')).status, 403);
  assert.equal((await f.request('/uploads', { method: 'POST', body: f.form() })).status, 403);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_attachments').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM group_heads').get().n, 0);
});

test('chunked multipart counts all bytes without Content-Length and enforces the total request bound', async t => {
  const f = await fixture(t);
  const post = async value => {
    const { body, contentType } = multipart([filePart('report.txt'), textPart('label', value)]);
    return f.request('/uploads', { method: 'POST', body: Readable.from([body.subarray(0, 32), body.subarray(32)]),
      duplex: 'half', headers: { 'content-type': contentType } });
  };
  assert.equal((await post('valid')).status, 201);
  assert.equal(f.lastRequestHeaders()['content-length'], undefined);
  assert.equal(f.lastRequestHeaders()['transfer-encoding'], 'chunked');
  const { body, contentType } = multipart([filePart()]);
  const overflowing = Readable.from([body.subarray(0, body.length - 2), Buffer.alloc(1048576 + 65536)]);
  const response = await f.request('/uploads', { method: 'POST', body: overflowing, duplex: 'half', headers: { 'content-type': contentType } });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'chat_upload_too_large');
  assert.equal(f.lastRequestHeaders()['content-length'], undefined);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_attachments').get().n, 1);
});

test('attachment-only first send retains suppressed authority and downloads use sniffed MIME', async t => {
  const f = await fixture(t);
  const uploaded = await f.request('/uploads', { method: 'POST', body: f.form(Buffer.from('<script>x</script>'), 'pretend.png', 'image/png') });
  const item = await uploaded.json();
  const send = async body => f.request('/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await send({ content: '', attachments: [item.id, item.id] })).status, 400);
  assert.equal((await send({ content: '', attachments: Array(21).fill(item.id) })).status, 400);
  const response = await send({ content: '', attachments: [item.id] });
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.stored, true); assert.equal(receipt.deliveryState, 'suppressed');
  assert.equal(f.receives(), 1);
  const row = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(receipt.messageId);
  assert.match(row.content, /^\[attachment:image /);
  assert.ok(row.content.includes(f.attachments.mediaDir));
  const download = await f.request(`/attachments/${item.id}`);
  assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.equal(await download.text(), '<script>x</script>');
  assert.equal((await f.request(`/attachments/${item.id}`, { identity: 'none' })).status, 403);
  assert.equal((await send({ content: '', attachments: [item.id] })).status, 200);
  assert.equal(f.receives(), 1, 'same suppressed first submission is not resent');
});
