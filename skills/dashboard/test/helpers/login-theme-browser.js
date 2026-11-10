import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AuthGate } from '../../src/lib/auth.js';

const themeValue = (name, variable) => {
  const css = fs.readFileSync(new URL(`../../public/themes/${name}.css`, import.meta.url), 'utf8');
  return css.match(new RegExp(`${variable}:\\s*([^;]+);`))[1].trim();
};
// The colours the browser reports for the Dashboard's own page background, per theme file.
const hex = value => `rgb(${[1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)).join(', ')})`;
const BACKGROUND = { light: hex(themeValue('light', '--bg')), dark: hex(themeValue('dark', '--bg')) };

export async function runLoginThemeBrowser(t, sandbox) {
  console.log('Login theme browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  // The real login route: auth enabled with a password, no session store (the page only renders the form).
  const gate = new AuthGate({ auth: { enabled: true, password: 'scrypt$fixture' } }, null);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!await gate.handle(req, res, url)) { res.writeHead(404); res.end(); }
  });
  const base = await sandbox.startHttp(server);
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
  const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath));
  assert.ok(executablePath && fs.existsSync(executablePath));
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  // [saved Dashboard choice, system setting, expected theme]
  const cases = [['dark', 'light', 'dark'], ['light', 'dark', 'light'], [null, 'dark', 'dark'], [null, 'light', 'light'], ['system', 'dark', 'dark']];
  for (const width of [390, 1280]) for (const [stored, system, expected] of cases) {
    await t.test(`${width}px, saved ${stored ?? 'nothing'}, system ${system}: ${expected}`, async () => {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, colorScheme: system,
        ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
      sandbox.addCleanup(() => context.close());
      await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
      if (stored) await context.addInitScript(value => localStorage.setItem('zylos-dashboard-theme', value), stored);
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      // The first frame the browser can paint: the colour is read as soon as the body exists, before any later script.
      await page.goto(base + '/login', { waitUntil: 'commit' });
      await page.waitForSelector('body', { state: 'attached' });
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), BACKGROUND[expected]);
      await page.waitForLoadState('load');
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), BACKGROUND[expected]);
      const panel = await page.locator('.login-panel').boundingBox();
      assert.ok(panel.x >= 0 && panel.x + panel.width <= width, 'the form fits the width');
      if (stored === null) {
        // Nothing saved: the page follows the system setting while it is open.
        const other = system === 'dark' ? 'light' : 'dark';
        await page.emulateMedia({ colorScheme: other });
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), BACKGROUND[other]);
        await page.emulateMedia({ colorScheme: system });
      }
      if (evidence && (stored === null || stored !== system)) {
        await page.screenshot({ path: path.join(evidence, `login-${width}-${stored ?? 'unset'}-${system}.png`) });
      }
      await context.close();
    });
  }
}
