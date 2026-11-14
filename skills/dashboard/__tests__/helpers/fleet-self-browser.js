import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateToFleetRecord } from '../../src/lib/fleet-poller.js';
import { fleetGroupSummary } from '../../src/lib/workbench/fleet-summary.js';
import { workbenchAnswer } from '../fixtures/workbench-browser-api.js';
import { startPage } from './workbench-browser.js';

// Fixtures use the production conversion so a self-only offline regression cannot be hidden by a hand-built
// healthy record. Remote transport failure is explicit: it is distinct from the remote's runtime state UNKNOWN.
function records(state, unreachable, now, snapshot = null) {
  const make = (name, self) => stateToFleetRecord({ name }, {
    state,
    ...(self && snapshot ? { session_mode: snapshot.mode, group_summary: fleetGroupSummary(snapshot) } : {}),
  }, { self, access: 'admin', nowMs: now });
  const own = make('browser-case', true);
  assert.equal(own.pulse_rate, 1, `${state}: responding local HTTP is reachable`);
  assert.equal(own.health_reason, state === 'IDLE' ? 'idle' : 'ok');
  const remote = make('remote-case', false);
  if (unreachable) Object.assign(remote, { state: 'UNKNOWN', pulse_rate: 0, health_reason: 'unreachable' });
  return { agents: [own, remote], updated_at: new Date(now).toISOString() };
}

export async function runFleetSelfBrowser(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE, executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath), 'explicit preinstalled Playwright module required');
  assert.ok(executablePath && fs.existsSync(executablePath), 'explicit preinstalled browser required');
  const chartAsset = process.env.ZYLOS_CHAT_CHART_ASSET;
  assert.ok(chartAsset && fs.existsSync(chartAsset), 'explicit preinstalled Chart.js asset required');
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const { base } = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(async () => {
    await browser.close();
    assert.equal(browser.isConnected(), false, 'browser connection reclaimed');
    console.log('Fleet browser connection reclaimed');
  });

  await t.test('390px Chinese unknown label uses the page translation', async () => {
    const now = Date.now(), fleet = records('UNKNOWN', false, now);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true });
    sandbox.addCleanup(() => context.close());
    try {
      await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
      await context.route('**/_assets/vendor/chart.umd.js', route => route.fulfill({ path: chartAsset, contentType: 'text/javascript' }));
      await context.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
      await context.addInitScript(() => {
        try { localStorage.setItem('zylos-dashboard-locale', 'zh'); } catch {}
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      await page.route('**/api/fleet', route => route.fulfill({ json: fleet }));
      await page.goto(base + '/');
      const label = page.locator('#agent-fleet-root .wb-f-card[data-self="true"] [data-mood="unknown"]');
      await label.waitFor();
      assert.equal(await label.innerText(), '未知');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (evidence) await page.screenshot({ path: path.join(evidence, 'self-unknown-zh-390.png'), fullPage: true });
    } finally { await context.close(); }
  });

  for (const width of [390, 1280]) for (const mode of ['single', 'multi']) {
    // Reachable self state stays independent of its API group_summary and remote transport failure.
    for (const [state, unreachable] of [['UNKNOWN', false], ['IDLE', false], ['UNKNOWN', true]]) {
      await t.test(`${width}px ${mode}: ${state} self, ${unreachable ? 'unreachable' : state} remote`, async () => {
        const now = Date.now();
        const snapshot = workbenchAnswer(new URL('/api/workbench/groups', base), now);
        // This case has three running/starting groups. The shared Workbench fixture includes a
        // reclaimed row, which must be starting here: Fleet totals now exclude not_running groups.
        snapshot.mode = snapshot.view = mode;
        snapshot.rows = snapshot.rows.map(row => row.presence === 'not_running'
          ? { ...row, presence: 'starting', state: { kind: 'waiting' } } : row);
        snapshot.counts = { ...snapshot.counts, waiting: 1, not_running: 0 };
        snapshot.instance.pool = { ...snapshot.instance.pool, used: 3, starting: 1, ready: 2 };
        const fleet = records(state, unreachable, now, snapshot);
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 },
          locale: 'en-US', ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
        sandbox.addCleanup(() => context.close());
        try {
          // Only this fixture's loopback origin may be requested; no remote accounts or live services.
          await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
          await context.route('**/_assets/vendor/chart.umd.js', route => route.fulfill({ path: chartAsset, contentType: 'text/javascript' }));
          await context.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
          await context.addInitScript(() => {
            try {
              localStorage.setItem('zylos-dashboard-locale', 'en');
              localStorage.setItem('zylos-dashboard-detail-level', 'technical');
            } catch {} // Dashboard's sandboxed preview iframe has no storage access.
          });
          const page = await context.newPage(), errors = [];
          page.setDefaultTimeout(10_000);
          page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
          // Blocked external font requests are expected under the loopback-only boundary.
          page.on('console', message => { if (message.type() === 'error' && !message.text().includes('net::ERR_FAILED') && errors.length < 5) errors.push(message.text()); });
          await page.route('**/api/**', async route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/api/fleet') return route.fulfill({ json: fleet });
            if (url.pathname === '/api/state') return route.fulfill({ json: { ...workbenchAnswer(url, now), state,
              session_mode: mode, group_summary: fleet.agents[0].group_summary } });
            if (url.pathname === '/api/workbench/groups') return route.fulfill({ json: snapshot });
            return route.fallback();
          });
          await page.goto(base + '/');
          const own = page.locator('#agent-fleet-root .wb-f-card[data-self="true"]');
          await own.waitFor();
          await page.waitForFunction(mode => document.querySelector('.wb-f-card[data-self="true"] .wb-mode-tag')?.textContent ===
            (mode === 'multi' ? 'Multi-session' : 'Single session'), mode);
          assert.equal(await own.getAttribute('data-state'), state === 'UNKNOWN' ? 'unknown' : 'idle');
          assert.equal(await own.locator('.agent-open').isVisible(), true, 'self remains openable');
          assert.equal(await own.locator('.wb-f-reason, [data-fleet-action]').count(), 0, 'no offline self card or recovery actions');
          assert.doesNotMatch(await own.getAttribute('class'), /\bbad\b/);
          assert.doesNotMatch(await own.innerText(), /offline|unreachable/i);
          if (state === 'UNKNOWN') assert.equal(await own.locator('[data-mood="unknown"]').innerText(), 'Unknown');
          else if (mode === 'single') assert.equal(await own.locator('[data-mood="idle"]').innerText(), 'Idle');
          if (mode === 'multi') assert.match(await own.innerText(), /3 groups/);

          const remote = page.locator('#agent-fleet-root .wb-f-card[data-agent="remote-case"]');
          assert.equal(await remote.getAttribute('data-state'), unreachable ? 'offline' : state === 'UNKNOWN' ? 'unknown' : 'idle');
          assert.equal(await remote.locator('.wb-f-reason').count(), unreachable ? 1 : 0);
          if (unreachable) assert.match(await remote.locator('.agent-fleet-reason').innerText(), /Unreachable/);
          else if (state === 'UNKNOWN') assert.equal(await remote.locator('[data-mood="unknown"]').innerText(), 'Unknown');
          const offlineSummary = page.locator('.agent-fleet-summary .sum-seg').filter({ has: page.locator('.dot-offline') });
          assert.equal(await offlineSummary.innerText(), `${unreachable ? 1 : 0} Offline`, 'only remote transport failure contributes to offline count');
          if (!unreachable) assert.doesNotMatch(await page.locator('#fleet-view').innerText(), /\b[1-9]\d*\s+(?:unreachable|offline)\b/i);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
          assert.deepEqual(errors, [], 'no page or console errors');
          if (evidence && state === 'UNKNOWN' && !unreachable) {
            const filename = path.join(evidence, `self-unknown-${mode}-${width}.png`);
            await page.screenshot({ path: filename, fullPage: true });
            console.log('Fleet UNKNOWN screenshot:', filename);
          }
        } finally { await context.close(); }
      });
    }
  }
}
