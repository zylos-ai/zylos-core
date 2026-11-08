import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Store } from '../../src/lib/store.js';
import { AuthGate } from '../../src/lib/auth.js';
import { C4Reader } from '../../src/lib/c4-reader.js';
import { ChatHistory } from '../../src/lib/chat/history.js';
import { ChatChangeObserver } from '../../src/lib/chat/change-observer.js';
import { SseHub } from '../../src/lib/sse.js';
import { handleChatStream } from '../../src/lib/chat/stream.js';
import { handleChatHistory } from '../../src/lib/chat/history-routes.js';
import { requireChatAccess } from '../../src/lib/chat/access.js';
import { migrateSchema } from '../../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../../comm-bridge/scripts/c4-migrations-v2.js';
import { CONTENT_PREFIX } from '../../../comm-bridge/scripts/c4-content-schema.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const schemaFile = fileURLToPath(new URL('../../../comm-bridge/scripts/c4-content-schema.js', import.meta.url));
const group = 'dash-browser:push', conversationId = 'g:' + Buffer.from(group).toString('hex').toUpperCase();
const protocol = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url)));
const envelope = structuredClone(protocol.valid.find(row => row.envelope?.blocks?.some(block => block.type === 'form_intent')).envelope);
envelope.messageId = 'private-browser-form'; envelope.interruptId = 'private-browser-interrupt';
const question = { c4Id: '61', messageId: envelope.messageId, interruptId: envelope.interruptId,
  questionSummary: envelope.questionSummary, constraints: { block: envelope.blocks[0], interrupt: envelope.interrupt },
  status: 'paused', answerId: null, action: null, actionError: null, delivery: null };

export async function createChatPushBrowserFixture(sandbox, { legacyHub = null } = {}) {
  console.info('chat push browser private targets', JSON.stringify(sandbox.assertIsolation()), 'model/PM2/tmux unused');
  const writer = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
  migrateSchema(writer, { isNew: true }); migrateToV2(writer); writer.pragma('journal_mode = WAL');
  writer.prepare('INSERT INTO channel_namespaces VALUES (?,?)').run('dash-browser', 'dashboard');
  const store = sandbox.openDatabase(sandbox.paths.dashboardDb, filename => new Store(filename));
  const reader = new C4Reader(sandbox.paths.zylos), history = new ChatHistory({ c4Reader: reader });
  const hub = new (legacyHub || SseHub)(1000), observer = new ChatChangeObserver({ c4Reader: reader, history });
  const config = { auth: { enabled: true, password: 'scrypt:private-browser-fixture' }, chat: { allowRemote: false } };
  const cookie = crypto.randomBytes(32).toString('hex');
  store.insertSession(crypto.createHash('sha256').update(cookie).digest('hex'), Date.now());
  const auth = new AuthGate(config, store);
  const insert = writer.prepare(`INSERT INTO conversations (id,timestamp,direction,channel,endpoint_id,session_group,content,status)
    VALUES (@id,@timestamp,@direction,'dashboard','push',@group,@content,@status)`);
  let nextId = 1;
  const add = (content, { direction = 'out', status = 'delivered', id = nextId++ } = {}) => {
    nextId = Math.max(nextId, id + 1);
    insert.run({ id, timestamp: new Date().toISOString(), direction, group, content, status }); return id;
  };
  writer.transaction(() => {
    for (let i = 1; i <= 60; i++) add(`Earlier message ${i}: readable history to preserve scrolling.\n旧消息 ${i}：向上阅读时保留位置。`, { id: i });
    add(CONTENT_PREFIX + JSON.stringify(envelope), { id: 61 });
  })();
  let pendingId = add('Please update delivery automatically. / 请自动更新投递状态。', { direction: 'in', status: 'pending' });
  let streamsAllowed = true, streamFailureStatus = 503;
  const requests = [], events = [];
  const sendTo = hub.sendTo?.bind(hub);
  if (sendTo) hub.sendTo = (client, name, data) => {
    if (events.length < 100) events.push({ name, data, at: Date.now() });
    return sendTo(client, name, data);
  };
  const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const html = locale => `<!doctype html><html lang="${locale}" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat push private browser</title>
<link rel="stylesheet" href="/themes/light.css"><link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/wb.css"><link rel="stylesheet" href="/css/wb-icons.css"><link rel="stylesheet" href="/css/conversation.css">
<style>body{margin:0;font-family:system-ui;background:var(--bg)}header{height:48px;padding:8px 16px;box-sizing:border-box;border-bottom:1px solid var(--wb-line);font-weight:600;font-size:12px;line-height:16px}#wb-chat{height:calc(100vh - 48px);padding:0}</style>
<header>${locale === 'en' ? 'Dashboard · Private SQLite + SSE fixture (no model)' : 'Dashboard · 私有 SQLite + SSE 验证（无模型）'}</header><main id="wb-chat"></main>
<script type="module">
import { mountConversationPage } from '/js/wb/conversation-page.js';
import { createConversationPush } from '/js/wb/conversation-push.js';
const words=await (await fetch('/i18n/wb.${locale}.json')).json();
let page,source,retry,ticket=0;window.connections=0;window.pageId=crypto.randomUUID();
const connect=()=>{clearTimeout(retry);source?.close();push.detach();const current=new EventSource(push.streamUrl('/api/stream'));source=current;window.connections++;push.attach(current);current.onerror=()=>{if(source!==current)return;current.close();source=null;push.detach();retry=setTimeout(connect,1000);};};
const push=createConversationPush({onSubscriptionChange:()=>{const own=++ticket;queueMicrotask(()=>{if(own===ticket)connect();});},onStatus:status=>page?.streamStatus(status),onEvent:(name,data,subscription)=>page?.streamEvent(name,data,subscription)});
page=mountConversationPage({root:document.querySelector('#wb-chat'),identity:'private-push',t:key=>words[key]??key,storage:null,
fetch:(url,options={})=>fetch(url,{...options,headers:{...options.headers,'X-Fixture-Page':window.pageId}}),onStreamSubscription:sub=>push.setSubscription(sub)});
window.page=page;window.dispose=()=>{clearTimeout(retry);source?.close();push.destroy();page.destroy();};
await page.openGroup(${JSON.stringify(group)},{channel:'dashboard'});window.ready=true;
</script></html>`;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `__Secure-zylos_dashboard_session=${cookie}; Path=/; Secure; HttpOnly; SameSite=Strict`,
          'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" });
        return res.end(html(url.searchParams.get('locale') === 'zh' ? 'zh' : 'en'));
      }
      if (url.pathname.startsWith('/api/')) {
        if (requests.length >= 300) return json(res, { error: 'fixture_request_limit' }, 503);
        requests.push({ path: url.pathname, query: url.search, method: req.method, page: req.headers['x-fixture-page'] ?? null, at: Date.now() });
        if (url.pathname === '/api/stream' && !streamsAllowed) return json(res, { error: 'private_stream_outage' }, streamFailureStatus);
        if (url.pathname === '/api/stream' && legacyHub) {
          const denied = requireChatAccess(req, auth, config);
          if (denied) return json(res, { error: denied.error }, denied.status);
          hub.addClient(res, () => !requireChatAccess(req, auth, config));
          res.write('event: state_change\ndata: {"state":"idle"}\n\n');
          return;
        }
        if (await handleChatStream(req, res, url, { auth, config, hub, observer })) return;
        const denied = requireChatAccess(req, auth, config);
        if (denied) return json(res, { error: denied.error }, denied.status);
        if (req.method === 'POST' && url.pathname.endsWith('/send')) {
          let body = '';
          for await (const chunk of req) {
            body += chunk.toString();
            if (Buffer.byteLength(body) > 16384) return json(res, { error: 'fixture_body_limit' }, 413);
          }
          const content = JSON.parse(body).content;
          pendingId = add(content, { direction: 'in', status: 'pending' });
          return json(res, { stored: true, conversationId, deliveryState: 'pending' });
        }
        if (await handleChatHistory(req, res, url, { auth, config, history })) return;
        if (url.pathname === '/api/session-mode') return json(res, { data: { sessionMode: 'multi' } });
        if (url.pathname.endsWith('/questions')) return json(res, { items: [question], nextCursor: null });
        if (url.pathname.endsWith('/uploads/config')) return json(res, { enabled: false });
        if (url.pathname === '/api/workbench/groups') return json(res, { listKnown: false, rows: [] });
        if (url.pathname === '/api/chat/conversations/' + encodeURIComponent(conversationId)) return json(res, { conversation: { id: conversationId, sessionGroup: group, channel: 'dashboard', displayName: 'Live conversation / 实时对话', state: 'active' }, conversationId, stored: true });
        return json(res, { error: 'fixture_unknown_endpoint' }, 404);
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const file = url.pathname === '/chat-schema.js' ? schemaFile : path.resolve(publicDir, '.' + url.pathname);
      if (file !== schemaFile && !file.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end(); }
      try { res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream' }); res.end(fs.readFileSync(file)); }
      catch { res.writeHead(404); res.end(); }
    } catch (error) { json(res, { error: error.code || 'fixture_error' }, error.statusCode || 500); }
  });
  const origin = await sandbox.startHttp(server);
  sandbox.addCleanup(() => { observer.close(); hub.closeAll(); reader.close(); clearInterval(auth._cleanupTimer); });
  return { origin, writer, reader, history, hub, observer, requests, events, group, conversationId, pendingId,
    deliverAndReply(label = 'New AI reply / 新 AI 回复') {
      let id;
      writer.transaction(() => { writer.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(pendingId); id = add(label); })();
      return { id, committedAt: Date.now(), pendingId };
    }, addReply(label) { const id = add(label); return { id, committedAt: Date.now() }; },
    interrupt(status = 503) { streamFailureStatus = status; streamsAllowed = false; hub.closeAll(); }, recover() { streamsAllowed = true; },
    currentPendingId() { return pendingId; },
    newPending() { pendingId = add('Another pending message / 另一条待投递消息', { direction: 'in', status: 'pending' }); return pendingId; }
  };
}
