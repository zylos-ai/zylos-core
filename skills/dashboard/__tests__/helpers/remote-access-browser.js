import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { workbenchAnswer } from '../fixtures/workbench-browser-api.js';
import { startPage } from './workbench-browser.js';

const REMOTE = 'spark';
const REFUSAL = { error: 'remote_chat_disabled', message: '对方实例未允许远端访问对话和终端' };
// An installed, enabled observer on the remote, so its observer entry is offered.
const OBSERVER_STATUS = { state: 'installed', desired: { enabled: true, generation: 1, teardownFence: false }, sessionMode: 'multi',
  target: { sessionGroup: 'origin', runId: 'run-origin', runtime: 'claude' }, runtime: { state: 'idle' }, agentSize: { cols: 120, rows: 40 } };

// The real page in a local browser viewing a remote machine whose state, read on entry, still allows remote access
// (`chat_allow_remote: true`); its conversation or observer requests are then refused as the remote's Dashboard
// refuses them once the switch is turned off.
export async function runRemoteAccessBrowser(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE, executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath), 'ZYLOS_CHAT_BROWSER_MODULE names the Playwright module');
  assert.ok(executablePath && fs.existsSync(executablePath), 'ZYLOS_CHAT_BROWSER_BIN names the browser');
  console.log('Remote access browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const { base } = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());

  // `refuse` names what the remote refuses right now: 'chat', 'observer' or nothing.
  async function openRemote(refuse) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'UTC' });
    sandbox.addCleanup(() => context.close());
    // The observer entry is offered at the technical detail level.
    await context.addInitScript(() => { try { localStorage.setItem('zylos-dashboard-locale', 'en'); localStorage.setItem('zylos-dashboard-detail-level', 'technical'); } catch {} });
    const page = await context.newPage();
    const errors = [], refusals = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (!url.href.startsWith(base + '/')) return route.abort();
      if (url.pathname === '/api/fleet') {
        const machine = (name, extra = {}) => ({ name, state: 'IDLE', access: 'admin', health_reason: null, pulse_rate: 1, updated_at: new Date().toISOString(), ...extra });
        return route.fulfill({ json: { agents: [machine('browser-case', { self: true }), machine(REMOTE)], updated_at: new Date().toISOString() } });
      }
      const remote = url.pathname.match(/^\/fleet\/([^/]+)(\/api\/.*)$/);
      if (!remote) return route.fallback();
      const apiPath = remote[2];
      // No push stream: its every (re)open reads the state again, and a state allowing remote access read after a
      // refusal rightly means the switch is back on. Without it no state is read after the entry read in this case.
      if (apiPath === '/api/stream') return route.abort();
      const kind = apiPath.startsWith('/api/chat/') ? 'chat' : apiPath.startsWith('/api/observer/') ? 'observer' : null;
      if (kind && kind === refuse.now) { refusals.push(apiPath); return route.fulfill({ status: 403, json: REFUSAL }); }
      if (apiPath === '/api/observer/status') return route.fulfill({ json: OBSERVER_STATUS });
      let value = workbenchAnswer(new URL(apiPath + url.search, 'http://fixture'), Date.now());
      if (apiPath === '/api/state' && value) value = { ...value, agent: { name: REMOTE }, chat_allow_remote: true };
      return value === undefined ? route.fulfill({ status: 404, json: { error: 'not_found' } }) : route.fulfill({ json: value });
    });
    await page.goto(base + '/');
    await page.locator(`#agent-fleet-root .agent-open[data-agent="${REMOTE}"]`).click();
    await page.waitForFunction(() => !document.querySelector('#agent-detail').hidden);
    return { page, context, errors, refusals };
  }
  const shown = (page, tab) => page.locator(`.tab[data-tab="${tab}"]`).isVisible();
  const activeTab = page => page.evaluate(() => document.querySelector('.tab.active')?.dataset.tab);
  const leftForOverview = page => page.waitForFunction(() => document.querySelector('.tab[data-tab="chat"]').hidden
    && document.querySelector('.tab.active')?.dataset.tab === 'overview' && !document.querySelector('#tab-overview').hidden, null, { timeout: 10_000 });

  await t.test('a conversation request refused while the conversation tab is open hides the tab and returns to the overview', async () => {
    const refuse = { now: null };
    const { page, context, errors, refusals } = await openRemote(refuse);
    assert.equal(await shown(page, 'chat'), true, 'the remote state allows remote access');
    refuse.now = 'chat';
    await page.locator('.tab[data-tab="chat"]').click();
    await leftForOverview(page);
    assert.ok(refusals.some(path => path.startsWith('/api/chat/')), 'the conversation page met the refusal');
    assert.equal(await page.locator('#tab-chat').isVisible(), false);
    assert.equal(await page.locator('#observer-tab').isVisible(), false, 'the observer entry follows');
    // Asking for the conversation tab again keeps the overview.
    await page.evaluate(() => document.querySelector('.tab[data-tab="chat"]').click());
    assert.equal(await activeTab(page), 'overview');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await t.test('an observer request refused while opening the observer hides both tabs and returns to the overview', async () => {
    const refuse = { now: null };
    const { page, context, errors, refusals } = await openRemote(refuse);
    await page.locator('#observer-tab').waitFor({ state: 'visible' });
    assert.equal(await shown(page, 'chat'), true, 'the remote state allows remote access');
    refuse.now = 'observer';
    await page.locator('#observer-tab').click();
    await leftForOverview(page);
    assert.ok(refusals.some(path => path.startsWith('/api/observer/')), 'the observer met the refusal');
    assert.equal(await page.locator('#observer-tab').isVisible(), false);
    assert.equal(await page.locator('#tab-observer').isVisible(), false);
    assert.deepEqual(errors, []);
    await context.close();
  });
}
