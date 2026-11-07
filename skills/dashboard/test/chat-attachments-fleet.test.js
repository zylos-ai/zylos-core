import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { ChatAttachments } from '../src/lib/chat/attachments.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { ChatSender } from '../src/lib/chat/send.js';
import { handleChatAttachments } from '../src/lib/chat/attachment-routes.js';
import { handleChatConversations } from '../src/lib/chat/write-routes.js';
import { FleetProxy } from '../src/lib/fleet-proxy.js';
import { sendJson } from '../src/lib/http.js';
import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../comm-bridge/scripts/c4-schema.js';
import { workbenchWriteRoutes } from './fixtures/workbench-write-routes.js';

const MiB = 1024 * 1024;
const boundary = 'fleet-file-boundary';
const opening = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="report.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function diskSnapshot(root, excluded = []) {
  const entries = [];
  const visit = directory => {
    for (const name of fs.readdirSync(directory).sort()) {
      const filename = path.join(directory, name);
      if (excluded.includes(filename)) continue;
      const stat = fs.lstatSync(filename), relative = path.relative(root, filename);
      if (stat.isDirectory()) { entries.push([relative, 'directory']); visit(filename); }
      else if (stat.isSymbolicLink()) entries.push([relative, 'link', fs.readlinkSync(filename)]);
      else entries.push([relative, stat.size, digest(fs.readFileSync(filename))]);
    }
  };
  visit(root);
  return entries;
}

async function waitFor(check, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'bounded transport condition timed out');
    await delay(10);
  }
}

async function listen(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'fixture_failure' });
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 100;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// Actual FleetProxy + target Store/ChatAttachments/ChatSender over two private
// loopback servers. Run for attachment relay, authorization or streaming changes;
// UI-only changes may skip. Auth and Core receive are fixture boundaries only.
// Official runner must isolate HOME/ZYLOS_DIR/PM2_HOME/TMPDIR before imports.
// No PM2, tmux, runtime, external host or live database is used. All sockets,
// timers, directories and SQLite handles are bound to this fixture's teardown.
async function fixture(t, { limit = 20 } = {}) {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key] && !process.env[key].startsWith(os.userInfo().homedir + path.sep), `${key} must be isolated`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-fleet-'));
  const targetRoot = path.join(root, 'target'), hubRoot = path.join(root, 'hub');
  fs.mkdirSync(path.join(targetRoot, 'comm-bridge'), { recursive: true });
  fs.mkdirSync(path.join(targetRoot, 'workspace'));
  fs.mkdirSync(path.join(hubRoot, 'components/dashboard/media'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, '.env'), `WEB_CONSOLE_MAX_UPLOAD_MB=${limit}\n`);
  console.log(JSON.stringify({ isolated: true, HOME: process.env.HOME, ZYLOS_DIR: targetRoot,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, hubRoot }));
  const db = new Database(path.join(targetRoot, 'comm-bridge/c4.db'));
  guardDatabase(db, schema);
  db.prepare("INSERT INTO channel_namespaces(namespace,component_name) VALUES('dash','dashboard')").run();
  const store = new Store(path.join(targetRoot, 'components/dashboard/dashboard.db'));
  const conversations = new ChatConversations({ store });
  const draft = conversations.create(), other = conversations.create();
  const c4Reader = { _open: () => db };
  const attachments = new ChatAttachments({ store, c4Reader, zylosDir: targetRoot });
  const targetConfig = { chat: { allowRemote: true } };
  let mode = 'multi', token = 'fixture-admin-a', localEnabled = true, uploadStatus = null;
  let uploads = 0, tokenCalls = 0, seenHeaders = null, downloadHeaders = null, dropReply = false;
  let synthetic = null, releaseUpload = null, slowUpload = false, uploadPaused = false;
  let rejectedToken = null, refreshedToken = 'fixture-refreshed', forcedRefreshes = 0, localChecks = 0;
  let slowConversation = false, corkDownload = false;
  const upstreamRequests = [], downloadResponses = [], checkTimes = [];
  const activeTimers = new Set();
  const timer = (fn, ms) => { const id = setTimeout(() => { activeTimers.delete(id); fn(); }, ms); activeTimers.add(id); return id; };
  const sender = new ChatSender({ conversations, c4Reader, attachments, zylosDir: targetRoot,
    loadCore: async () => ({ ensureChannelNamespace: () => ({ componentName: 'dashboard', namespace: 'dash' }),
      async receive(args) {
        const localId = args[args.indexOf('--endpoint') + 1], content = args[args.indexOf('--content') + 1];
        const row = db.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,session_group,content,status,delivery_action)
          VALUES('in','dashboard',?,?,?,'failed','suppressed')`).run(localId, `dash:${localId}`, content);
        return { ok: true, id: Number(row.lastInsertRowid), action: 'suppressed' };
      } }) });
  const auth = { enabled: true, resolveAuthContext(req) {
    const value = String(req.headers.authorization || '').replace(/^Bearer /, '');
    req._authContext = value.startsWith('fixture-') ? { kind: 'api', scope: value === 'fixture-read' ? 'read' : 'admin', principalId: value } : null;
    return req._authContext;
  } };
  const target = await listen(async (req, res) => {
    seenHeaders = req.headers;
    const url = new URL(req.url, 'http://target.test');
    upstreamRequests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization });
    if (rejectedToken && req.headers.authorization === `Bearer ${rejectedToken}`) {
      sendJson(res, 401, { error: 'expired_fixture_session' }); return;
    }
    if (slowConversation && req.method === 'GET' && /^\/api\/chat\/conversations\/[^/]+$/.test(url.pathname)) await delay(3500);
    if (url.pathname.includes('/attachments/')) downloadResponses.push(res);
    if (url.pathname.includes('/attachments/')) downloadHeaders = req.headers;
    if (corkDownload && url.pathname.includes('/attachments/')) {
      res.once('pipe', source => source.once('data', () => {
        setImmediate(() => { if (!res.destroyed) res.cork(); });
      }));
    }
    if (url.pathname.endsWith('/uploads') && req.method === 'POST') {
      uploads++;
      if (uploadStatus) { sendJson(res, uploadStatus, { error: 'fixture_upload_denied' }); return; }
      if (slowUpload) {
        req.pause(); uploadPaused = true;
        await new Promise(resolve => { releaseUpload = resolve; });
      }
      if (dropReply) {
        const original = res.end;
        res.end = function () { this.destroy(); return this; };
        res.once('close', () => { res.end = original; });
      }
    }
    if (synthetic && url.pathname.includes('/attachments/')) {
      synthetic(req, res, timer); return;
    }
    if (await handleChatAttachments(req, res, url, { auth, config: targetConfig, sender, attachments, readMode: () => mode })) return;
    if (await handleChatConversations(req, res, url, { auth, config: targetConfig, conversations, sender, readMode: () => mode })) return;
    sendJson(res, 404, { error: 'fixture_not_found' });
  });
  const hubConfig = { fleet: { agents: [{ name: 'Target', base_url: target.origin }] } };
  const proxy = new FleetProxy({ config: hubConfig, rootDir: hubRoot,
    authGate: { revalidateAuthContext: context => {
      localChecks++; checkTimes.push(Date.now()); return localEnabled ? context : null;
    } },
    poller: { getSessionToken: async (_name, options = {}) => {
      tokenCalls++; if (options.force) { forcedRefreshes++; token = refreshedToken; } return token;
    }, getAgentAccess: () => token === 'fixture-read' ? 'read' : 'admin' } });
  const hub = await listen(async (req, res) => {
    const who = req.headers['x-fixture-local'] || 'admin';
    req._authContext = who === 'none' ? null : { kind: 'cookie', scope: who === 'read' ? 'read' : 'admin', principalId: who };
    await proxy.handle(req, res, new URL(req.url, 'http://hub.test'));
  });
  t.after(async () => {
    releaseUpload?.();
    for (const id of activeTimers) clearTimeout(id);
    hub.server.closeAllConnections(); target.server.closeAllConnections();
    await Promise.all([new Promise(resolve => hub.server.close(resolve)), new Promise(resolve => target.server.close(resolve))]);
    await attachments.close(); store.close(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const route = `/api/chat/conversations/${encodeURIComponent(draft.id)}`;
  const request = (suffix, { headers = {}, direct = false, conversation = draft.id, ...options } = {}) => {
    const base = direct ? target.origin : hub.origin + '/fleet/Target';
    return fetch(base + `/api/chat/conversations/${encodeURIComponent(conversation)}` + suffix, {
      ...options, signal: AbortSignal.timeout(10000), headers: { origin: hub.origin,
        ...(direct ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  };
  const upload = async (bytes = Buffer.from('target bytes'), { name = 'report.bin', ...options } = {}) => {
    const body = new FormData(); body.append('file', new Blob([bytes]), name);
    const response = await request('/uploads', { method: 'POST', body, ...options });
    return { status: response.status, body: await response.json() };
  };
  const send = async (id, options = {}) => {
    const response = await request('/send', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'attachment', attachments: [id] }), ...options });
    return { status: response.status, body: await response.json() };
  };
  return { root, targetRoot, hubRoot, target, hub, route, draft, other, attachments, store, db, proxy,
    request, upload, send, timer, setToken: value => { token = value; }, setMode: value => { mode = value; },
    setLocalEnabled: value => { localEnabled = value; }, targetConfig,
    setUploadStatus: value => { uploadStatus = value; }, setDropReply: value => { dropReply = value; },
    setSynthetic: value => { synthetic = value; }, setSlowUpload: value => { slowUpload = value; },
    uploadPaused: () => uploadPaused, releaseUpload: () => releaseUpload?.(),
    expireToken: () => { rejectedToken = token; }, forcedRefreshes: () => forcedRefreshes,
    upstreamRequests, downloadResponses, localChecks: () => localChecks, checkTimes,
    setSlowConversation: value => { slowConversation = value; },
    setCorkDownload: value => { corkDownload = value; },
    diskSnapshot: tmpRoot => ({ tmp: diskSnapshot(tmpRoot), hub: diskSnapshot(hubRoot) }),
    uploads: () => uploads, tokenCalls: () => tokenCalls, headers: () => seenHeaders, downloadHeaders: () => downloadHeaders,
    media: () => fs.readdirSync(attachments.mediaDir), hubMedia: () => fs.readdirSync(path.join(hubRoot, 'components/dashboard/media')) };
}

function openUpload(t, f, extraHeaders = {}) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(f.hub.origin + '/fleet/Target' + f.route + '/uploads', { method: 'POST',
      headers: { origin: f.hub.origin, 'content-type': `multipart/form-data; boundary=${boundary}`, ...extraHeaders } }, res => {
      const chunks = []; let count = 0;
      res.on('data', chunk => { count += chunk.length; if (count > 8192) res.destroy(); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject); request.setTimeout(10000, () => request.destroy(new Error('bounded upload timeout')));
  });
  response.catch(() => {}); t.after(() => request.destroy());
  request.write(opening);
  return { request, response };
}

async function openDownload(t, f, suffix) {
  let request;
  const response = await new Promise((resolve, reject) => {
    request = http.get(f.hub.origin + '/fleet/Target' + f.route + suffix, resolve);
    request.once('error', reject);
    request.setTimeout(4000, () => request.destroy(new Error('bounded real download timeout')));
  });
  t.after(() => request.destroy());
  response.on('error', () => {});
  return response;
}

const isDownloadAbort = error => ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code) || error.message === 'aborted';

test('target key and conversation own pending attachments while known IDs share only the same key and group', async t => {
  const f = await fixture(t), uploaded = await f.upload();
  assert.equal(uploaded.status, 201);
  assert.equal((await f.request('/attachments/' + uploaded.body.id)).status, 404);
  assert.equal((await f.send(uploaded.body.id, { conversation: f.other.id })).status, 404);
  f.setToken('fixture-admin-b');
  assert.equal((await f.send(uploaded.body.id)).status, 404);
  f.setToken('fixture-admin-a');
  assert.equal((await f.send(uploaded.body.id, { headers: { 'content-type': 'application/json', 'x-fixture-local': 'second-admin' } })).status, 200);
  const downloaded = await f.request('/attachments/' + uploaded.body.id);
  assert.equal(downloaded.status, 200); assert.equal(await downloaded.text(), 'target bytes');
  assert.equal(f.headers().cookie, undefined);
  assert.equal(f.headers().authorization, 'Bearer fixture-admin-a');
  assert.equal(f.hubMedia().length, 0);
});

test('both permission gates, target mode and group ownership reject before publishing files', async t => {
  const f = await fixture(t);
  for (const local of ['none', 'read']) assert.equal((await f.upload(undefined, { headers: { 'x-fixture-local': local } })).status, 403);
  assert.equal(f.uploads(), 0);
  f.targetConfig.chat.allowRemote = false;
  assert.equal((await f.upload()).status, 403);
  f.targetConfig.chat.allowRemote = true; f.setToken('fixture-read');
  assert.equal((await f.upload()).status, 403);
  f.setToken('fixture-admin-a'); f.setMode('single');
  assert.equal((await f.upload()).status, 403);
  f.setMode('multi');
  assert.equal((await f.upload(undefined, { conversation: 'g:646173683A666F726569676E' })).status, 404);
  assert.equal(f.media().length, 0); assert.equal(f.hubMedia().length, 0);
});

test('cookie writes require same origin and neither cookies nor caller authorization reach the target', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload(undefined, { headers: { origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal((await f.upload(undefined, { headers: { origin: '' } })).status, 403);
  assert.equal(f.uploads(), 0);
  assert.equal((await f.upload(undefined, { headers: { cookie: 'fixture-browser=private', authorization: 'Bearer browser-only' } })).status, 201);
  assert.equal(f.headers().cookie, undefined);
  assert.equal(f.headers().authorization, 'Bearer fixture-admin-a');
});

test('config and downloads require both data gates while downloading remains valid outside multi mode', async t => {
  const f = await fixture(t), uploaded = await f.upload();
  assert.equal(uploaded.status, 201); assert.equal((await f.send(uploaded.body.id)).status, 200);
  const suffix = '/attachments/' + uploaded.body.id;
  for (const local of ['none', 'read']) {
    assert.equal((await f.request('/uploads/config', { headers: { 'x-fixture-local': local } })).status, 403);
    assert.equal((await f.request(suffix, { headers: { 'x-fixture-local': local } })).status, 403);
  }
  f.targetConfig.chat.allowRemote = false;
  assert.equal((await f.request('/uploads/config')).status, 403);
  assert.equal((await f.request(suffix)).status, 403);
  f.targetConfig.chat.allowRemote = true; f.setToken('fixture-read');
  assert.equal((await f.request('/uploads/config')).status, 403);
  assert.equal((await f.request(suffix)).status, 403);
  f.setToken('fixture-admin-a'); f.setMode('single');
  assert.equal((await f.request('/uploads/config')).status, 403);
  const downloaded = await f.request(suffix);
  assert.equal(downloaded.status, 200); assert.equal(await downloaded.text(), 'target bytes');
});

test('twenty MiB is streamed only to target media and downloaded byte-for-byte with true length and identity', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(20 * MiB, 0x93);
  const tmpRoot = path.join(f.root, 'proxy-tmp');
  fs.mkdirSync(tmpRoot);
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = tmpRoot;
  t.after(() => {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
  });
  const before = f.diskSnapshot(tmpRoot);
  for (let i = 0; i < bytes.length; i += 4093) bytes[i] = i % 251;
  const uploaded = await f.upload(bytes);
  assert.equal(uploaded.status, 201); assert.equal(uploaded.body.size, bytes.length);
  assert.equal(f.hubMedia().length, 0); assert.equal(f.media().length, 1);
  assert.equal((await f.send(uploaded.body.id)).status, 200);
  const response = await f.request('/attachments/' + uploaded.body.id);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(f.downloadHeaders()['accept-encoding'], 'identity');
  const hash = createHash('sha256'); let count = 0, largest = 0;
  for await (const chunk of response.body) { count += chunk.length; largest = Math.max(largest, chunk.length); hash.update(chunk); }
  assert.equal(count, bytes.length); assert.equal(hash.digest('hex'), digest(bytes));
  assert.ok(largest < MiB, 'download arrives in bounded chunks');
  assert.deepEqual(f.diskSnapshot(tmpRoot), before, 'proxy creates or changes no files in its private TMPDIR or hub root');
});

test('Unicode filenames survive real fleet uploads and direct and fleet downloads', async t => {
  for (const name of ['报告.pdf', '😀.bin', 'résumé.pdf']) await t.test(name, async t => {
    const f = await fixture(t), bytes = Buffer.alloc(2048, 0x93);
    const uploaded = await f.upload(bytes, { name });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.body.name, name); assert.equal(uploaded.body.size, bytes.length);
    const row = f.store.db.prepare('SELECT * FROM chat_attachments WHERE id=?').get(uploaded.body.id);
    assert.equal(digest(fs.readFileSync(path.join(f.attachments.mediaDir, row.storage_name))), digest(bytes));
    assert.equal((await f.send(uploaded.body.id)).status, 200);
    for (const direct of [true, false]) {
      const downloaded = await f.request('/attachments/' + uploaded.body.id, { direct });
      assert.equal(downloaded.status, 200);
      const header = downloaded.headers.get('content-disposition');
      assert.match(header, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
      assert.equal(decodeURIComponent(header.split("filename*=UTF-8''")[1]), name);
      assert.equal(digest(Buffer.from(await downloaded.arrayBuffer())), digest(bytes));
    }
  });
});

test('chunked uploads grow target partial files before completion and disconnect cleans both sides', async t => {
  const f = await fixture(t), stream = openUpload(t, f);
  stream.request.write(Buffer.alloc(65536, 65));
  await waitFor(() => f.media().some(name => name.endsWith('.part') && fs.statSync(path.join(f.attachments.mediaDir, name)).size > 0));
  assert.equal(f.hubMedia().length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM chat_attachments').get().n, 0);
  stream.request.destroy(); await assert.rejects(stream.response);
  await waitFor(() => f.media().length === 0);
});

test('target file limit and total multipart overhead reject known and chunked excess without files', async t => {
  const f = await fixture(t, { limit: 1 });
  assert.equal((await f.upload(Buffer.alloc(MiB + 1))).status, 413);
  const stream = openUpload(t, f);
  stream.request.end(Buffer.alloc(MiB + 65537));
  const result = await stream.response;
  assert.equal(result.status, 413); assert.equal(Object.hasOwn(result.body, 'id'), false);
  await waitFor(() => f.media().length === 0);
  assert.equal(f.hubMedia().length, 0);
});

test('known total length above target allowance is rejected before a body or upload reaches the target', async t => {
  const f = await fixture(t, { limit: 1 });
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(f.hub.origin + '/fleet/Target' + f.route + '/uploads', { method: 'POST', headers: {
      origin: f.hub.origin, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': MiB + 65537,
    } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode)); res.once('error', reject);
    });
    request.once('error', reject);
    request.setTimeout(4000, () => request.destroy(new Error('header-only rejection timed out')));
    request.flushHeaders();
  });
  t.after(() => request.destroy());
  assert.equal(await response, 413);
  assert.equal(f.uploads(), 0); assert.equal(f.media().length, 0);
  assert.equal(f.hubMedia().length, 0);
});

test('multipart fields, headers and UTF-8 names retain target bounds with a valid boundary positive', async t => {
  const f = await fixture(t, { limit: 1 });
  const file = headers => `--${boundary}\r\n${headers.join('\r\n')}\r\n\r\nfile\r\n--${boundary}--\r\n`;
  const disposition = name => `Content-Disposition: form-data; name="file"; filename="${name}"`;
  const cases = [
    Array.from({ length: 9 }, (_, i) => `--${boundary}\r\nContent-Disposition: form-data; name="field${i}"\r\n\r\nx\r\n`).join('') + opening + 'file' + ending,
    `--${boundary}\r\nContent-Disposition: form-data; name="label"\r\n\r\n${'x'.repeat(1025)}\r\n` + opening + 'file' + ending,
    file([disposition('report.bin'), ...Array.from({ length: 16 }, (_, i) => `X-Field-${i}: value`)]),
    file([disposition('report.bin'), `X-Long: ${'x'.repeat(8193)}`]),
    file([disposition('é'.repeat(128))]),
    `--${boundary}\r\nContent-Disposition: form-data; name="${'é'.repeat(128)}"\r\n\r\nx\r\n` + opening + 'file' + ending,
  ];
  for (const body of cases) {
    const response = await f.request('/uploads', { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
    assert.equal(response.status, 400);
    await response.arrayBuffer();
    await waitFor(() => f.media().length === 0);
  }
  const fields = Array.from({ length: 8 }, (_, i) => `--${boundary}\r\nContent-Disposition: form-data; name="field${i}"\r\n\r\n${'x'.repeat(1024)}\r\n`).join('');
  const valid = fields + file([disposition('é'.repeat(125) + '.bin'), ...Array.from({ length: 15 }, (_, i) => `X-Field-${i}: value`)]);
  const response = await f.request('/uploads', { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: valid });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).size, 4);
  assert.equal(f.hubMedia().length, 0);
});

test('a target upload 401 is never replayed and a lost successful reply is explicitly unknown', async t => {
  const f = await fixture(t);
  f.setUploadStatus(401);
  const denied = await f.upload();
  assert.equal(denied.status, 401); assert.equal(f.uploads(), 1);
  assert.equal(f.forcedRefreshes(), 0);
  f.setUploadStatus(null); f.setDropReply(true);
  const lost = await f.upload();
  assert.equal(lost.status, 502); assert.equal(lost.body.error, 'upload_result_unknown');
  assert.equal(Object.hasOwn(lost.body, 'id'), false);
  assert.equal(f.uploads(), 2);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM chat_attachments').get().n, 1);
  assert.equal(f.hubMedia().length, 0);
});

test('expired tokens refresh once for safe config preflight and download GETs', async t => {
  const f = await fixture(t);
  f.expireToken();
  const uploaded = await f.upload();
  assert.equal(uploaded.status, 201); assert.equal(f.forcedRefreshes(), 1);
  const configs = f.upstreamRequests.filter(row => row.path.endsWith('/uploads/config'));
  assert.equal(configs.length, 2);
  assert.equal(configs[0].authorization, 'Bearer fixture-admin-a');
  assert.equal(configs[1].authorization, 'Bearer fixture-refreshed');
  assert.equal(f.uploads(), 1);
  assert.equal((await f.send(uploaded.body.id)).status, 200);
  // Use a different fresh key to prove the retry does not retain the expired
  // bearer. Linked downloads are authorized by visibility, not the upload key.
  f.setToken('fixture-download-expired'); f.expireToken();
  const response = await f.request('/attachments/' + uploaded.body.id);
  assert.equal(response.status, 200); assert.equal(await response.text(), 'target bytes');
  assert.equal(f.forcedRefreshes(), 2);
  const downloads = f.upstreamRequests.filter(row => row.path.includes('/attachments/'));
  assert.equal(downloads.length, 2);
  assert.equal(downloads[0].authorization, 'Bearer fixture-download-expired');
  assert.equal(downloads[1].authorization, 'Bearer fixture-refreshed');
  f.expireToken();
  const beforeRetry = f.upstreamRequests.length;
  assert.equal((await f.upload()).status, 401);
  assert.equal(f.forcedRefreshes(), 3); assert.equal(f.uploads(), 1);
  assert.equal(f.upstreamRequests.slice(beforeRetry).filter(row => row.path.endsWith('/uploads/config')).length, 2);
  const beforeDownloadRetry = f.upstreamRequests.length;
  const denied = await f.request('/attachments/' + uploaded.body.id);
  assert.equal(denied.status, 401); await denied.arrayBuffer();
  assert.equal(f.forcedRefreshes(), 4);
  assert.equal(f.upstreamRequests.slice(beforeDownloadRetry).filter(row => row.path.includes('/attachments/')).length, 2);
});

test('ordinary writes retain their one MiB limit while exact attachment uploads are allowlisted', async t => {
  const f = await fixture(t);
  const response = await f.request('/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(MiB + 1) });
  assert.equal(response.status, 413);
  const before = f.upstreamRequests.length;
  for (const suffix of ['/uploads/extra', '/uploads/config', '/attachments/x', '/foo']) {
    const forbidden = await f.request(suffix, { method: 'POST', body: 'x' });
    assert.equal(forbidden.status, 403);
  }
  assert.equal(f.upstreamRequests.length, before, 'unregistered writes never reach the target');
  const registered = workbenchWriteRoutes.find(route => route.attachment);
  assert.equal(registered.method, 'POST');
  assert.match(registered.path, /\/api\/chat\/conversations\/[^/]+\/uploads$/);
  const upload = await f.request('/uploads', { method: registered.method,
    headers: { 'content-type': registered.contentType }, body: registered.body });
  assert.equal(upload.status, 201);
  assert.equal((await upload.json()).size, 4);
});

test('a slow target bounds upstream progress and backpressure reaches a chunked upload', async t => {
  const f = await fixture(t, { limit: 20 }); f.setSlowUpload(true);
  const stream = openUpload(t, f), chunk = Buffer.alloc(65536, 66), total = 20 * MiB;
  let produced = 0, drains = 0;
  const producing = (async () => {
    while (produced < total) {
      produced += chunk.length;
      if (!stream.request.write(chunk)) { drains++; await once(stream.request, 'drain'); }
    }
    stream.request.end(ending);
  })();
  producing.catch(() => {});
  await waitFor(() => f.uploadPaused());
  await delay(200);
  assert.ok(produced < total, 'a stalled target prevents the source completing the whole upload');
  assert.ok(drains > 0);
  assert.equal(f.media().length, 0);
  f.releaseUpload();
  await producing;
  assert.equal((await stream.response).status, 201);
  assert.equal(f.hubMedia().length, 0);
});

test('hub files cannot substitute target bytes and unlinked agent copies use the same protected route', async t => {
  const f = await fixture(t), uploaded = await f.upload();
  assert.equal((await f.send(uploaded.body.id)).status, 200);
  const row = f.store.db.prepare('SELECT * FROM chat_attachments WHERE id=?').get(uploaded.body.id);
  fs.writeFileSync(path.join(f.hubRoot, 'components/dashboard/media', row.storage_name), 'wrong hub bytes');
  assert.equal(await (await f.request('/attachments/' + row.id)).text(), 'target bytes');
  const source = path.join(f.targetRoot, 'workspace', 'agent.bin'); fs.writeFileSync(source, 'agent target copy');
  const registered = await f.attachments.register(f.draft.localId, { kind: 'file', path: source });
  fs.unlinkSync(source);
  assert.equal(fs.readFileSync(f.attachments.resolve(f.draft.localId, registered.attachmentId), 'utf8'), 'agent target copy');
  assert.equal((await f.request('/attachments/' + registered.attachmentId)).status, 404);
  assert.equal((await f.send(registered.attachmentId)).status, 404);
  // A linked agent positive requires the outbound attachment schema. It stays
  // unverified here; a forged link or unsupported envelope would hide that gap.
});

test('unknown-length downloads make progress before upstream completion and honor downstream backpressure', async t => {
  const f = await fixture(t), chunk = Buffer.alloc(65536, 0x95), total = 64 * MiB;
  let produced = 0, ended = false, targetBlocked = false;
  f.setSynthetic(async (req, res) => {
    const control = new AbortController();
    const closed = () => control.abort();
    res.once('close', closed);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    try {
      while (produced < total) {
        produced += chunk.length;
        if (!res.write(chunk)) { targetBlocked = true; await once(res, 'drain', { signal: control.signal }); }
      }
      ended = true; res.end();
    } catch { /* Teardown closes stalled sockets if an assertion fails. */ }
    finally { res.removeListener('close', closed); }
  });
  let request;
  const response = await new Promise((resolve, reject) => {
    request = http.get(f.hub.origin + '/fleet/Target' + f.route + '/attachments/transport-file', resolve);
    request.once('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('download progress timed out')));
  });
  t.after(() => request.destroy());
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-length'], undefined);
  response.pause();
  await delay(200);
  assert.equal(ended, false, 'response headers arrive while target is still producing');
  assert.ok(produced < total, 'paused downstream bounds upstream progress instead of buffering the file');
  assert.equal(targetBlocked, true);
  const hash = createHash('sha256'); let count = 0;
  for await (const bytes of response) { count += bytes.length; hash.update(bytes); }
  const expected = createHash('sha256');
  for (let count = 0; count < total; count += chunk.length) expected.update(chunk);
  assert.equal(ended, true); assert.equal(count, total);
  assert.equal(hash.digest('hex'), expected.digest('hex'));
});

test('download failures before headers are explicit and secret-bearing metadata or errors are blocked', async t => {
  const f = await fixture(t);
  f.setSynthetic((req, res) => sendJson(res, 404, { error: 'fixture_missing_file' }));
  const missing = await f.request('/attachments/transport-file');
  assert.equal(missing.status, 404); assert.equal((await missing.json()).error, 'fixture_missing_file');
  f.setSynthetic((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-fixture': 'read_session_token' }); res.end('safe bytes');
  });
  const headerLeak = await f.request('/attachments/transport-file');
  assert.equal(headerLeak.status, 502); assert.equal((await headerLeak.json()).error, 'secret_leak_blocked');
  f.setSynthetic((req, res) => sendJson(res, 403, { error: 'fixture-admin-a' }));
  const errorLeak = await f.request('/attachments/transport-file');
  assert.equal(errorLeak.status, 502); assert.equal((await errorLeak.json()).error, 'secret_leak_blocked');
  const compressed = gzipSync(Buffer.from('valid gzip must never be decompressed into a successful attachment'));
  f.setSynthetic((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip', 'content-length': compressed.length });
    res.end(compressed);
  });
  const encoded = await f.request('/attachments/transport-file');
  assert.equal(encoded.status, 502);
  assert.equal((await encoded.json()).error, 'unexpected_attachment_encoding');
});

for (const failure of ['disconnect', 'short', 'sensitive']) {
  test(`${failure === 'short' ? 'HTTP-truncated content-length' : failure} after download headers destroys the client response`, async t => {
    const f = await fixture(t);
    f.setSynthetic((req, res, timer) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', ...(failure === 'short' ? { 'content-length': '65536' } : {}) });
      res.write(Buffer.alloc(8192, 67));
      timer(() => {
        if (failure === 'sensitive') {
          res.write(Buffer.from(' read_api_'));
          timer(() => { res.write(Buffer.from('key ')); res.end(Buffer.alloc(8192, 68)); }, 20);
        } else if (failure === 'short') res.end(Buffer.alloc(1024));
        else res.destroy();
      }, 30);
    });
    const response = await openDownload(t, f, '/attachments/transport-file');
    assert.equal(response.statusCode, 200);
    let received = 0;
    await assert.rejects(async () => { for await (const chunk of response) received += chunk.length; }, isDownloadAbort);
    assert.ok(received < 65536);
  });
}

for (const side of ['target', 'local']) {
  test(`revoking ${side} access interrupts a real attachment download within three seconds`, async t => {
    const f = await fixture(t), uploaded = await f.upload(Buffer.alloc(20 * MiB, 0x95));
    assert.equal(uploaded.status, 201); assert.equal((await f.send(uploaded.body.id)).status, 200);
    // Cork the native target response after its first chunk so kernel buffer
    // sizes cannot turn the byte bound into a machine-dependent assertion.
    // The actual file route, stream and access checks remain in the pipeline.
    f.setSlowConversation(true);
    f.setCorkDownload(true);
    const response = await openDownload(t, f, '/attachments/' + uploaded.body.id);
    response.pause();
    assert.equal(response.statusCode, 200);
    await delay(150);
    assert.equal(f.downloadResponses.length, 1);
    assert.equal(f.downloadResponses[0].writableFinished, false, 'target is still serving the real file when access is revoked');
    const started = Date.now();
    if (side === 'target') f.targetConfig.chat.allowRemote = false; else f.setLocalEnabled(false);
    await delay(1050);
    f.downloadResponses[0].uncork();
    let received = 0;
    await assert.rejects(async () => { for await (const chunk of response) received += chunk.length; }, isDownloadAbort);
    assert.ok(received < 10 * MiB, `revocation stops the stream before ten MiB, received ${received}`);
    assert.ok(Date.now() - started < 3000, 'revocation fails before a request timeout could masquerade as enforcement');
    await waitFor(() => f.downloadResponses[0].destroyed);
    assert.equal(f.upstreamRequests.filter(row => row.method === 'GET' && /^\/api\/chat\/conversations\/[^/]+$/.test(row.path)).length, 0,
      'download never polls the reconciling conversation GET');
  });
}

test('local session revalidation is time bounded and slow unrelated conversation reads cannot abort downloads', async t => {
  const f = await fixture(t);
  f.setSlowConversation(true);
  f.setSynthetic((req, res, timer) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    let count = 0;
    const write = () => {
      if (res.destroyed) return;
      res.write(Buffer.alloc(4096, 0x95));
      if (++count === 130) res.end(); else timer(write, 20);
    };
    write();
  });
  const baseline = f.localChecks(), started = Date.now();
  const response = await f.request('/attachments/transport-file');
  assert.equal(response.status, 200);
  let bytes = 0;
  for await (const chunk of response.body) bytes += chunk.length;
  assert.equal(bytes, 130 * 4096);
  const elapsed = Date.now() - started, checks = f.localChecks() - baseline;
  assert.ok(checks >= 2, 'a long download continues to revalidate its local session');
  assert.ok(checks <= Math.floor(elapsed / 1000) + 1, `revalidation count ${checks} is bounded by elapsed time ${elapsed}ms`);
  const times = f.checkTimes.slice(baseline);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 1000, 'no more than one local session check per second');
  assert.equal(f.upstreamRequests.filter(row => row.method === 'GET' && /^\/api\/chat\/conversations\/[^/]+$/.test(row.path)).length, 0);
});

test('literal credential field words are downloadable locally but blocked by fleet', async t => {
  for (const word of ['read_api_key', 'read_session_token']) {
    const f = await fixture(t);
    const uploaded = await f.upload(Buffer.from('ordinary prose ' + word));
    assert.equal(uploaded.status, 201); assert.equal((await f.send(uploaded.body.id)).status, 200);
    const local = await f.request('/attachments/' + uploaded.body.id, { direct: true });
    assert.equal(local.status, 200); assert.equal(await local.text(), 'ordinary prose ' + word);
    const remote = await f.request('/attachments/' + uploaded.body.id);
    if (remote.status === 200) await assert.rejects(() => remote.arrayBuffer());
    else { assert.equal(remote.status, 502); assert.equal((await remote.json()).error, 'secret_leak_blocked'); }
  }
});
