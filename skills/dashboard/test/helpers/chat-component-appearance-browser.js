import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const schema = fileURLToPath(new URL('../../../comm-bridge/scripts/c4-content-schema.js', import.meta.url));
const fixture = fileURLToPath(new URL('./chat-component-appearance-fixture.js', import.meta.url));
// Resolve the already provisioned dependency; never install or access a live service.
const chart = fileURLToPath(new URL('./chart.umd.js', import.meta.resolve('chart.js')));
export async function runComponentAppearanceBrowser(sandbox, { width, theme }) {
  assert.ok([1280, 390].includes(width)); assert.ok(['light', 'dark'].includes(theme));
  const isolation = sandbox.assertIsolation();
  console.info('component browser isolation', JSON.stringify({ ...isolation,
    databasesUsed: false, tmuxUsed: false, backendUsed: false, address: '127.0.0.1:ephemeral' }));
  const html = `<!doctype html><html lang="zh" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  ${['css/style.css','themes/light.css','themes/dark.css','css/wb.css','css/wb-icons.css','css/conversation.css'].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}
  <script src="/vendor/chart.umd.js"></script><script src="/js/chartjs-adapter-date-fns.bundle.min.js"></script>
  <style>body{margin:0}main.conversation-page{display:block;overflow:visible;height:auto;padding:16px}.conversation-message{margin-bottom:24px!important}</style>
  </head><body><button class="wb-btn wb-btn-primary" id="primary">发送</button><main class="conversation-page"></main><script type="module" src="/fixture.js"></script></body></html>`;
  const errors = [], outside = [], missing = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/api/chat/conversations/fixture/attachments/image') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#0f766e"/></svg>');
    }
    const file = url.pathname === '/chat-schema.js' ? schema : url.pathname === '/fixture.js' ? fixture
      : url.pathname === '/vendor/chart.umd.js' ? chart : path.resolve(publicDir, '.' + decodeURIComponent(url.pathname));
    if ((!file.startsWith(publicDir + path.sep) && ![schema, fixture, chart].includes(file)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      if (missing.length < 5) missing.push(url.pathname); res.writeHead(404); return res.end();
    }
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
  });
  let browser;
  try {
    const origin = await sandbox.startHttp(server);
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const profile = path.join(sandbox.paths.tmp, 'chrome-profile'); fs.mkdirSync(profile);
    const chrome = sandbox.startChild(process.env.ZYLOS_CHAT_BROWSER_BIN, [
      '--headless', '--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run',
      '--disable-dev-shm-usage', '--disable-crash-reporter', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
    ], { timeoutMs: 35_000, maxOutputBytes: 65_536 });
    const endpoint = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => { chrome.stderr.off('data', read); reject(new Error('Chrome debugging endpoint timed out')); }, 10_000);
      function read(chunk) {
        text = (text + chunk.toString()).slice(-8192);
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text);
        if (match) { clearTimeout(timer); chrome.stderr.off('data', read); resolve(match[1]); }
      }
      chrome.stderr.on('data', read);
      chrome.completion.then(result => { clearTimeout(timer); chrome.stderr.off('data', read); reject(new Error('Chrome exited: ' + result.code)); });
    });
    browser = await chromium.connectOverCDP(endpoint);
    sandbox.addCleanup(() => browser.close());
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN', timezoneId: 'UTC' });
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/')) return route.continue();
      if (outside.length < 5) outside.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
    await page.goto(origin);
    try { await page.waitForFunction(() => window.componentFixtureReady === true); }
    catch (error) { throw new Error(error.message + '; errors=' + errors.join('; ') + '; missing=' + missing.join('; ')); }
    await page.locator('.chat-attachment-image-content').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('.chat-attachment-image-content').naturalWidth === 160);
    await page.waitForFunction(() => document.querySelectorAll('.conversation-chart-enhanced').length === 2);
    await page.evaluate(() => document.fonts.ready);
    const actual = await page.evaluate(() => {
      const answer = document.querySelector('#answered .chat-question-answer'), list = document.querySelector('#answered .chat-choice-options');
      const dot = getComputedStyle(document.querySelector('#waiting .chat-question-status'), '::before');
      const chart = id => Chart.getChart(document.querySelector('#' + id + ' canvas'));
      return { answerText: answer.textContent, answerTop: answer.getBoundingClientRect().top, choicesTop: list.getBoundingClientRect().top,
        dotAnimation: dot.animationName, dotWidth: dot.width, categoryAxis: chart('category').options.scales.x.display,
        breakdownAxis: chart('breakdown').options.scales.x.display, categoryColor: chart('category').data.datasets[0].backgroundColor[0],
        imageRatio: document.querySelector('.chat-attachment-image-frame').style.aspectRatio,
        primary: getComputedStyle(document.querySelector('#primary')).backgroundColor, localFont: [...document.fonts].some(font => font.family === 'Inter' && font.status === 'loaded'),
        widths: [...document.querySelectorAll('.chat-block')].map(node => node.getBoundingClientRect().width),
        viewport: innerWidth, scroll: document.documentElement.scrollWidth };
    });
    assert.match(actual.answerText, /你的回答/); assert.match(actual.answerText, /LRU/);
    assert.ok(actual.answerTop < actual.choicesTop, 'accepted answer is visually before readonly options');
    assert.equal(actual.dotAnimation, 'none', 'waiting indicator remains static'); assert.equal(actual.dotWidth, '6px', 'waiting dot remains visible');
    assert.equal(actual.categoryAxis, false, 'category has no numeric axis'); assert.equal(actual.breakdownAxis, false, 'breakdown has no numeric axis');
    assert.equal(actual.categoryColor, '#e06b83', 'critical assessment uses rose');
    assert.equal(actual.imageRatio, '160 / 90', 'loaded image uses intrinsic aspect ratio');
    assert.equal(actual.localFont, true, 'shipped local Inter is loaded');
    assert.equal(actual.primary, 'rgb(15, 118, 110)', 'page primary shares approved color');
    assert.ok(actual.widths.every(value => value <= 720), 'rich cards stay within the shared width');
    assert.ok(actual.scroll <= width, 'no horizontal overflow');
    assert.equal(errors.length, 0, errors.join('; ')); assert.equal(outside.length, 0, outside.join('; ')); assert.equal(missing.length, 0, missing.join('; '));
    console.info('component appearance passed', JSON.stringify({ width, theme, ...actual }));
    await context.close();
  } finally {
    await browser?.close(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}
