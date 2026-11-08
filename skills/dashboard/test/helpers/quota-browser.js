import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveStatic } from '../../src/lib/http.js';

export async function runQuotaBrowser(sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
  const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath), 'explicit Playwright module required');
  assert.ok(executablePath && fs.existsSync(executablePath), 'explicit browser required');
  console.log('Quota browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
  const fixture = fs.readFileSync(new URL('../fixtures/quota-browser.html', import.meta.url));
  const server = http.createServer((req, res) => {
    if (req.url === '/fixture') { res.setHeader('content-type', 'text/html'); res.end(fixture); return; }
    if (!serveStatic(req, res, publicDir)) { res.writeHead(404); res.end(); }
  });
  const base = await sandbox.startHttp(server);
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const context = await browser.newContext();
  sandbox.addCleanup(() => context.close());
  await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  let browserError;
  page.on('pageerror', error => { browserError ??= error.message; });
  page.on('console', message => { if (message.type() === 'error') browserError ??= message.text(); });
  page.on('requestfailed', request => { browserError ??= request.url() + ': ' + request.failure()?.errorText; });
  page.on('response', response => { if (response.status() >= 400) browserError ??= response.url() + ': ' + response.status(); });
  await page.goto(base + '/fixture');
  await page.waitForFunction(() => window.quotaReady === true).catch(error => { throw new Error(browserError ?? error.message); });
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const metrics = [];
  for (const locale of ['zh', 'en']) for (const width of [1280, 390])
    for (const theme of ['light', 'dark']) for (const detail of ['plain', 'technical']) {
      await page.setViewportSize({ width, height: 1400 });
      await page.evaluate(([locale, theme, detail]) => window.showQuota(locale, theme, detail), [locale, theme, detail]);
      const measured = await page.evaluate(() => {
        const visible = node => node.getBoundingClientRect().height > 0;
        const unknown = document.documentElement.lang === 'zh' ? '暂无数据' : 'No data';
        const regions = [
          '.wb-f-card[data-self] .wb-qbar',
          '.wb-f-card[data-agent="empty-remote"] .wb-qbar',
          '.wb-f-compare .wb-qbar'
        ].map(selector => [...document.querySelectorAll(selector + ' b')]
          .filter(node => node.textContent === unknown && visible(node)).map(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            return { text: node.textContent, lines: range.getClientRects().length,
              height: node.getBoundingClientRect().height, whiteSpace: getComputedStyle(node).whiteSpace };
          }));
        const background = node => {
          while (node) {
            const color = getComputedStyle(node).backgroundColor;
            if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
            node = node.parentElement;
          }
          return 'rgb(255, 255, 255)';
        };
        const strip = [...document.querySelectorAll('.wb-account')].map(node => ({ text: node.textContent,
          title: node.title, color: getComputedStyle(node.lastElementChild).color,
          fill: getComputedStyle(node.querySelector('.wb-meter i')).backgroundColor,
          background: background(node.lastElementChild), meter: getComputedStyle(node.querySelector('.wb-meter')).display }));
        return { regions, strip, documentWidth: document.documentElement.scrollWidth };
      });
      assert.equal(browserError, undefined, browserError);
      assert.ok(measured.documentWidth <= width, JSON.stringify({ width, measured }));
      for (const [index, region] of measured.regions.entries()) {
        assert.equal(region.length, index === 2 ? (detail === 'technical' ? 2 : 0) : 1);
        for (const value of region) {
          assert.equal(value.lines, 1, JSON.stringify({ locale, width, theme, detail, value }));
          assert.equal(value.whiteSpace, 'nowrap');
        }
      }
      assert.ok(measured.strip[0].text.includes('50%'));
      assert.ok(measured.strip[1].text.includes('10%'));
      assert.match(measured.strip[1].title, locale === 'zh' ? /7 天额度剩余 10%/ : /7-day quota remaining 10%/);
      const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255)
        .reduce((sum, v, i) => sum + [.2126, .7152, .0722][i] * (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4), 0);
      for (const value of measured.strip) {
        assert.equal(value.color, value.fill);
        if (width === 390) assert.equal(value.meter, 'none');
        const a = luminance(value.color), b = luminance(value.background);
        value.contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        assert.ok(value.contrast >= 4.5, JSON.stringify({ locale, theme, value }));
      }
      metrics.push({ locale, width, theme, detail, ...measured });
      if (evidence && detail === 'technical') await page.screenshot({
        path: path.join(evidence, `quota-${locale}-${width}-${theme}.png`), fullPage: true });
    }
  if (evidence) fs.writeFileSync(path.join(evidence, 'quota-browser-metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
  console.log('Quota browser: 16 locale/width/theme/detail combinations, local/remote/comparison single-line values; no overflow or browser errors.');
}
