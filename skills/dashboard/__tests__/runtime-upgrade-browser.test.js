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
  ['codex', 'Codex', '0.169.1', ['en', 'zh'], '0.171.0'],
  ['agy', 'Antigravity', '1.5.11', ['en', 'zh']],
];

// Real settings UI and styles, with upgrade replies from an isolated loopback fixture.
// Run for upgrade/version copy, layout or outcomes. Skip for changes outside those paths.
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
    for (const [runtime, name, version, languages, update] of runtimes) {
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
              value.versions[runtime] = { installed: version, latest: update ?? null, update: update ?? null,
                ...(runtime === 'agy' ? { update_check: 'unsupported' } : {}) };
              return route.fulfill({ json: value });
            }
            if (url.pathname === '/api/instance/actions/upgrade-runtime') {
              assert.deepEqual(req.postDataJSON(), { runtime });
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
          const screenshot = async (stage, target) => {
            const dir = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
            if (!dir) return;
            await target?.evaluate(element => element.scrollIntoView({ block: 'center' }));
            fs.mkdirSync(dir, { recursive: true });
            await page.screenshot({ path: path.join(dir, `upgrade-${runtime}-${width}-${language}-${theme}-${stage}.png`) });
          };
          await page.goto(base);
          await openDashboardTab(page, 'settings');
          await page.locator('[data-settings-section="defaults"]').click();
          const button = page.locator('[data-action="upgrade-cc"]');
          await button.waitFor({ state: 'visible' });
          assert.equal((await button.textContent()).trim(), (zh ? `升级 ${name}` : `Upgrade ${name}`) + (update ? ` v${update}` : ''));
          const updateNote = zh ? '不支持检查更新' : 'update check not supported';
          const versionText = `${name} · v${version}${runtime === 'agy' ? ' · ' + updateNote : ''}`;
          const row = page.locator('#settings-engine-version');
          const versionLine = row.locator('p');
          assert.equal(await versionLine.textContent(), versionText);
          assert.equal(await row.locator('.action-ver-dot').count(), 0);
          await page.evaluate(() => document.fonts.ready);
          const versionBox = await versionLine.boundingBox();
          const rowBox = await row.boundingBox();
          const selectorRow = await page.locator('#settings-engine').locator('xpath=ancestor::div[contains(@class, "wb-set-inline")][1]').boundingBox();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          const geometry = await button.boundingBox();
          assert.ok(geometry.x >= rowBox.x && Math.abs(geometry.x + geometry.width - rowBox.x - rowBox.width) <= 1);
          assert.equal(geometry.height, width === 390 ? 36 : 30);
          const gap = rowBox.y - selectorRow.y - selectorRow.height;
          assert.ok(Math.abs(gap - 12) <= 1, `version row starts 12 px after the selector row, got ${gap}`);
          const wraps = geometry.y >= versionBox.y + versionBox.height;
          if (runtime === 'codex' || width === 1280) {
            assert.equal(wraps, false);
            assert.ok(Math.abs(geometry.y + geometry.height / 2 - versionBox.y - versionBox.height / 2) <= 1);
          }
          if (runtime === 'agy' && width === 390 && !zh) assert.equal(wraps, true);
          console.log('Upgrade button geometry:', JSON.stringify({ runtime, viewportWidth: width, language, theme, gap, wraps, ...geometry }));
          await page.mouse.move(0, 0);
          await button.blur();
          await screenshot('settings', row);
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
            await screenshot('success', status);
          } finally { releaseOrigin?.(); }
          // The success follow-up is consumed before changing the next request outcome.
          await page.waitForFunction(() => !/updated|已更新/.test(document.querySelector('#action-status')?.textContent ?? ''));

          outcome = 'gateway';
          await submit();
          const unknown = new RegExp(zh ? `${name} 升级结果未知` : `${name} upgrade result is unknown`);
          await expectStatus(unknown);
          await screenshot('gateway-504', status);
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
