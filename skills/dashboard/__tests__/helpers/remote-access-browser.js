import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { workbenchAnswer } from '../fixtures/workbench-browser-api.js';
import { startPage } from './workbench-browser.js';
import path from 'node:path';
import { GROUP } from '../fixtures/workbench-browser-api.js';

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
  async function openRemote(refuse, { width = 1280 } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'en-US', timezoneId: 'UTC' });
    sandbox.addCleanup(() => context.close());
    // The observer entry is offered at the technical detail level.
    await context.addInitScript(() => { try { localStorage.setItem('zylos-dashboard-locale', 'en'); localStorage.setItem('zylos-dashboard-detail-level', 'technical'); } catch {} });
    const page = await context.newPage();
    const errors = [], refusals = [], chatRequests = [];
    page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
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
      if (apiPath.startsWith('/api/chat/')) {
        assert.ok(chatRequests.length < 100, 'chat request capture is bounded');
        chatRequests.push(apiPath);
      }
      // No push stream: its every (re)open reads the state again, and a state allowing remote access read after a
      // refusal rightly means the switch is back on. Without it no state is read after the entry read in this case.
      if (apiPath === '/api/stream') return route.abort();
      const kind = apiPath.startsWith('/api/chat/') ? 'chat' : apiPath.startsWith('/api/observer/') ? 'observer' : null;
      if (kind && kind === refuse.now) { refusals.push(apiPath); return route.fulfill({ status: 403, json: REFUSAL }); }
      if (apiPath === '/api/observer/status') return route.fulfill({ json: OBSERVER_STATUS });
      let value = workbenchAnswer(new URL(apiPath + url.search, 'http://fixture'), Date.now());
      if (apiPath === '/api/workbench/groups' && value) value = { ...value, rows: value.rows.map(row => row.sessionGroup === GROUP
        ? { ...row, tools: [], working: { on: false, since: null, turn: null, tools: 0, subagents: null } } : row) };
      if (apiPath === '/api/state' && value) value = { ...value, agent: { name: REMOTE }, chat_allow_remote: refuse.allow !== false };
      return value === undefined ? route.fulfill({ status: 404, json: { error: 'not_found' } }) : route.fulfill({ json: value });
    });
    await page.goto(base + '/');
    await page.locator(`#agent-fleet-root .agent-open[data-agent="${REMOTE}"]`).click();
    await page.waitForFunction(() => !document.querySelector('#agent-detail').hidden);
    return { page, context, errors, refusals, chatRequests };
  }
  const shown = (page, tab) => page.locator(`.tab[data-tab="${tab}"]`).isVisible();
  const activeTab = page => page.evaluate(() => document.querySelector('.tab.active')?.dataset.tab);
  const leftForOverview = page => page.waitForFunction(() => document.querySelector('.tab[data-tab="chat"]').hidden
    && document.querySelector('.tab.active')?.dataset.tab === 'overview' && !document.querySelector('#tab-overview').hidden, null, { timeout: 10_000 });

  // Real permission-state reads and group actions at phone/desktop widths. Run
  // for group conversation entry/remote access wiring; skip unrelated backend
  // work. The shared sandbox owns all loopback HTTP and browser resources.
  for (const width of [390, 1280]) await t.test(`${width}: group conversation action follows the remote access switch`, async () => {
    const policy = { now: null, allow: false };
    const { page, context, errors, chatRequests } = await openRemote(policy, { width });
    try {
      await page.locator(`.wb-row[data-group="${GROUP}"]`).click();
      const side = page.locator('#wb-side'), action = side.locator('[data-action="viewConversation"]');
      await side.waitFor();
      assert.equal(await action.count(), 0);
      assert.equal(await side.locator('.wb-group-head .wb-idle').count(), 1, 'header follows idle working despite busy runtime state');
      assert.match(await side.locator('.wb-now-title').first().innerText(), /Idle/, 'now card uses the same working state');
      assert.equal(chatRequests.length, 0, 'closed remote access makes no chat requests');
      const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
      if (evidence && width === 390) {
        fs.mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: path.join(evidence, 'remote-group-chat-closed-390.png') });
      }
      policy.allow = true;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await action.waitFor();
      if (evidence && width === 390) await page.screenshot({ path: path.join(evidence, 'remote-group-chat-open-390.png') });
      // Retain a previously offered action to exercise a delayed callback after
      // permission closes, the same guard used when returning from observer.
      const stale = await action.elementHandle();
      policy.allow = false;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await action.waitFor({ state: 'detached' });
      const reopened = page.waitForRequest(request => {
        const pathname = new URL(request.url()).pathname;
        return pathname.includes('/api/workbench/groups/') && pathname.endsWith('/runs');
      }, { timeout: 3000 });
      await stale.evaluate(el => el.click());
      await reopened;
      await side.waitFor();
      assert.equal(await activeTab(page), 'overview');
      assert.equal(chatRequests.length, 0, 'delayed conversation action falls back to group overview');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

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
