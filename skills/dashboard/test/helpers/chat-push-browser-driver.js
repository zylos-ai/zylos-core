import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  do { if (await check()) return; await pause(25); } while (Date.now() < deadline);
  assert.fail(message);
}

export async function startChatBrowser(t, sandbox, origin) {
  const profile = path.join(sandbox.root, 'chrome-profile'), tmp = path.join(sandbox.root, 'ct');
  const singletonSocket = path.join(tmp, '.org.chromium.Chromium.XXXXXX', 'SingletonSocket');
  assert.ok(Buffer.byteLength(singletonSocket) <= 107,
    `Chrome SingletonSocket path needs at most107 bytes, got ${Buffer.byteLength(singletonSocket)}: ${singletonSocket}`);
  console.info('chat browser private paths', JSON.stringify({ profile, TMPDIR: tmp, singletonSocketBytes: Buffer.byteLength(singletonSocket) }));
  fs.mkdirSync(tmp);
  const chrome = spawn(process.env.ZYLOS_CHAT_BROWSER_BIN, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--disable-background-networking', '--disable-extensions', '--disable-component-update',
    '--no-proxy-server', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], {
    detached: true, stdio: 'ignore', env: { ...sandbox.env, TMPDIR: tmp },
  });
  let exited = false, closing;
  const done = new Promise(resolve => chrome.once('exit', () => { exited = true; resolve(); }));
  const sockets = new Set();
  const close = () => closing ||= (async () => {
    for (const page of sockets) page.close(); sockets.clear();
    if (!exited) {
      try { process.kill(-chrome.pid, 'SIGTERM'); } catch {}
      await Promise.race([done, pause(2000)]);
      if (!exited) {
        try { process.kill(-chrome.pid, 'SIGKILL'); } catch {}
        await Promise.race([done, pause(2000)]);
      }
    }
    assert.equal(exited, true, 'Chrome process exit observed');
  })();
  sandbox.addCleanup(close);
  t.after(close); t.signal.addEventListener('abort', () => { void close(); }, { once: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  await until(() => fs.existsSync(portFile), 'Chrome starts in its private profile', 5000);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0], debug = 'http://127.0.0.1:' + port;
  const errors = [], external = [];
  async function page({ width = 1280, locale = 'en' } = {}) {
    const target = await (await fetch(debug + '/json/new?about:blank', { method: 'PUT' })).json();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, 'open');
    let sequence = 0;
    const pending = new Map();
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      if (pending.size >= 128) return reject(Error('CDP command bound exceeded'));
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 5000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      if (data.id) {
        const entry = pending.get(data.id); if (!entry) return;
        pending.delete(data.id); clearTimeout(entry.timer);
        data.error ? entry.reject(Error(JSON.stringify(data.error))) : entry.resolve(data.result);
      } else if (data.method === 'Runtime.exceptionThrown' && !errors.length) errors.push(JSON.stringify(data.params.exceptionDetails).slice(0,2000));
      else if (data.method === 'Fetch.requestPaused') {
        const allowed = data.params.request.url.startsWith(origin + '/');
        if (!allowed && !external.length) external.push(data.params.request.url);
        void call(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed
          ? { requestId: data.params.requestId } : { requestId: data.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      }
    });
    const evaluate = async expression => {
      const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert.equal(value.exceptionDetails, undefined, JSON.stringify(value.exceptionDetails));
      return value.result.value;
    };
    const connection = { call, evaluate, id: target.id, async front() { await call('Page.bringToFront'); },
      async screenshot(file) {
        const image = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
      }, close() {
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('browser closing')); }
        pending.clear(); socket.close();
      } };
    sockets.add(connection);
    await call('Runtime.enable'); await call('Page.enable');
    await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: origin + '/?locale=' + locale });
    try { await until(() => evaluate('window.ready===true'), 'real conversation page opens', 5000); }
    catch (error) { console.info('browser load diagnostic', JSON.stringify({errors, page: await evaluate('({ready:window.ready,text:document.body.innerText.slice(0,3000)})')})); throw error; }
    return connection;
  }
  return { page, close, errors, external };
}
