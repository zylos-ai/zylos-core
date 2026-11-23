import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
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

const MiB = 1024 * 1024;

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
  const pending = new Set();
  const server = http.createServer((req, res) => {
    const work = Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'fixture_failure' });
      else res.destroy();
    });
    pending.add(work);
    work.then(() => pending.delete(work));
  });
  server.keepAliveTimeout = 100;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}`,
    settle: () => waitFor(() => pending.size === 0) };
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
  fs.writeFileSync(path.join(targetRoot, '.env'), `DASHBOARD_MAX_UPLOAD_MB=${limit}\n`);
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
    if (slowConversation && req.method === 'GET' && /^\/api\/conversations\/[^/]+$/.test(url.pathname)) await delay(3500);
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
    await hub.settle(); await target.settle();
    await attachments.close(); store.close(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const route = `/api/conversations/${encodeURIComponent(draft.id)}`;
  const request = (suffix, { headers = {}, direct = false, conversation = draft.id, ...options } = {}) => {
    const base = direct ? target.origin : hub.origin + '/fleet/Target';
    return fetch(base + `/api/conversations/${encodeURIComponent(conversation)}` + suffix, {
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
    settle: async () => { await hub.settle(); await target.settle(); },
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

test('a target upload 401 is never replayed and a lost successful reply is explicitly unknown', async t => {
  const f = await fixture(t);
  f.setUploadStatus(401);
  const denied = await f.upload();
  assert.equal(denied.status, 401, JSON.stringify(denied.body)); assert.equal(f.uploads(), 1);
  assert.equal(f.forcedRefreshes(), 0);
  f.setUploadStatus(null); f.setDropReply(true);
  const lost = await f.upload();
  assert.equal(lost.status, 502); assert.equal(lost.body.error.code, 'upload_result_unknown');
  assert.equal(Object.hasOwn(lost.body, 'id'), false);
  assert.equal(f.uploads(), 2);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM chat_attachments').get().n, 1);
  assert.equal(f.hubMedia().length, 0);
});

test('download failures before headers are explicit and secret-bearing metadata or errors are blocked', async t => {
  const f = await fixture(t);
  f.setSynthetic((req, res) => sendJson(res, 404, { error: 'fixture_missing_file' }));
  const missing = await f.request('/attachments/transport-file');
  assert.equal(missing.status, 404); assert.equal((await missing.json()).error.code, 'fixture_missing_file');
  f.setSynthetic((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-fixture': 'read_session_token' }); res.end('safe bytes');
  });
  const headerLeak = await f.request('/attachments/transport-file');
  assert.equal(headerLeak.status, 502); assert.equal((await headerLeak.json()).error.code, 'secret_leak_blocked');
  f.setSynthetic((req, res) => sendJson(res, 403, { error: 'fixture-admin-a' }));
  const errorLeak = await f.request('/attachments/transport-file');
  assert.equal(errorLeak.status, 502); assert.equal((await errorLeak.json()).error.code, 'secret_leak_blocked');
  const compressed = gzipSync(Buffer.from('valid gzip must never be decompressed into a successful attachment'));
  f.setSynthetic((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip', 'content-length': compressed.length });
    res.end(compressed);
  });
  const encoded = await f.request('/attachments/transport-file');
  assert.equal(encoded.status, 502);
  assert.equal((await encoded.json()).error.code, 'unexpected_attachment_encoding');
});

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
    assert.equal(f.upstreamRequests.filter(row => row.method === 'GET' && /^\/api\/conversations\/[^/]+$/.test(row.path)).length, 0,
      'download never polls the reconciling conversation GET');
  });
}
