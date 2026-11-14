import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const publicDir = fileURLToPath(new URL('../../skills/dashboard/public/', import.meta.url));
const schema = fileURLToPath(new URL('../../skills/comm-bridge/scripts/c4-content-schema.js', import.meta.url));
const fixture = fileURLToPath(new URL('./diagram-fixture.js', import.meta.url));

export async function runDiagramBrowser(sandbox, { width, theme }) {
  console.info('diagram browser isolation', JSON.stringify({ ...sandbox.assertIsolation(),
    databasesUsed: false, tmuxUsed: false, backendUsed: false, listen: '127.0.0.1:ephemeral' }));
  const html = `<!doctype html><html lang="zh" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  ${['css/style.css', 'themes/light.css', 'themes/dark.css', 'css/wb.css', 'css/wb-icons.css', 'css/conversation.css'].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}
  <style>body{margin:0;padding:16px}main.conversation-page{display:block;overflow:visible;height:auto;max-width:720px;margin:auto}.conversation-message{margin-bottom:24px!important}</style></head>
  <body><main class="conversation-page"></main><script type="module" src="/fixture.js"></script></body></html>`;
  let missing, outside, pageError;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const file = url.pathname === '/chat-schema.js' ? schema : url.pathname === '/fixture.js' ? fixture
      : path.resolve(publicDir, '.' + decodeURIComponent(url.pathname));
    if ((!file.startsWith(publicDir) && ![schema, fixture].includes(file)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      missing ??= url.pathname; res.writeHead(404); return res.end();
    }
    res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  let browser;
  try {
    const origin = await sandbox.startHttp(server);
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const profile = path.join(sandbox.paths.tmp, 'chrome'); fs.mkdirSync(profile);
    const chrome = sandbox.startChild(process.env.ZYLOS_CHAT_BROWSER_BIN, ['--headless', '--no-sandbox', '--disable-background-networking',
      '--disable-component-update', '--no-first-run', '--disable-dev-shm-usage', '--disable-crash-reporter', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
    { timeoutMs: 30_000, maxOutputBytes: 65_536 });
    let chromeResult, chromeStderr = '';
    chrome.stderr.on('data', chunk => { chromeStderr = (chromeStderr + chunk.toString()).slice(-8192); });
    chrome.completion.then(result => { chromeResult = result; });
    const endpoint = await new Promise((resolve, reject) => {
      let tail = '';
      const timer = setTimeout(() => { chrome.stderr.off('data', read); reject(Error('Chrome endpoint timed out')); }, 8000);
      function read(chunk) {
        tail = (tail + chunk).slice(-8192);
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(tail);
        if (match) { clearTimeout(timer); chrome.stderr.off('data', read); resolve(match[1]); }
      }
      chrome.stderr.on('data', read);
      chrome.completion.then(result => { clearTimeout(timer); chrome.stderr.off('data', read); reject(Error('Chrome exited: ' + result.code)); });
    });
    browser = await chromium.connectOverCDP(endpoint);
    sandbox.addCleanup(() => browser.close());
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN', timezoneId: 'UTC' });
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/')) return route.continue();
      outside ??= route.request().url(); return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on('pageerror', error => { pageError ??= error.message; });
    try { await page.goto(origin); }
    catch (error) {
      throw Error(error.message + '; Chrome=' + JSON.stringify(chromeResult || { stderr: chromeStderr }));
    }
    try { await page.waitForFunction(() => window.diagramFixture?.ready); }
    catch (error) { throw Error(error.message + '; page error=' + pageError + '; missing=' + missing); }
    await page.evaluate(() => document.fonts.ready);
    assert.equal(pageError, undefined); assert.equal(missing, undefined); assert.equal(outside, undefined);
    assert.equal(await page.locator('.chat-diagram').count(), 10);
    const orientation = id => page.locator('#' + id + ' .chat-diagram-nodes').evaluateAll(nodes => {
      const [a, b] = nodes.map(node => node.getBoundingClientRect());
      return Math.abs(a.top - b.top) < 1 && b.left > a.left ? 'horizontal' : b.top > a.top ? 'vertical' : 'invalid';
    });
    assert.equal(await orientation('default'), 'vertical');
    assert.equal(await orientation('horizontal'), width === 1280 ? 'horizontal' : 'vertical');
    assert.equal(await orientation('five'), width === 1280 ? 'horizontal' : 'vertical');
    assert.equal(await orientation('long'), 'vertical');
    const parallel = await page.locator('#horizontal .chat-diagram-nodes').evaluateAll(steps => steps.map(step => {
      const boxes = [...step.querySelectorAll('.chat-diagram-node')].map(node => node.getBoundingClientRect());
      return { count: boxes.length, aligned: boxes.every(box => Math.abs(box.top - boxes[0].top) < 1),
        separate: boxes.slice(1).every((box, i) => box.left >= boxes[i].right - 1) };
    }));
    assert.deepEqual(parallel.map(step => step.count), [2, 3, 1]);
    assert.ok(parallel.every(step => step.aligned && step.separate));
    assert.equal(await page.locator('#default .chat-diagram-link').count(), 2);
    assert.equal(await page.locator('#default .chat-diagram-link[data-arrow="forward"]').count(), 1);
    assert.equal(await page.locator('#default .chat-diagram-link[data-arrow="both"]').count(), 1);
    assert.equal(await page.locator('#long .chat-diagram-link[data-arrow="none"]').count(), 1);
    assert.equal((await page.locator('#default').textContent()).includes('LAST LINK MUST NOT APPEAR'), false);
    const groups = await page.locator('#default .chat-diagram-group').evaluateAll(nodes => nodes.map(node => {
      const group = node.getBoundingClientRect();
      const flow = node.closest('.chat-diagram-flow');
      const steps = [...flow.querySelectorAll('.chat-diagram-nodes')].map(step => step.getBoundingClientRect());
      return { text: node.textContent, contains: steps.map(step => step.top >= group.top - 1 && step.bottom <= group.bottom + 1) };
    }));
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map(group => group.contains), [[true, true, false], [false, false, true]]);
    const groupLabelOverlaps = await page.locator('#five .chat-diagram-group-label').evaluateAll(labels => labels.some(label => {
      const a = label.getBoundingClientRect();
      return [...label.closest('.chat-diagram-flow').querySelectorAll('.chat-diagram-node')].some(node => {
        const b = node.getBoundingClientRect();
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      });
    }));
    assert.equal(groupLabelOverlaps, false, 'long single-step group label must not overlap a node');
    assert.equal(await page.locator('#literal .chat-diagram-label').first().textContent(), await page.evaluate(() => window.diagramFixture.literal));
    assert.equal(await page.locator('#literal img,#literal script,#literal a,#literal input,#literal svg').count(), 0);
    assert.equal(await page.locator('#literal .chat-diagram-node').first().locator('.wb-ico').count(), 0);
    assert.equal(await page.evaluate(() => window.bad), undefined);
    const masks = await page.locator('[id^="icons-"] .wb-ico').evaluateAll(nodes => nodes.map(node => ({
      mask: getComputedStyle(node).maskImage, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
    })));
    assert.equal(masks.length, 28); assert.ok(masks.every(icon => icon.mask !== 'none' && icon.width > 0 && icon.height > 0));
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.chat-diagram,.chat-diagram-node,.chat-diagram-group-label,.chat-diagram-link-label')]
      .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className).slice(0, 5));
    assert.deepEqual(overflow, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    const output = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, `diagram-${width}-${theme}.png`), animations: 'disabled' });
      for (const id of ['default', 'horizontal', 'five']) await page.locator('#' + id).screenshot({ path: path.join(output, `diagram-${id}-${width}-${theme}.png`), animations: 'disabled' });
    }
    assert.equal(pageError, undefined); assert.equal(outside, undefined);
  } finally { if (browser) await browser.close(); }
}
