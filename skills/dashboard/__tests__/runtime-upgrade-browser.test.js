import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { startPage } from './helpers/workbench-browser.js';
import { openDashboardTab } from './helpers/browser-navigation.js';
import { workbenchAnswer } from './fixtures/workbench-browser-api.js';

const runtimes = [
  ['claude', 'Claude', '2.1.80', ['en', 'zh']],
  ['codex', 'Codex', '0.137.0', ['en']],
  ['agy', 'Antigravity', '1.5.11', ['en', 'zh']],
];

// Isolated browser and loopback fixture only. Run when upgrade/version copy or outcomes change.
test('runtime upgrades use the viewed runtime name and distinguish unknown and confirmed outcomes', {
  skip: !chatEnabled(), timeout: 120000,
}, async t => {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    const { base } = await startPage(sandbox);
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true,
      env: sandbox.env, args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    sandbox.addCleanup(() => browser.close());
    for (const [runtime, name, version, languages] of runtimes) {
      for (const width of [1280, 390]) for (const language of languages) for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 900 }, timezoneId: 'Asia/Singapore', reducedMotion: 'reduce',
        });
        try {
          const zh = language === 'zh';
          await context.addInitScript(({ language, theme }) => {
            localStorage.setItem('zylos-dashboard-locale', language); localStorage.setItem('zylos-dashboard-theme', theme);
          }, { language, theme });
          let outcome = 'success';
          let releaseOrigin;
          let afterSuccess;
          await context.route('**/*', async route => {
            const req = route.request(), url = new URL(req.url());
            if (url.origin !== base) return route.abort();
            if (url.pathname === '/_assets/vendor/chart.umd.js') return route.fulfill({ path: process.env.ZYLOS_CHAT_CHART_ASSET, contentType: 'text/javascript' });
            if (url.pathname === '/api/instance' && req.method() === 'GET') {
              const value = workbenchAnswer(url, Date.now());
              value.default_runtime = runtime;
              value.versions[runtime] = { installed: version, ...(runtime === 'agy' ? { update_check: 'unsupported' } : {}) };
              return route.fulfill({ json: value });
            }
            if (url.pathname === '/api/instance/actions/upgrade-runtime') {
              if (outcome === 'success') {
                afterSuccess = new Promise(resolve => { releaseOrigin = resolve; });
                return route.fulfill({ json: {
                  ok: true, messageKey: 'result.runtime_updated', messageParams: { runtime: name }, requires_restart: true,
                } });
              }
              if (outcome === 'failure') return route.fulfill({ status: 502, json: {
                ok: false, error: { code: 'upgrade_failed', message: 'fixture rejection' },
                messageKey: 'result.upgrade_failed', messageParams: { error: 'fixture rejection' },
              } });
              if (outcome === 'timeout') return route.fulfill({ status: 504, json: {
                ok: false, error: { code: 'deadline_exceeded' },
                messageKey: 'result.runtime_upgrade_incomplete', messageParams: { runtime: name, minutes: 5 },
              } });
              if (outcome === 'lost') return route.abort('connectionreset');
              return route.fulfill({ status: 504, json: { ok: false, error: { code: 'upstream_failed', message: 'Proxy reply lost' } } });
            }
            if (url.pathname === '/api/groups/origin' && afterSuccess) {
              await afterSuccess;
              return route.fulfill({ json: { presence: 'offline' } });
            }
            return route.continue();
          });
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          const screenshot = async stage => {
            const dir = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
            if (!dir) return;
            fs.mkdirSync(dir, { recursive: true });
            await page.screenshot({ path: path.join(dir, `upgrade-${runtime}-${width}-${language}-${theme}-${stage}.png`) });
          };
          await page.goto(base);
          await openDashboardTab(page, 'settings');
          if (width === 390) await page.locator('.wb-set-drawer-btn').click();
          await page.locator('[data-settings-section="ui"]').click();
          const button = page.locator('[data-action="upgrade-cc"]');
          await button.waitFor({ state: 'visible' });
          assert.equal(await button.locator('#action-cli-label').textContent(), zh ? `升级 ${name}` : `Upgrade ${name}`);
          const updateNote = zh ? '不支持检查更新' : 'update check not supported';
          const versionText = `${name} · v${version}${runtime === 'agy' ? ' · ' + updateNote : ''}`;
          assert.equal(await page.locator('#settings-version p').last().textContent(), versionText);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          const geometry = await button.boundingBox();
          assert.ok(geometry.x >= 0 && geometry.x + geometry.width <= width);
          console.log('Upgrade button geometry:', JSON.stringify({ runtime, width, language, theme, ...geometry }));
          await page.mouse.move(0, 0);
          await button.blur();
          await screenshot('settings');
          const dialog = page.getByRole('alertdialog');
          const status = page.locator('#action-status');
          const submit = async () => {
            await button.click();
            await dialog.waitFor({ state: 'visible' });
            assert.ok((await dialog.textContent()).includes(zh ? `升级 ${name}？` : `Upgrade ${name}?`));
            if (outcome === 'success') await screenshot('confirm');
            await dialog.locator('button').last().click();
          };
          const expectStatus = async expected => {
            await page.waitForFunction(({ source }) => new RegExp(source).test(document.querySelector('#action-status')?.textContent ?? ''), { source: expected.source });
            assert.match(await status.textContent(), expected);
            assert.equal(await status.isVisible(), true);
          };

          try {
            await submit();
            await expectStatus(new RegExp(zh ? `${name} 已更新` : `${name} updated`));
            await screenshot('success');
          } finally { releaseOrigin?.(); }
          // The success follow-up is consumed before changing the next request outcome.
          await page.waitForFunction(() => !/updated|已更新/.test(document.querySelector('#action-status')?.textContent ?? ''));

          outcome = 'gateway';
          await submit();
          const unknown = new RegExp(zh ? `${name} 升级结果未知` : `${name} upgrade result is unknown`);
          await expectStatus(unknown);
          await screenshot('gateway-504');
          if (runtime === 'agy') {
            for (const [kind, expected] of [['lost', unknown], ['failure', /Upgrade failed: fixture rejection|升级失败：fixture rejection/], ['timeout', /did not complete within 5 minutes|5 分钟/]]) {
              outcome = kind;
              await submit();
              await expectStatus(expected);
              if (kind !== 'lost') assert.doesNotMatch(await status.textContent(), unknown);
            }
          }
          console.log('Upgrade browser:', runtime, width, language, theme, 'version, confirmation, success, gateway 504, no horizontal overflow');
        } finally { await context.close(); }
      }
    }
  }, { timeoutMs: 115000 });
});
