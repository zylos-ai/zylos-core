import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { startPage } from './helpers/workbench-browser.js';
import { openDashboardTab } from './helpers/browser-navigation.js';
import { workbenchAnswer } from './fixtures/workbench-browser-api.js';

test('Antigravity upgrade labels, confirmation and lost-result feedback work across settings themes and widths', {
  skip: !chatEnabled(), timeout: 60000,
}, async t => {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    const { base } = await startPage(sandbox);
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true,
      env: sandbox.env, args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    sandbox.addCleanup(() => browser.close());
    for (const width of [1280, 390]) for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, timezoneId: 'Asia/Singapore', reducedMotion: 'reduce' });
      try {
        await context.addInitScript(({ language, theme }) => {
          localStorage.setItem('zylos-dashboard-locale', language); localStorage.setItem('zylos-dashboard-theme', theme);
        }, { language, theme });
        let outcome = 'unknown';
        await context.route('**/*', async route => {
          const req = route.request(), url = new URL(req.url());
          if (url.origin !== base) return route.abort();
          if (url.pathname === '/_assets/vendor/chart.umd.js') return route.fulfill({ path: process.env.ZYLOS_CHAT_CHART_ASSET, contentType: 'text/javascript' });
          if (url.pathname === '/api/instance' && req.method() === 'GET') {
            const value = workbenchAnswer(url, Date.now()); value.default_runtime = 'agy'; value.versions.agy = { installed: '1.5.11' };
            return route.fulfill({ json: value });
          }
          if (url.pathname === '/api/instance/actions/upgrade-runtime') {
            if (outcome === 'failure') return route.fulfill({ status: 502, json: { ok: false, error: { code: 'upgrade_failed', message: 'Antigravity upgrade failed: fixture rejection' }, messageKey: 'result.agy_upgrade_failed', messageParams: { error: 'fixture rejection' } } });
            if (outcome === 'timeout') return route.fulfill({ status: 504, json: { ok: false, error: { code: 'deadline_exceeded', message: 'Antigravity upgrade did not complete within 5 minutes. Check the installed version before retrying.' }, messageKey: 'result.agy_upgrade_incomplete' } });
            if (theme === 'dark') return route.fulfill({ status: 502, json: { ok: false, error: { code: 'upstream_failed', message: 'Proxy reply lost' } } });
            return route.abort('connectionreset');
          }
          return route.continue();
        });
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        await page.goto(base); await openDashboardTab(page, 'settings');
        if (width === 390) await page.locator('.wb-set-drawer-btn').click();
        await page.locator('[data-settings-section="ui"]').click();
        const button = page.locator('[data-action="upgrade-cc"]');
        await button.waitFor({ state: 'visible' });
        assert.match(await button.textContent(), /Antigravity/);
        assert.match(await page.locator('#settings-version').textContent(), /Antigravity · v1.5.11/);
        assert.doesNotMatch(await page.locator('#settings-version').textContent(), /CC|Claude/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const geometry = await button.boundingBox();
        assert.ok(geometry.x >= 0 && geometry.x + geometry.width <= width);
        console.log('Upgrade button geometry:', JSON.stringify({ width, language, theme, ...geometry }));
        await page.mouse.move(0, 0); await button.blur();
        if (process.env.ZYLOS_CHAT_EVIDENCE_DIR) {
          fs.mkdirSync(process.env.ZYLOS_CHAT_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.ZYLOS_CHAT_EVIDENCE_DIR, `upgrade-${width}-${language}-${theme}.png`) });
        }
        await button.click(); const dialog = page.getByRole('alertdialog'); await dialog.waitFor({ state: 'visible' });
        assert.match(await dialog.textContent(), /Antigravity/); assert.doesNotMatch(await dialog.textContent(), /Claude/);
        await dialog.locator('button').last().click();
        await page.waitForFunction(() => /result is unknown|结果未知/.test(document.querySelector('#action-status')?.textContent ?? ''));
        assert.equal(await page.locator('#action-status').isVisible(), true);
        assert.match(await page.locator('#action-status').textContent(), /Antigravity/);
        for (const [kind, expected] of [['failure', /Antigravity upgrade failed: fixture rejection|Antigravity 升级失败：fixture rejection/], ['timeout', /did not complete within 5 minutes|5 分钟/]]) {
          outcome = kind;
          await button.click(); await dialog.waitFor({ state: 'visible' });
          await dialog.locator('button').last().click();
          await page.waitForFunction(({ source, flags }) => new RegExp(source, flags).test(document.querySelector('#action-status')?.textContent ?? ''), { source: expected.source, flags: expected.flags });
          const status = await page.locator('#action-status').textContent();
          assert.match(status, expected);
          assert.doesNotMatch(status, /result is unknown|结果未知/);
        }
        console.log('Upgrade browser:', width, language, theme, 'labels, confirmation, unknown result, confirmed failure, deadline exceeded, no horizontal overflow');
      } finally { await context.close(); }
    }
  }, { timeoutMs: 55000 });
});
