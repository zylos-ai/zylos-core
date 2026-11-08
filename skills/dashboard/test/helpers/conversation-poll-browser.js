import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const defaultPublic = fileURLToPath(new URL('../../public/', import.meta.url));
const defaultSchema = fileURLToPath(new URL('../../../comm-bridge/scripts/c4-content-schema.js', import.meta.url));

export async function runConversationPollBrowser(t) {
  const publicDir = path.resolve(process.env.ZYLOS_CHAT_BROWSER_SOURCE || defaultPublic);
  const schemaFile = path.resolve(process.env.ZYLOS_CHAT_BROWSER_SCHEMA || defaultSchema);
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR, 'poll-'));
  const paths = {
    root, HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR,
    profile: path.join(root, 'profile'), browserTmp: path.join(root, 'tmp'), socket: path.join(root, 'tmux.sock'),
    c4Database: path.join(root, 'c4.db'), dashboardDatabase: path.join(root, 'dashboard.db'),
  };
  const runnerRoot = path.dirname(process.env.HOME);
  assert.match(path.basename(runnerRoot), /^zylos-tests-/);
  assert.equal(process.env.ZYLOS_DIR, path.join(process.env.HOME, 'zylos'));
  assert.equal(process.env.PM2_HOME, path.join(process.env.HOME, '.pm2'));
  assert.equal(process.env.TMPDIR, path.join(runnerRoot, 'tmp'));
  assert.ok(root.startsWith(process.env.TMPDIR + path.sep));
  console.info('browser polling isolation', JSON.stringify({ ...paths, publicDir, schemaFile,
    address: '127.0.0.1:ephemeral', databasesUsed: false, tmuxUsed: false, PM2Used: false, agentUsed: false }));
  fs.mkdirSync(paths.browserTmp);
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const pending = new Map(), errors = [], externalRequests = [], calls = [], timers = new Set();
  let chrome, chromeDone, chromeExited = false, cleanupPromise, socket, sequence = 0, server, sendAt = 0, sendDurationMs = 0, sendCount = 0, sent = false;
  const started = Date.now(), replyText = '自动回复已出现：轮询仍在继续。';
  const inbound = () => ({ id: 1, direction: 'in', channel: 'dashboard', status: 'pending',
    content: '慢首发后请自动显示投递状态和回复', timestamp: new Date(started).toISOString() });
  const outbound = () => ({ id: 2, direction: 'out', channel: 'dashboard', status: 'delivered', content: replyText,
    timestamp: new Date(started + 6000).toISOString() });
  const conversation = () => ({ id: sent ? 'g:browser' : 'd:browser', state: sent ? 'active' : 'draft', displayName: '慢首发自动刷新验证', channel: 'dashboard' });
  const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const html = `<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><title>隔离浏览器 · 慢首发自动刷新</title>
<link rel="stylesheet" href="/themes/light.css"><link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/wb.css"><link rel="stylesheet" href="/css/wb-icons.css"><link rel="stylesheet" href="/css/conversation.css">
<style>body{margin:0;font-family:system-ui;background:var(--bg)}header{height:48px;padding:12px 20px;box-sizing:border-box;border-bottom:1px solid var(--wb-line);font-weight:600}#wb-chat{height:calc(100vh - 48px);padding:0}</style>
<header>Dashboard · 隔离浏览器验证（API 夹具，无真实 Agent）</header><main id="wb-chat"></main>
<script type="module">import { mountConversationPage } from '/js/wb/conversation-page.js';
const words=await (await fetch('/i18n/wb.zh.json')).json();
window.page=mountConversationPage({root:document.querySelector('#wb-chat'),identity:'private-browser',t:key=>words[key]??key,storage:null});
await window.page.open();window.ready=true;</script></html>`;
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      assert.ok(calls.length < 100, 'bounded API request log');
      calls.push({ path: url.pathname, query: url.search, method: req.method, at: Date.now() - started });
      if (url.pathname === '/api/session-mode') return json(res, { data: { sessionMode: 'multi' } });
      if (url.pathname === '/api/chat/conversations') return json(res, { items: [conversation()], nextCursor: null });
      if (url.pathname.endsWith('/send')) {
        sendCount++; sendAt = Date.now();
        req.resume();
        const timer = setTimeout(() => {
          timers.delete(timer); sent = true; sendDurationMs = Date.now() - sendAt;
          json(res, { stored: true, conversationId: 'g:browser', deliveryState: 'pending' });
        }, 3000); timers.add(timer); return;
      }
      if (url.pathname.endsWith('/messages')) {
        const after = url.searchParams.get('direction') === 'after';
        const replyReady = Date.now() - sendAt >= 6000;
        return json(res, { items: sent ? after ? replyReady ? [outbound()] : [] : [inbound()] : [], nextCursor: null, afterCursor: sent ? 'after1' : null });
      }
      if (url.pathname.endsWith('/status')) return json(res, { items: [{ id: 1, status: Date.now() - sendAt >= 4500 ? 'delivered' : 'pending' }] });
      if (url.pathname.endsWith('/questions')) return json(res, { items: [], nextCursor: null });
      if (url.pathname === '/api/chat/uploads/config') return json(res, { enabled: false });
      if (/^\/api\/chat\/conversations\/[^/]+$/.test(url.pathname)) return json(res, { conversation: conversation(), conversationId: conversation().id, stored: sent, deliveryState: sent ? 'pending' : undefined });
      return json(res, { error: 'fixture_unknown_endpoint' }, 404);
    }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" }); return res.end(html); }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const file = url.pathname === '/chat-schema.js' ? schemaFile : path.resolve(publicDir, '.' + url.pathname);
    if (file !== schemaFile && !file.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end(); }
    try { const data = fs.readFileSync(file); res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream' }); res.end(data); }
    catch { res.writeHead(404); res.end(); }
  });
  const cleanup = () => cleanupPromise ||= (async () => {
    for (const timer of timers) clearTimeout(timer); timers.clear();
    socket?.close(); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('browser closed')); } pending.clear();
    if (chrome && !chromeExited) {
      try { process.kill(-chrome.pid, 'SIGTERM'); } catch {}
      await Promise.race([chromeDone, wait(2000)]);
      if (!chromeExited) {
        try { process.kill(-chrome.pid, 'SIGKILL'); } catch {}
        await Promise.race([chromeDone, wait(2000)]);
      }
    }
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(!chrome || chromeExited, 'Chrome exit must be observed before cleanup completes');
    console.info('browser polling cleanup: server/browser process group closed, private profile/root removed');
  })();
  t.after(cleanup); t.signal.addEventListener('abort', () => { void cleanup(); }, { once: true });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    chrome = spawn(process.env.ZYLOS_CHAT_BROWSER_BIN, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-background-networking', '--disable-extensions', '--disable-component-update', '--no-proxy-server', '--remote-debugging-port=0', '--user-data-dir=' + paths.profile, 'about:blank'], { env: { PATH: process.env.PATH, HOME: paths.HOME, ZYLOS_DIR: paths.ZYLOS_DIR, PM2_HOME: paths.PM2_HOME, TMPDIR: paths.browserTmp }, stdio: 'ignore', detached: true });
    chromeDone = new Promise(resolve => chrome.once('exit', () => { chromeExited = true; resolve(); }));
    const portFile = path.join(paths.profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await wait(50);
    assert.ok(fs.existsSync(portFile), 'Chrome starts');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await once(socket, 'open');
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 10000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      if (data.id) { const item = pending.get(data.id); if (!item) return; clearTimeout(item.timer); pending.delete(data.id); data.error ? item.reject(Error(JSON.stringify(data.error))) : item.resolve(data.result); }
      else if (data.method === 'Runtime.exceptionThrown') { if (!errors.length) errors.push(data.params.exceptionDetails.text); }
      else if (data.method === 'Fetch.requestPaused') {
        const allowed = data.params.request.url.startsWith(origin + '/');
        if (!allowed && !externalRequests.length) externalRequests.push(data.params.request.url);
        void call(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId: data.params.requestId } : { requestId: data.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      }
    });
    const evaluate = async expression => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); assert.equal(r.exceptionDetails, undefined, JSON.stringify(r.exceptionDetails)); return r.result.value; };
    await call('Runtime.enable'); await call('Page.enable'); await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: origin + '/' });
    for (let i = 0; i < 100 && !await evaluate('window.ready===true'); i++) await wait(50);
    assert.equal(await evaluate('window.ready'), true, JSON.stringify(errors));
    assert.equal(errors.length, 0, errors[0]);
    await evaluate(`(()=>{const input=document.querySelector('textarea.conversation-input');input.value='慢首发后请自动显示投递状态和回复';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action="send"]').click();})()`);
    await wait(35000);
    const dom = await evaluate(`({delivered:!!document.querySelector('[data-message-id="1"] [data-delivery-state="delivered"]'),reply:[...document.querySelectorAll('.conversation-message')].some(node=>node.textContent.includes(${JSON.stringify(replyText)})),text:document.querySelector('#wb-chat').innerText})`);
    const metrics = { ...dom, sendCount, sendDurationMs, afterReads: calls.filter(c => c.path.endsWith('/messages') && c.query.includes('direction=after')).length, statusReads: calls.filter(c => c.path.endsWith('/status')).length, manualRefreshClicks: 0, browserErrors: errors, externalRequests, calls, elapsedMs: Date.now() - started, width: 1280, height: 900, boundary: 'Real product DOM/controller/fetch; loopback API fixture, no model, backend DB, PM2 or tmux' };
    if (evidence) {
      const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(evidence, 'slow-first-send-1280.png'), Buffer.from(screenshot.data, 'base64'));
      fs.writeFileSync(path.join(evidence, 'browser-result.json'), JSON.stringify(metrics, null, 2) + '\n');
    }
    console.info('browser polling result', JSON.stringify({ ...metrics, text: undefined, calls: undefined }));
    return metrics;
  } finally { await cleanup(); }
}
