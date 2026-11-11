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
import { ensureOriginConversation, ORIGIN_CONVERSATION_ID } from '../src/lib/chat/origin.js';
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
  fs.writeFileSync(path.join(root, '.env'), 'WEB_CONSOLE_MAX_UPLOAD_MB=1\n');
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
  const route = `/api/chat/conversations/${encodeURIComponent(draft.id)}`;
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

test('upload writes and grows its private partial file before the chunked request ends', async t => {
  const f = await fixture(t);
  const { request, response } = openUpload(t, f);
  request.write(Buffer.alloc(32768, 97));
  await waitFor(() => partialFiles(f).some(name => fs.statSync(path.join(f.attachments.mediaDir, name)).size > 0));
  const name = partialFiles(f)[0];
  const file = path.join(f.attachments.mediaDir, name);
  const size = fs.statSync(file).size;
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_attachments').get().n, 0);
  request.write(Buffer.alloc(32768, 98));
  await waitFor(() => fs.statSync(file).size > size);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_attachments').get().n, 0);
  request.end('\r\n--streaming-upload--\r\n');
  const result = await response;
  assert.equal(result.status, 201);
  assert.equal(result.body.size, 65536);
  assert.equal(partialFiles(f).length, 0);
  const row = f.store.db.prepare('SELECT * FROM chat_attachments WHERE id=?').get(result.body.id);
  const bytes = fs.readFileSync(path.join(f.attachments.mediaDir, row.storage_name));
  assert.equal(bytes.subarray(0, 32768).equals(Buffer.alloc(32768, 97)), true);
  assert.equal(bytes.subarray(32768).equals(Buffer.alloc(32768, 98)), true);
});

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

test('malformed trailing multipart fields cannot publish the already streamed file', async t => {
  const f = await fixture(t);
  const { request, response } = openUpload(t, f);
  request.write(Buffer.alloc(32768));
  await waitFor(() => partialFiles(f).length === 1);
  request.end('\r\n--streaming-upload\r\nContent-Disposition: form-data; name="label"\r\n\r\nunterminated');
  const result = await response;
  assert.equal(result.status, 400);
  assert.equal(Object.hasOwn(result.body, 'id'), false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_attachments').get().n, 0);
  assert.equal(fs.readdirSync(f.attachments.mediaDir).length, 0);
});

test('disconnecting an upload cleans its partial file without registering an attachment', async t => {
  const f = await fixture(t);
  const { request, response } = openUpload(t, f);
  request.write(Buffer.alloc(32768));
  await waitFor(() => partialFiles(f).length === 1);
  request.destroy();
  await assert.rejects(response);
  await waitFor(() => fs.readdirSync(f.attachments.mediaDir).length === 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_attachments').get().n, 0);
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

test('Origin uploads work in both modes and remotely only with the switch on and an admin key', async t => {
  const f = await fixture(t);
  ensureOriginConversation(f.store.db);
  const origin = `/api/chat/conversations/${encodeURIComponent(ORIGIN_CONVERSATION_ID)}/uploads`;
  const upload = (identity, headers) => fetch(f.base + origin, { method: 'POST', body: f.form(), signal: AbortSignal.timeout(10000),
    headers: { origin: f.base, 'x-fixture-identity': identity, ...headers } });
  for (const mode of ['single', 'multi']) {
    f.setMode(mode);
    for (const allowRemote of [false, true]) {
      f.config.chat.allowRemote = allowRemote;
      assert.equal((await upload('cookie')).status, 201, `${mode} local cookie`);
      assert.equal((await upload('admin')).status, allowRemote ? 201 : 403, `${mode} remote admin, switch ${allowRemote}`);
      assert.equal((await upload('read')).status, 403, `${mode} remote read key`);
    }
  }
  f.config.chat.allowRemote = false;
  const body = await (await upload('admin')).json();
  assert.equal(body.error?.code ?? body.error ?? body.code, 'remote_chat_disabled');
});

test('single-file bounded uploads create no head, reject malformed requests and hide prepared downloads', async t => {
  const f = await fixture(t);
  const config = await (await f.request('/uploads/config')).json();
  assert.equal(config.maxUploadBytes, 1048576); assert.equal(config.maxAttachments, 20);
  const upload = await f.request('/uploads', { method: 'POST', body: f.form() });
  assert.equal(upload.status, 201);
  const item = await upload.json();
  assert.equal(item.name, 'report.txt'); assert.equal(item.size, 5); assert.equal(item.kind, 'file');
  assert.equal(Object.hasOwn(item, 'path'), false);
  assert.equal((await f.request(`/attachments/${item.id}`)).status, 404);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM group_heads').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM conversations').get().n, 0);
  assert.equal((await f.request('/uploads', { method: 'POST', body: 'not multipart' })).status, 400);
  const multiple = f.form(); multiple.append('file', new Blob(['second']), 'second.txt');
  assert.equal((await f.request('/uploads', { method: 'POST', body: multiple })).status, 400);
  const extra = f.form(); extra.append('source', 'agent');
  assert.equal((await f.request('/uploads', { method: 'POST', body: extra })).status, 201);
  assert.equal((await f.request('/uploads', { method: 'POST', body: f.form(Buffer.alloc(1048577)) })).status, 413);
  assert.equal((await f.request('/uploads/config?bad=1')).status, 400);
  assert.equal((await f.request('/uploads/config', { method: 'POST' })).status, 405);
});

test('multipart accepts eight bounded text fields and rejects excess counts or UTF-8 field and file names', async t => {
  const f = await fixture(t);
  const post = async parts => {
    const { body, contentType } = multipart(parts);
    return f.request('/uploads', { method: 'POST', body, headers: { 'content-type': contentType } });
  };
  const fields = Array.from({ length: 8 }, (_, index) => textPart(`label${index}`, 'value'));
  fields[0] = textPart('\u00e9'.repeat(127) + 'a', '\u00e9'.repeat(512));
  assert.equal((await post([filePart('a'.repeat(255)), ...fields])).status, 201);
  assert.equal((await post([filePart(), ...fields, textPart('extra')])).status, 400);
  assert.equal((await post([filePart(), textPart('label', '\u00e9'.repeat(513))])).status, 400);
  assert.equal((await post([filePart(), { headers: ['Content-Disposition: form-data'], body: 'missing name' }])).status, 400);
  assert.equal((await post([filePart(), { headers: ['X-Unknown: skipped'], body: 'missing disposition' }])).status, 400);
  assert.equal((await post([filePart(), { headers: ['Content-Disposition: attachment; name="label"'], body: 'wrong disposition' }])).status, 400);
  assert.equal((await post([filePart(), textPart('\u00e9'.repeat(128))])).status, 400);
  assert.equal((await post([filePart('\u00e9'.repeat(128))])).status, 400);
  const extended = filePart();
  extended.headers[0] = `Content-Disposition: form-data; name="file"; filename*=UTF-8''${'a'.repeat(256)}`;
  assert.equal((await post([extended])).status, 400);
  assert.equal((await post([filePart('a'.repeat(256) + '/report.txt')])).status, 400);
  assert.equal((await post([textPart()])).status, 400);
  const wrong = filePart(); wrong.headers[0] = 'Content-Disposition: form-data; name="other"; filename="report.txt"';
  assert.equal((await post([wrong])).status, 400);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_attachments').get().n, 1);
});

test('ignored text field names stay literal and do not expand bracket paths into arrays', async t => {
  const f = await fixture(t);
  const { body, contentType } = multipart([filePart(), textPart('a[4294967294]'), textPart('a[x]')]);
  const response = await f.request('/uploads', { method: 'POST', body, headers: { 'content-type': contentType } });
  assert.equal(response.status, 201);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_attachments').get().n, 1);
});

test('multipart enforces per-part header count and byte bounds before parsing file contents', async t => {
  const f = await fixture(t);
  const post = async parts => {
    const { body, contentType } = multipart(parts);
    return f.request('/uploads', { method: 'POST', body, headers: { 'content-type': contentType } });
  };
  const headers = Array.from({ length: 14 }, (_, index) => `X-Entry-${index}: value`);
  assert.equal((await post([filePart('report.txt', headers)])).status, 201);
  assert.equal((await post([filePart('report.txt', [...headers, 'X-Excess: value'])])).status, 400);
  const exact = filePart();
  exact.headers.push('X-Padding: ');
  const base = Buffer.byteLength(exact.headers.join('\r\n'));
  exact.headers[2] += 'x'.repeat(8192 - base);
  assert.equal((await post([exact])).status, 201);
  exact.headers[2] += 'x';
  assert.equal((await post([exact])).status, 400);
  const text = textPart(); text.headers.push(...Array.from({ length: 16 }, (_, index) => `X-Text-${index}: value`));
  assert.equal((await post([filePart(), text])).status, 400);
  const falseDelimiter = filePart(); falseDelimiter.body = 'prefix\r\n--bounded-upload-not-a-delimiter\r\nsuffix';
  const response = await post([falseDelimiter]);
  assert.equal(response.status, 400);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_attachments').get().n, 2);
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
  assert.equal((await response.json()).error, 'chat_upload_too_large');
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

test('authorized image downloads use inline sniffed MIME and retain the original bytes', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64');
  const upload = await f.request('/uploads', { method: 'POST', body: f.form(bytes, 'pixel.dat', 'application/octet-stream') });
  assert.equal(upload.status, 201);
  const item = await upload.json();
  const sent = await f.request('/send', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '', attachments: [item.id] }) });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).stored, true);
  const download = await f.request(`/attachments/${item.id}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'image/png');
  assert.match(download.headers.get('content-disposition'), /^inline;/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.equal(Buffer.compare(Buffer.from(await download.arrayBuffer()), bytes), 0);
  assert.equal((await f.request(`/attachments/${item.id}`, { identity: 'none' })).status, 403);
});

test('a first upload registers only the namespace and captures its watermark before body consumption', async t => {
  const f = await fixture(t);
  f.db.prepare('DELETE FROM channel_namespaces').run();
  f.addDuringBody();
  const response = await f.request('/uploads', { method: 'POST', body: f.form() });
  assert.equal(response.status, 201);
  const item = await response.json();
  const record = f.store.db.prepare('SELECT * FROM chat_attachments WHERE id=?').get(item.id);
  assert.equal(record.c4_watermark, 0);
  assert.equal(f.db.prepare('SELECT MAX(id) id FROM conversations').get().id, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM channel_namespaces').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM group_heads').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT namespace FROM chat_conversations').get().namespace, null);
});
