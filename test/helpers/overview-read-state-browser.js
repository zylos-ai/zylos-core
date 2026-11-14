import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic } from '../../skills/dashboard/src/lib/http.js';
import { workbenchAnswer } from '../../skills/dashboard/__tests__/fixtures/workbench-browser-api.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../skills/dashboard/public/', import.meta.url)));
export async function runOverviewReadState(sandbox, scenario) {
  console.info('Overview browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  let failGroups = scenario.kind === 'initial-error';
  const streams = new Set();
  sandbox.addCleanup(() => { for (const res of streams) res.end(); });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ready\n\n'); streams.add(res); res.on('close', () => streams.delete(res)); return;
    }
    if (url.pathname.startsWith('/api/')) {
      let value = workbenchAnswer(url, Date.now());
      if (url.pathname === '/api/workbench/groups') {
        if (failGroups) return sendJson(res, 500, { error: 'fixture_read_failed' });
        if (scenario.kind === 'empty') value = { ...value, rows: [], counts: {}, attention: { problems: [], reminders: [] } };
        // An independent attention problem must survive a refresh error.
        else value.attention.problems.push({ kind: 'channel_down', service: 'fixture-service' });
      }
      return sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' });
    }
    if (url.pathname === '/') return sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin'));
    if (!serveStatic(req, res, publicDir)) sendJson(res, 404, { error: 'not_found' });
  });
  const base = await sandbox.startHttp(server);
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const context = await browser.newContext({ viewport: { width: scenario.width, height: 960 } });
  sandbox.addCleanup(() => context.close());
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(({ locale, theme }) => {
    if (window !== window.top) return;
    localStorage.setItem('zylos-dashboard-locale', locale);
    localStorage.setItem('zylos-dashboard-theme', theme);
  }, scenario);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => { if (errors.length < 1) errors.push(error.message); });
  await page.goto(base, { waitUntil: 'commit' });
  const labels = JSON.parse(fs.readFileSync(path.join(publicDir, `i18n/wb.${scenario.locale}.json`), 'utf8'));
  const board = page.locator('#wb-board'), attention = page.locator('#wb-attention');
  const errorText = labels['wb.readFailed'];
  await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, scenario.theme);
  // Measure the real text and composited ancestor backgrounds, including alpha.
  // Canvas resolves computed CSS colours to sRGB without assuming theme tokens.
  const appearance = locator => locator.evaluate(node => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = css => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1);
      const data = [...ctx.getImageData(0, 0, 1, 1).data];
      return [data[0], data[1], data[2], data[3] / 255];
    };
    const over = (front, back) => front.slice(0, 3).map((v, i) => v * front[3] + back[i] * (1 - front[3]));
    const ancestors = []; for (let at = node; at; at = at.parentElement) ancestors.unshift(at);
    let background = [255, 255, 255];
    for (const at of ancestors) {
      const style = getComputedStyle(at);
      if (style.backgroundImage !== 'none' || Number(style.opacity) !== 1) throw Error('Unsupported contrast surface');
      background = over(rgba(style.backgroundColor), background);
    }
    const foreground = over(rgba(getComputedStyle(node).color), background);
    const luminance = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const a = luminance(foreground), b = luminance(background);
    return { color: getComputedStyle(node).color, background, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
  });
  if (scenario.kind === 'refresh-error') {
    await board.locator('.wb-row').first().waitFor({ state: 'visible' });
    const rows = await board.locator('.wb-row').allTextContents();
    const otherIssues = await attention.locator('.wb-attention-item').allTextContents();
    assert.equal(otherIssues.length, 1);
    assert.ok(otherIssues[0].includes('fixture-service'));
    failGroups = true;
    // Trigger the product's real refresh listener; do not replace its poller.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await attention.getByText(errorText, { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await board.getByText(errorText, { exact: true }).count(), 0);
    assert.equal(await attention.getByText(errorText, { exact: true }).count(), 1);
    assert.deepEqual(await board.locator('.wb-row').allTextContents(), rows);
    for (const text of otherIssues) assert.ok((await attention.textContent()).includes(text));
  } else if (scenario.kind === 'initial-error') {
    const alert = board.getByRole('alert');
    await alert.waitFor({ state: 'visible' });
    assert.equal(await alert.evaluate(node => node.classList.contains('wb-attention-item') && !node.classList.contains('wb-empty')), true,
      'Initial read failure must use the existing error card rather than the empty-state style');
    // Align with the search toolbar's content edges (desktop/mobile insets).
    const alignment = await alert.evaluate(node => {
      const head = document.querySelector('#wb-board-head');
      const bounds = head.getBoundingClientRect(), style = getComputedStyle(head);
      const card = node.getBoundingClientRect();
      return { cardLeft: card.left, cardRight: card.right,
        toolbarLeft: bounds.left + parseFloat(style.paddingLeft),
        toolbarRight: bounds.right - parseFloat(style.paddingRight) };
    });
    assert.ok(Math.abs(alignment.cardLeft - alignment.toolbarLeft) <= 1, 'Error card left edge aligns with search toolbar content');
    assert.ok(Math.abs(alignment.cardRight - alignment.toolbarRight) <= 1, 'Error card right edge aligns with search toolbar content');
    console.info('Overview error alignment:', JSON.stringify({ ...scenario, ...alignment }));
    const glyph = alert.locator('.wb-ico-alert');
    assert.equal(await glyph.count(), 1);
    assert.equal(await glyph.isVisible(), true);
    assert.notEqual(await glyph.evaluate(node => getComputedStyle(node).maskImage), 'none');
    const measured = await appearance(alert.getByText(errorText, { exact: true }));
    console.info('Overview error appearance:', JSON.stringify({ ...scenario, ...measured }));
    assert.ok(measured.contrast >= 4.5, `Error text contrast ${measured.contrast.toFixed(2)} must be at least 4.5:1`);
    assert.equal(await board.getByText(errorText, { exact: true }).count(), 1);
    assert.equal(await attention.getByText(errorText, { exact: true }).count(), 0);
    assert.equal(await board.locator('.wb-row').count(), 0);
  } else {
    const empty = page.locator('#wb-board > .wb-empty:not([role="status"])');
    await empty.waitFor({ state: 'visible' });
    assert.equal(await empty.textContent(), labels['wb.noGroups']);
    assert.equal(await empty.evaluate(node => node.classList.contains('wb-attention-item')), false);
    assert.equal(await empty.locator('.wb-ico').count(), 0);
    console.info('Overview empty appearance:', JSON.stringify({ ...scenario, ...await appearance(empty) }));
    assert.equal(await board.getByRole('alert').count(), 0);
    assert.equal(await page.getByText(errorText, { exact: true }).count(), 0);
    assert.equal(await board.locator('.wb-row').count(), 0);
  }
  assert.equal(await page.getByText(errorText, { exact: true }).count(), scenario.kind === 'empty' ? 0 : 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Overview has no horizontal overflow');
  assert.equal(errors.length, 0, errors[0]);
  if (process.env.ZYLOS_OVERVIEW_SHOTS) {
    fs.mkdirSync(process.env.ZYLOS_OVERVIEW_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.ZYLOS_OVERVIEW_SHOTS,
      `${scenario.kind}-${scenario.width}-${scenario.locale}-${scenario.theme}.png`), fullPage: true });
  }
}
