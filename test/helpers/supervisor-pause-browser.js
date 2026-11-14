import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateToFleetRecord } from '../../skills/dashboard/src/lib/fleet-poller.js';
import { buildAttention } from '../../skills/dashboard/src/lib/workbench/attention.js';
import { workbenchAnswer } from '../../skills/dashboard/__tests__/fixtures/workbench-browser-api.js';
import { startPage } from '../../skills/dashboard/__tests__/helpers/workbench-browser.js';
import { openDashboardTab } from '../../skills/dashboard/__tests__/helpers/browser-navigation.js';

const pauseText = 'Supervisor has paused new actions';
const warningColor = 'rgb(214, 155, 53)';

async function assertWarningColor(page, selector, property, label) {
  await page.waitForFunction(({ selector, property, color }) => {
    const node = document.querySelector(selector);
    return node && getComputedStyle(node)[property] === color;
  }, { selector, property, color: warningColor });
  assert.equal(await page.locator(selector).evaluateAll((nodes, property) => getComputedStyle(nodes[0])[property], property),
    warningColor, label);
}

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

export async function runSupervisorPauseBrowser(sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
  const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  const chartAsset = process.env.ZYLOS_CHAT_CHART_ASSET;
  for (const filename of [modulePath, executablePath, chartAsset]) {
    assert.ok(filename && fs.existsSync(filename), 'explicit local Playwright, browser and Chart.js assets required');
  }
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const { base, actions } = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(modulePath));
  sandbox.assertIsolation();
  const server = await chromium.launchServer({ executablePath, headless: true, env: sandbox.env, timeout: 15_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => stopBrowser(server));
  const browser = await chromium.connect(server.wsEndpoint(), { timeout: 15_000 });

  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    const now = Date.now();
    let paused = false;
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 },
      locale: 'en-US', ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
    sandbox.addCleanup(() => context.close());
    try {
      await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
      await context.route('**/_assets/vendor/chart.umd.js', route => route.fulfill({ path: chartAsset, contentType: 'text/javascript' }));
      await context.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
      await context.addInitScript(theme => {
        try {
          localStorage.setItem('zylos-dashboard-locale', 'en');
          localStorage.setItem('zylos-dashboard-theme', theme);
        } catch {}
      }, theme);
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(10_000);
      page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
      await page.route('**/api/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/fleet') {
          const record = (name, self, supervisorPaused) => stateToFleetRecord({ name },
            { state: 'IDLE', supervisor_paused: supervisorPaused }, { self, access: 'admin', nowMs: now });
          // Local live snapshot wins over a stale healthy Fleet record; remote state comes from Fleet.
          return route.fulfill({ json: { agents: [record('browser-case', true, false),
            record('remote-case', false, paused)], updated_at: new Date(now).toISOString() } });
        }
        if (url.pathname === '/api/workbench/groups') {
          const snapshot = workbenchAnswer(url, now);
          snapshot.instance.supervisorPaused = paused;
          snapshot.attention = buildAttention(snapshot);
          return route.fulfill({ json: snapshot });
        }
        return route.fallback();
      });
      await page.goto(base + '/');
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      const own = page.locator('#agent-fleet-root .wb-f-card[data-self="true"]');
      const remote = page.locator('#agent-fleet-root .wb-f-card[data-agent="remote-case"]');
      await own.waitFor();
      await remote.waitFor();
      for (const [phase, value] of [['healthy', false], ['paused', true], ['recovered', false]]) {
        paused = value;
        const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/groups');
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await refreshed;
        for (const [card, selector] of [[own, '.wb-f-card[data-self="true"]'], [remote, '.wb-f-card[data-agent="remote-case"]']]) {
          await card.locator('[data-supervisor-paused]').waitFor({ state: value ? 'visible' : 'detached' });
          if (value) {
            const reason = card.locator('[data-supervisor-paused]');
            assert.equal(await reason.innerText(), pauseText);
            await assertWarningColor(page, `#agent-fleet-root ${selector} [data-supervisor-paused]`, 'color',
              `${width}px ${theme} Fleet pause uses the warning color after the full stylesheet cascade`);
          }
          assert.equal(await card.getAttribute('data-state'), 'idle', 'pause does not invent a runtime failure');
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px Fleet fits`);
        if (evidence) await page.screenshot({ path: path.join(evidence, `supervisor-fleet-${width}-${theme}-${phase}.png`), fullPage: true });
      }

      await own.locator('.agent-open').click();
      await openDashboardTab(page, 'overview');
      await page.locator('#fleet-view').waitFor({ state: 'hidden' });
      await page.evaluate(() => document.activeElement?.blur());
      await page.mouse.move(0, 0);
      const attention = page.locator('#wb-attention .wb-attention-item').filter({ hasText: pauseText });
      for (const [phase, value] of [['healthy', false], ['paused', true], ['recovered', false]]) {
        paused = value;
        const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/groups');
        // Exercise the production foreground refresh handler rather than injecting DOM or calling a renderer.
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await refreshed;
        await attention.waitFor({ state: value ? 'visible' : 'detached' });
        if (value) {
          assert.equal(await attention.locator('b').innerText(), pauseText);
          await assertWarningColor(page, '#wb-attention .wb-attention-item', 'borderLeftColor',
            `${width}px ${theme} Dashboard pause border uses the warning color`);
          await assertWarningColor(page, '#wb-attention .wb-attention-item > .wb-ico', 'color',
            `${width}px ${theme} Dashboard pause icon uses the warning color`);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px Dashboard fits`);
        if (evidence) await page.screenshot({ path: path.join(evidence, `supervisor-dashboard-${width}-${theme}-${phase}.png`), fullPage: true });
      }
      assert.deepEqual(errors, [], `${width}px has no page errors`);
      console.log(`Supervisor pause browser: ${width}px ${theme} Fleet local/remote and Dashboard healthy -> paused -> recovered`);
    } finally { await context.close(); }
  }
  assert.deepEqual(actions, [], 'observation and recovery never submit a Dashboard action');
}
