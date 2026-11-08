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
  const scenarios = [];
  for (const locale of ['zh', 'en']) for (const width of [1280, 390])
    for (const theme of ['light', 'dark']) for (const detail of ['plain', 'technical'])
      scenarios.push({ locale, width, theme, detail, remaining: null });
  for (const remaining of [8, 50, 90]) scenarios.push({ locale: 'zh', width: 1280, theme: 'light', detail: 'technical', remaining });
  for (const { locale, width, theme, detail, remaining } of scenarios) {
      await page.setViewportSize({ width, height: 1400 });
      await page.evaluate(args => window.showQuota(...args), [locale, theme, detail, remaining]);
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
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        // Composite every ancestor so translucent tracks/panels are measured on
        // their actual surface, including CSS color-mix output in either theme.
        const background = node => {
          const chain = [];
          while (node) { chain.unshift(getComputedStyle(node).backgroundColor); node = node.parentElement; }
          ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1, 1);
          for (const color of chain) { ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); }
          return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const rgb = color => {
          ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const colors = (amount, track, fill) => {
          const shadow = getComputedStyle(fill).boxShadow;
          const shadowColor = /^rgb\([^)]+\)/.exec(shadow)?.[0];
          return ({
          textRgb: rgb(getComputedStyle(amount).color), textBackground: background(amount),
          fillRgb: rgb(getComputedStyle(fill).backgroundColor), trackRgb: background(track),
          surfaceRgb: background(track.parentElement), outlineRgb: shadowColor ? rgb(shadowColor) : null, shadow
        });
        };
        const strip = [...document.querySelectorAll('.wb-account')].map(node => {
          const track = node.querySelector('.wb-meter');
          return { text: node.textContent, title: node.title, meter: getComputedStyle(track).display,
            ...colors(node.lastElementChild, track, track.querySelector('i')) };
        });
        const fleet = [...document.querySelectorAll('.wb-qbar[style]')].filter(visible).map(node => ({
          text: node.textContent, ...colors(node.querySelector('b'), node.querySelector('.wb-qbar-tr'), node.querySelector('i'))
        }));
        return { regions, strip, fleet, documentWidth: document.documentElement.scrollWidth };
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
      assert.ok(measured.strip[0].text.includes(`${remaining ?? 50}%`));
      assert.ok(measured.strip[1].text.includes(`${remaining ?? 10}%`));
      assert.equal(measured.strip[1].title, (locale === 'zh' ? '7 天额度剩余 ' : '7-day quota remaining ') + (remaining ?? 10) + '%');
      const luminance = color => color.map(v => v / 255)
        .reduce((sum, v, i) => sum + [.2126, .7152, .0722][i] * (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4), 0);
      const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
      for (const value of [...measured.strip, ...measured.fleet]) {
        value.textContrast = contrast(value.textRgb, value.textBackground);
        value.barContrast = contrast(value.fillRgb, value.trackRgb);
        value.edgeContrast = value.outlineRgb ? contrast(value.outlineRgb, value.surfaceRgb) : null;
        assert.ok(value.textContrast >= 4.5, JSON.stringify({ locale, theme, value }));
        if (theme === 'dark') {
          assert.deepEqual(value.textRgb, value.fillRgb);
          assert.equal(value.shadow, 'none');
        } else {
          assert.ok(value.barContrast >= 3, JSON.stringify({ locale, theme, value }));
          assert.ok(value.edgeContrast >= 3, JSON.stringify({ locale, theme, value }));
          assert.match(value.shadow, /^rgb\([^)]+\) 0px 0px 0px 1px inset$/);
        }
      }
      if (width === 390) for (const value of measured.strip) assert.equal(value.meter, 'none');
      metrics.push({ locale, width, theme, detail, remaining, ...measured });
      if (evidence && detail === 'technical') await page.screenshot({
        path: path.join(evidence, remaining == null ? `quota-${locale}-${width}-${theme}.png` : `quota-light-1280-remaining-${remaining}.png`), fullPage: true });
    }
  if (evidence) fs.writeFileSync(path.join(evidence, 'quota-browser-metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
  console.log('Quota browser: 16 locale/width/theme/detail combinations + 8/50/90% light samples; single-line values, text/bar/edge contrast, no overflow or browser errors.');
}
