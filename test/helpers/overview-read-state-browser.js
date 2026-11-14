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
    await board.getByRole('alert').waitFor({ state: 'visible' });
    assert.equal(await board.getByText(errorText, { exact: true }).count(), 1);
    assert.equal(await attention.getByText(errorText, { exact: true }).count(), 0);
    assert.equal(await board.locator('.wb-row').count(), 0);
  } else {
    await board.getByText(labels['wb.noGroups'], { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await board.getByRole('alert').count(), 0);
    assert.equal(await page.getByText(errorText, { exact: true }).count(), 0);
    assert.equal(await board.locator('.wb-row').count(), 0);
  }
  assert.equal(await page.getByText(errorText, { exact: true }).count(), scenario.kind === 'empty' ? 0 : 1);
  assert.equal(errors.length, 0, errors[0]);
  if (process.env.ZYLOS_OVERVIEW_SHOTS) {
    fs.mkdirSync(process.env.ZYLOS_OVERVIEW_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.ZYLOS_OVERVIEW_SHOTS,
      `${scenario.kind}-${scenario.width}-${scenario.locale}-${scenario.theme}.png`), fullPage: true });
  }
}
