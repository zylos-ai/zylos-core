import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { AuthGate } from '../src/lib/auth.js';
import { FleetProxy } from '../src/lib/fleet-proxy.js';
import { SseHub } from '../src/lib/sse.js';
import { ChatChangeObserver } from '../src/lib/chat/change-observer.js';
import { handleChatStream } from '../src/lib/chat/stream.js';

const gated = { skip: process.env.ZYLOS_CHAT_INTEGRATION !== '1', timeout: 10000 };
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 1500;
  while (Date.now() < end) { if (check()) return; await pause(5); }
  assert.ok(check(), 'bounded SSE condition');
}
// Real HTTP/AuthGate/producer/proxy streams. Run for chat stream access/relay
// changes; skip unrelated UI. Official runner isolation is read back before
// listeners; no DB/tmux/PM2/model. All clients/listeners/timers are fixture-owned.
async function fixture(t, { beforeLocalListen = () => {} } = {}) {
  console.info('chat proxy isolation', JSON.stringify(Object.fromEntries(['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR'].map(key => [key,process.env[key]]))), 'DB/socket/PM2/tmux unused; loopback ephemeral ports');
  let localRevoked = false, version = 1, forwarded = 0, touches = 0, deletes = 0;
  const session = { created_at: Date.now(), last_activity_at: Date.now() };
  const cookie = 'private-chat-proxy-cookie', token = 'zylos_st_' + 'b'.repeat(64), read = 'zylos_st_' + 'a'.repeat(64);
  const store = {
    getSession: digest => !localRevoked && digest === hash(cookie) ? session : null,
    touchSession(_hash, at) { touches++; session.last_activity_at = at; }, deleteSession() { deletes++; localRevoked = true; }, cleanupSessions() {}, cleanupExpiredApiSessions() {},
    getApiSession: digest => digest === hash(token) || digest === hash(read)
      ? { api_key_id: 'private', scope: digest === hash(token) ? 'admin' : 'read', expires_at: Date.now()+60000 } : null
  };
  const config = { auth: { enabled: true, password: 'scrypt:fixture' }, chat: { allowRemote: true } };
  const auth = new AuthGate(config, store), localAuth = new AuthGate(config, store), hub = new SseHub(20);
  const observer = new ChatChangeObserver({ c4Reader: { readVersion: () => ({ generation: 1, version }) }, history: { chatChangeSnapshot: (_scope, { afterId = null } = {}) => ({ highwater: version, listChanged: afterId !== null && afterId < version, latestId: null, delivery: [] }) }, intervalMs: 20 });
  const sockets = new Set(), servers = [];
  let cleanupPromise;
  const cleanup = () => cleanupPromise ||= (async () => {
    for (const socket of sockets) socket.destroy();
    observer.close(); hub.closeAll(); clearInterval(auth._cleanupTimer); clearInterval(localAuth._cleanupTimer);
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  })();
  t.after(cleanup);
  t.signal.addEventListener('abort', () => { void cleanup(); }, { once: true });
  async function listen(fn) {
    const server = http.createServer(fn); servers.push(server);
    await new Promise((resolve, reject) => {
      const failed = error => reject(error);
      server.once('error', failed);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', failed);
        if (cleanupPromise || t.signal.aborted) {
          server.closeAllConnections();
          server.close(() => reject(new Error('private fixture startup cancelled')));
        } else resolve();
      });
    });
    return `http://127.0.0.1:${server.address().port}`;
  }
  try {
  const remote = await listen(async (req,res) => {
    const url = new URL(req.url,'http://fixture');
    if (await auth.handle(req,res,url)) return;
    if (!handleChatStream(req,res,url,{ auth,config,hub,observer })) hub.addClient(res);
  });
  const proxy = new FleetProxy({ authGate: localAuth, config: { fleet: { agents: [{ name:'Peer',base_url:remote }] } },
    poller: { getSessionToken: async () => token }, fetch: (...args) => { forwarded++; return fetch(...args); } });
  beforeLocalListen({ servers, observer, hub, auth, localAuth });
  const local = await listen(async(req,res) => {
    const url=new URL(req.url,'http://fixture');
    if (await localAuth.handle(req,res,url)) return;
    if (!await proxy.handle(req,res,url)) { res.writeHead(404);res.end(); }
  });
  function open(identity='cookie',search='?chat=1&chat_tab=mine') {
    let text='',status,ended=false,error;
    const headers=identity==='cookie'?{cookie:`__Secure-zylos_dashboard_session=${cookie}`}:{authorization:`Bearer ${identity==='read'?read:token}`};
    const req=http.get(local+'/fleet/Peer/api/stream'+search,{headers},res=>{
      status=res.statusCode;
      res.on('data',chunk=>{text+=chunk.toString();if(text.length>16384){error=Error('SSE fixture log exceeded bound');req.destroy();}});
      res.on('end',()=>{ended=true;});res.on('close',()=>{ended=true;});
    });
    req.on('error',err=>{error=err;ended=true;});sockets.add(req);
    return {text:()=>text,status:()=>status,ended:()=>ended,error:()=>error,close:()=>req.destroy()};
  }
  return {open,config,hub,observer,session,quiet:()=>hub._stopKeepalive(),touches:()=>touches,deletes:()=>deletes,forwarded:()=>forwarded,revoke:()=>{localRevoked=true;},change:()=>{version++;},
    rawChunk(chunk) { for (const client of hub.clients) client.res.write(chunk); },
    async leakSplitRecord() {
      const frame = `event: state_change\ndata: {"value":"${token}"}\n\n`;
      const at = frame.indexOf(token)+20;
      for (const part of [frame.slice(0,at),frame.slice(at)]) {
        for (const client of hub.clients) client.res.write(part);
        await pause(10);
      }
    } };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// Fixture startup lifecycle only: a private error after the producer starts
// must reclaim it before rejection. Run when relay fixture setup changes;
// product-only UI work may skip. Same runner isolation, no DB/PM2/tmux/model.
test('an interrupted relay fixture startup closes its listeners and timers', gated, async t => {
  let resources;
  await assert.rejects(fixture(t, { beforeLocalListen(value) {
    resources = value;
    throw new Error('private fixture startup interrupted');
  } }), /private fixture startup interrupted/);
  assert.equal(resources.servers.length, 1);
  assert.equal(resources.servers[0].listening, false);
  assert.equal(resources.observer.closed, true);
  assert.equal(resources.observer.timer, null);
  assert.equal(resources.hub.keepaliveTimer, null);
  assert.equal(resources.auth._cleanupTimer._destroyed, true);
  assert.equal(resources.localAuth._cleanupTimer._destroyed, true);
});

test('Fleet chat streams enforce local admin and producer remote policy without leaking IDs',gated,async t=>{
  const f=await fixture(t);
  const denied=f.open('read');await until(()=>denied.ended());
  assert.equal(denied.status(),403);assert.equal(f.forwarded(),0);assert.doesNotMatch(denied.text(),/conversationId|chat_ready/);
  f.config.chat.allowRemote=false;
  const disabled=f.open();await until(()=>disabled.ended());
  assert.equal(disabled.status(),403);assert.doesNotMatch(disabled.text(),/conversationId|chat_ready/);
  f.config.chat.allowRemote=true;
  const allowed=f.open();await until(()=>allowed.text().includes('event: chat_ready'));
  assert.equal(allowed.status(),200);assert.equal(f.observer.subscriptions.size,1);
  assert.doesNotMatch(allowed.text(),/zylos_st_|cookie|password|preview|content/);
});

test('Fleet closes a chat relay when an unfinished record exceeds64KiB', gated, async t => {
  const f = await fixture(t), stream = f.open();
  await until(() => stream.text().includes('event: chat_ready'));
  f.quiet();
  const before = stream.text();
  f.rawChunk('data: ' + 'x'.repeat(32768));
  await pause(30);
  assert.equal(stream.ended(), false, 'an incomplete bounded record remains buffered');
  assert.equal(stream.text(), before, 'no partial record is forwarded');
  f.rawChunk('y'.repeat(32768));
  await until(() => stream.ended());
  assert.equal(stream.text(), before, 'oversized incomplete record never reaches the browser');
  await until(() => f.observer.subscriptions.size === 0);
});

test('Fleet preserves ordinary events when the producer chat budget is exhausted', gated, async t => {
  const f = await fixture(t);
  f.hub.maxChatClients = 0;
  const stream = f.open();
  await until(() => stream.text().includes(': connected'));
  assert.equal(stream.status(), 200);
  assert.equal(f.observer.subscriptions.size, 0);
  assert.equal(f.hub.chatClients.size, 0);
  f.hub.broadcast('state_change', { state: 'idle' });
  await until(() => stream.text().includes('event: state_change'));
  assert.equal(stream.ended(), false);
  assert.doesNotMatch(stream.text(), /chat_ready|chat_connection_limit/);
});

test('Fleet revalidates a revoked local browser while upstream is silent without keepalives', gated, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t), stream = f.open();
  await until(() => stream.text().includes('event: chat_ready'));
  f.quiet();
  const before = stream.text(), touches = f.touches();
  f.revoke();
  t.mock.timers.tick(14999);
  await pause(10);
  assert.equal(stream.ended(), false, 'no producer event or heartbeat triggers chunk revalidation');
  t.mock.timers.tick(1);
  await until(() => stream.ended());
  assert.equal(stream.text(), before);
  assert.equal(f.touches(), touches, 'independent idle relay check is readonly');
  await until(() => f.observer.subscriptions.size === 0);
});

test('Fleet forwards each complete chat record promptly and stops after local credential revocation',gated,async t=>{
  const f=await fixture(t),stream=f.open();
  await until(()=>stream.text().includes('event: chat_ready'));
  const start=Date.now();f.change();
  await until(()=>stream.text().includes('event: chat_messages_changed'));
  assert.ok(Date.now()-start<1000,'no secret-guard tail waits for keepalive');
  const before=stream.text();f.revoke();f.change();
  await until(()=>stream.ended());
  assert.equal(stream.text(),before,'revoked local browser receives no further chat metadata');
  await until(()=>f.observer.subscriptions.size===0);
});


test('Fleet chat framing rejects a secret split between transport chunks before forwarding the record',gated,async t=>{
  const f=await fixture(t),stream=f.open();
  await until(()=>stream.text().includes('event: chat_ready'));
  const before=stream.text();
  await f.leakSplitRecord();
  await until(()=>stream.ended());
  assert.equal(stream.text(),before,'no part of the secret-bearing record reaches the browser');
});

test('Fleet chunk revalidation is readonly and rejects an idle-expired browser session',gated,async t=>{
  const f=await fixture(t),stream=f.open();
  await until(()=>stream.text().includes('event: chat_ready'));
  const touches=f.touches(),lastActivity=f.session.last_activity_at;
  assert.ok(touches>0,'ordinary local HTTP admission still records activity');
  for(let i=0;i<4;i++){
    f.change();await pause(30);
  }
  assert.equal(f.touches(),touches,'SSE data and keepalive records do not refresh the local cookie');
  assert.equal(f.session.last_activity_at,lastActivity);
  const before=stream.text();f.session.last_activity_at=Date.now()-3_600_001;f.change();
  await until(()=>stream.ended());
  assert.equal(stream.text(),before,'no data record crosses after local idle expiry');
  assert.equal(f.deletes(),0,'readonly stream validation never deletes a session row');
  await until(()=>f.observer.subscriptions.size===0);
});
