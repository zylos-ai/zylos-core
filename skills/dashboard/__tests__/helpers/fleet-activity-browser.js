import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateToFleetRecord } from '../../src/lib/fleet-poller.js';
import { fleetGroupSummary } from '../../src/lib/workbench/fleet-summary.js';
import { startPage } from './workbench-browser.js';

export async function runFleetActivityBrowser(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
  const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  const chartAsset = process.env.ZYLOS_CHAT_CHART_ASSET;
  for (const filename of [modulePath, executablePath, chartAsset]) assert.ok(filename && fs.existsSync(filename));
  console.log('Fleet activity isolation:', JSON.stringify(sandbox.assertIsolation()));
  const { base } = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  for (const width of [1280, 390]) for (const [state, label, kind] of [
    ['BUSY', 'Working', 'busy'], ['IDLE', 'Idle', 'idle'],
    ['UNKNOWN', 'Unknown', 'unknown'], ['AUTH_WAIT', 'Waiting for authentication', 'waiting'],
  ]) {
    await t.test(`${width}px ${state} cards show state without an action row`, async () => {
      const groupSummary = fleetGroupSummary({ mode: 'multi', listKnown: true,
        rows: [{ sessionGroup: 'origin', presence: 'running', state: { kind } }],
        instance: { pool: { used: 1, capacity: 4 } } });
      const agents = ['single', 'multi'].map(mode => stateToFleetRecord({ name: `${mode}-session` }, {
        state, session_mode: mode, group_summary: mode === 'multi' ? groupSummary : null,
      }));
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 } });
      try {
        await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
        await context.route('**/_assets/vendor/chart.umd.js', route => route.fulfill({ path: chartAsset, contentType: 'text/javascript' }));
        await context.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
        await context.addInitScript(() => {
          try { localStorage.setItem('zylos-dashboard-locale', 'en'); } catch {} // Preview iframe has no storage access.
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/api/fleet', route => route.fulfill({ json: { agents } }));
        await page.goto(base + '/');
        const single = page.locator('#agent-fleet-root [data-agent="single-session"].wb-f-card');
        const multi = page.locator('#agent-fleet-root [data-agent="multi-session"].wb-f-card');
        await single.waitFor();
        assert.equal(await single.locator('[data-mood]').innerText(), label);
        assert.equal(await single.locator('.wb-f-act > :not(.wb-pill)').count(), 0, 'only the state pill remains');
        assert.doesNotMatch(await single.innerText(), /Standing by/);
        assert.ok((await multi.locator('.wb-f-running').innerText()).includes(`1 ${kind === 'busy' ? 'working' : kind}`));
        if (state !== 'UNKNOWN') assert.match(await multi.innerText(), /All normal/);
        assert.equal(await multi.locator('.wb-f-act > span[title]').count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.deepEqual(errors, []);
        if (evidence) await page.screenshot({ path: path.join(evidence, `fleet-state-${state.toLowerCase()}-${width}.png`), fullPage: true });
      } finally { await context.close(); }
    });
  }
}
