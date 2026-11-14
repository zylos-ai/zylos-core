import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPage } from '../../skills/dashboard/__tests__/helpers/workbench-browser.js';
import { workbenchAnswer } from '../../skills/dashboard/__tests__/fixtures/workbench-browser-api.js';
import { openDashboardTab } from '../../skills/dashboard/__tests__/helpers/browser-navigation.js';

const zone = 'Asia/Shanghai';
const resetWords = /reset|重置/i;

async function stopBrowser(server) {
  const child = server.process();
  let timer;
  try {
    await Promise.race([server.close(), new Promise((_, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Browser cleanup timed out')); }, 8000);
    })]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'browser process reclaimed');
}

async function assertFits(page, card, width) {
  await card.scrollIntoViewIfNeeded();
  const issues = await card.evaluate(root => {
    const bounds = root.getBoundingClientRect(), failures = [];
    for (const node of root.querySelectorAll('h4, .wb-kvs span')) {
      if (!node.textContent.trim() || node.children.length || !node.getClientRects().length) continue;
      const box = node.getBoundingClientRect();
      if (box.width < 1 || node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1
        || box.left < bounds.left - 1 || box.right > bounds.right + 1) {
        failures.push(node.textContent.slice(0, 120));
        if (failures.length === 3) break;
      }
    }
    if (bounds.left < -1 || bounds.right > innerWidth + 1) failures.push('card outside viewport');
    if (document.documentElement.scrollWidth > innerWidth) failures.push('document overflow');
    return failures;
  });
  assert.equal(issues.length, 0, `${width}px account text fits: ${issues.join('; ')}`);
}

export async function runAccountQuotaBrowser(sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
  const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  const chartAsset = process.env.ZYLOS_CHAT_CHART_ASSET;
  for (const filename of [modulePath, executablePath, chartAsset]) {
    assert.ok(filename && path.isAbsolute(filename) && fs.existsSync(filename), 'explicit existing local browser and Chart.js assets required');
  }
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  console.info('Account quota browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const { base, actions } = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(modulePath));
  sandbox.assertIsolation();
  const server = await chromium.launchServer({ executablePath, headless: true, env: sandbox.env, timeout: 15000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => stopBrowser(server));
  const browser = await chromium.connect(server.wsEndpoint(), { timeout: 15000 });

  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) for (const language of ['zh', 'en']) {
    const now = Date.now(), future = now + (3 * 24 + 4) * 3600000, later = now + (4 * 24 + 5) * 3600000;
    const recordedAt = now - 3600000;
    let phase = 'live';
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 },
      locale: language === 'zh' ? 'zh-CN' : 'en-GB', timezoneId: 'America/Los_Angeles',
      ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
    sandbox.addCleanup(() => context.close());
    try {
      await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
      await context.route('**/_assets/vendor/chart.umd.js', route => route.fulfill({ path: chartAsset, contentType: 'text/javascript' }));
      await context.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
      await context.addInitScript(({ theme, language }) => {
        try {
          localStorage.setItem('zylos-dashboard-theme', theme);
          localStorage.setItem('zylos-dashboard-locale', language);
        } catch {}
      }, { theme, language });
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => { if (errors.length < 3) errors.push(error.message); });
      await page.route('**/api/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/state') return route.fulfill({ json: { ...workbenchAnswer(url, now), tz: zone } });
        if (url.pathname !== '/api/workbench/groups') return route.fallback();
        const answer = workbenchAnswer(url, now);
        const stale = phase === 'stale';
        answer.instance.accounts = {
          claude: { used_percentage: 21, resets_at: stale ? Math.floor(later / 1000) : new Date(future).toISOString(), live: !stale, recordedAt },
          codex: { usedPercentage: 42, resetsAt: stale ? new Date(later).toISOString() : Math.floor(future / 1000), live: !stale, recordedAt },
        };
        if (phase === 'omitted') {
          answer.instance.accounts.claude.resets_at = Math.floor((now - 1000) / 1000);
          delete answer.instance.accounts.codex.resetsAt;
        } else if (phase === 'omitted-reverse') {
          delete answer.instance.accounts.claude.resets_at;
          answer.instance.accounts.codex.resetsAt = new Date(now - 1000).toISOString();
        }
        answer.instance.pool.capacityRecord = { valid: true, fresh: true, source: 'fixed' };
        return route.fulfill({ json: answer });
      });
      const stateReady = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
      await page.goto(base + '/');
      await stateReady;
      await openDashboardTab(page, 'overview');
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      const strip = page.locator('.wb-account');
      await strip.filter({ hasText: 'Codex' }).waitFor();
      // State and overview load independently; verify quota after the instance zone has arrived.
      const firstRefresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/groups');
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await firstRefresh;
      const original = new Map();
      const card = page.locator('#wb-side .wb-host-accounts');
      const dateText = at => page.evaluate(({ at, zone }) => new Intl.DateTimeFormat(undefined, {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone,
      }).format(at), { at, zone });
      for (const name of ['Claude', 'Codex']) {
        const item = strip.filter({ hasText: name });
        original.set(name, await item.innerText());
        assert.match(await item.getAttribute('title'), resetWords);
        const title = await item.getAttribute('title'), expectedTime = await dateText(future);
        assert.ok(title.includes(expectedTime), `tooltip uses instance zone rather than browser zone: ${title}; expected ${expectedTime}`);
        assert.doesNotMatch(await item.innerText(), resetWords, 'reset adds no visible strip copy');
        if (width === 1280) await item.hover();
      }
      await page.locator('#wb-host-open').click();
      await card.waitFor();
      assert.equal(await card.evaluate(node => node.previousElementSibling.classList.contains('wb-host-pool')), true, 'accounts follows pool');
      const liveText = await card.innerText();
      for (const text of ['Claude', 'Codex', '79%', '58%', await dateText(future)]) assert.ok(liveText.includes(text), `live card contains ${text}`);
      assert.match(liveText, resetWords);
      await assertFits(page, card, width);
      await page.evaluate(() => { document.activeElement?.blur(); return document.fonts.ready; });
      await page.mouse.move(0, 0);
      if (evidence) await page.screenshot({ path: path.join(evidence, `quota-${width}-${theme}-${language}-live.png`), fullPage: true });

      async function refresh(next) {
        phase = next;
        const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/groups');
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await response;
      }
      await refresh('stale');
      await card.filter({ hasText: /record|记录/i }).waitFor();
      await page.waitForFunction(({ time }) => document.querySelector('.wb-host-accounts')?.textContent.includes(time), { time: await dateText(later) });
      assert.ok((await card.innerText()).includes(await dateText(later)), 'open host updates from refreshed account snapshot');
      for (const name of ['Claude', 'Codex']) {
        assert.ok((await strip.filter({ hasText: name }).getAttribute('title')).includes(await dateText(later)), 'both runtimes accept swapped ISO/seconds representations');
        assert.match(await card.locator('.wb-kvs > div').filter({ hasText: name }).innerText(), /record|记录/i, 'each stale account names its recorded basis');
      }
      await assertFits(page, card, width);
      await page.evaluate(() => document.activeElement?.blur());
      await page.mouse.move(0, 0);
      if (evidence) await page.screenshot({ path: path.join(evidence, `quota-${width}-${theme}-${language}-stale.png`), fullPage: true });

      for (const next of ['omitted', 'omitted-reverse']) {
        await refresh(next);
        await card.waitFor({ state: 'hidden' });
        for (const name of ['Claude', 'Codex']) {
          const item = strip.filter({ hasText: name });
          assert.doesNotMatch(await item.getAttribute('title'), resetWords, 'expired or absent reset is omitted');
          assert.equal(await item.innerText(), original.get(name), 'reset does not change visible strip content');
        }
      }
      await refresh('live');
      await card.waitFor();
      await assertFits(page, card, width);
      await page.locator('#wb-host-close').click();
      await page.locator('#wb-side').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#wb-host-open').getAttribute('aria-expanded'), 'false');
      await page.locator('#wb-host-open').click();
      await card.waitFor();
      await page.keyboard.press('Escape');
      await page.locator('#wb-side').waitFor({ state: 'hidden' });
      assert.equal(errors.length, 0, errors.join('\n'));
      console.info(`Account quota browser: ${width}px ${theme} ${language}; live, stale, omitted both runtimes, refresh, close/reopen/Escape`);
    } finally { await context.close(); }
  }
  assert.equal(actions.length, 0, 'viewing account reset details submits no actions');
}
