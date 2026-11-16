import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateToFleetRecord } from '../../src/lib/fleet-poller.js';
import { fleetGroupSummary } from '../../src/lib/workbench/fleet-summary.js';
import { GROUP, workbenchSnapshot, workbenchSnapshotAnswer } from '../fixtures/workbench-browser-api.js';
import { startPage } from './workbench-browser.js';

export async function runCurrentActionBrowser(sandbox, { width, locale }) {
  console.log('Current-action browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const now = Date.now(), since = now - 180000, receivedAt = new Date(now - 60000).toISOString();
  const snapshot = workbenchSnapshot(now), busy = snapshot.rows.find(row => row.sessionGroup === GROUP);
  busy.noResponse = { since };
  busy.preview.timestamp = receivedAt;
  const copy = JSON.parse(fs.readFileSync(new URL(`../../public/i18n/wb.${locale}.json`, import.meta.url), 'utf8'));
  const t = (key, params = {}) => copy[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name]));
  const running = workbenchSnapshotAnswer(new URL('http://fixture/api/groups/running'), snapshot, now);
  const row = running.rows.find(row => row.id === GROUP);
  assert.deepEqual(Object.keys(row).sort(), ['id', 'displayName', 'channel', 'lastActivityAt', 'flags', 'runtime', 'model', 'state', 'duration', 'currentAction', 'mainAgent', 'contextPct'].sort());
  assert.deepEqual(row.currentAction, { tool: 'Bash', message: 'Run the tests again please', receivedAt });
  assert.deepEqual(row.flags.noResponse, { since: new Date(since).toISOString() });
  assert.equal(workbenchSnapshotAnswer(new URL('http://fixture/api/groups/counts'), snapshot, now).running.flags.noResponse, 1);
  const fleet = { agents: [stateToFleetRecord({ name: 'browser-case' }, { state: 'IDLE', session_mode: 'multi', group_summary: fleetGroupSummary(snapshot) }, { self: true, access: 'admin', nowMs: now })], updated_at: new Date(now).toISOString() };
  assert.equal(fleet.agents[0].group_summary.noResponse.count, 1);
  const single = stateToFleetRecord({ name: 'single-case' }, { state: 'IDLE', session_mode: 'single',
    model: 'sentinel-origin-model', effort: 'sentinel-origin-effort', context_pct: 987, new_session_threshold: 654 },
  { access: 'admin', nowMs: now });
  fleet.agents.push(single);
  for (const agent of fleet.agents) for (const field of ['model', 'effort', 'context_pct', 'new_session_threshold'])
    assert.equal(Object.hasOwn(agent, field), false, `Fleet omits removed Origin field ${field}`);

  const { base } = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: locale === 'zh' ? 'zh-CN' : 'en-US', timezoneId: 'UTC' });
  sandbox.addCleanup(() => context.close());
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const apiReads = [];
  await context.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET') apiReads.push(url.pathname);
    if (url.pathname === '/api/fleet') return route.fulfill({ json: fleet });
    const answer = workbenchSnapshotAnswer(url, snapshot, now);
    return answer === undefined ? route.fallback() : route.fulfill({ json: answer });
  });
  await context.addInitScript(({ locale }) => {
    if (window !== window.top) return;
    localStorage.setItem('zylos-dashboard-locale', locale);
    localStorage.setItem('zylos-dashboard-theme', locale === 'zh' ? 'light' : 'dark');
    localStorage.setItem('zylos-dashboard-detail-level', 'plain');
  }, { locale });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, `current-contract-${width}-${locale}-${name}.png`) }); };
  await page.goto(base);
  const card = page.locator('.wb-f-card[data-self="true"]');
  await card.waitFor();
  assert.ok((await card.locator('.wb-f-running').innerText()).includes(`1 ${t('wb.fleet.state.no_response')}`));
  assert.equal(await card.locator('.wb-f-problem-reason').innerText(), `${t('wb.fleet.reason.no_response')} ${t('wb.fleet.groupDuration', { count: 3 })}`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await shot('fleet');
  await page.locator('#wb-tech-btn').evaluate(node => node.click());
  const singleCard = page.locator('.wb-f-card[data-agent="single-case"]');
  assert.equal(await card.locator('.wb-f-sub .wb-tech').count(), 0, 'Fleet technical chrome has no Origin model/effort');
  assert.equal(await singleCard.locator('.wb-f-kv [title]').count(), 0, 'single-mode Fleet has no context/threshold cell');
  assert.doesNotMatch(await page.locator('#agent-fleet-root').innerText(), /sentinel-origin-|987|654/);
  assert.equal(apiReads.filter(path => path === '/api/groups/origin').length, 0, 'Fleet loads no extra Origin detail');
  await shot('fleet-technical');
  await page.locator('#wb-tech-btn').evaluate(node => node.click());
  await card.locator('.agent-open').click();
  await page.waitForFunction(() => !document.querySelector('#agent-detail').hidden
    && document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity));
  const boardRow = page.locator(`#wb-board [data-group="${GROUP}"]`), current = boardRow.locator('.wb-current');
  await current.waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await current.locator('.wb-tool-label').innerText(), t('wb.tool.Bash'));
  assert.ok((await current.innerText()).includes(t('wb.board.lastIn', { text: 'Run the tests again please' })));
  const badge = boardRow.locator('.wb-state-flags .wb-tag').filter({ hasText: t('wb.flags.noResponse') });
  assert.equal(await badge.count(), 1);
  assert.ok((await badge.getAttribute('title')).includes(new Date(since).toISOString()));
  const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, items: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map(el => ({ tag: el.tagName, class: el.className, right: el.getBoundingClientRect().right })) }));
  assert.ok(overflow.scroll <= overflow.width, JSON.stringify(overflow));
  await shot('tool-message');
  await page.locator('#wb-tech-btn').evaluate(node => node.click());
  await page.waitForFunction(group => document.querySelector(`#wb-board [data-group="${group}"] .wb-current`)?.textContent === 'Bash', GROUP);
  assert.equal(await current.innerText(), 'Bash', 'technical list exposes the tool name without arguments');
  await page.locator('#wb-tech-btn').evaluate(node => node.click());
  busy.tools = [];
  {
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/groups/running');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await refreshed;
  }
  await page.waitForFunction(({ group, message }) => document.querySelector(`#wb-board [data-group="${group}"] .wb-current`)?.textContent.includes(message), { group: GROUP, message: 'Run the tests again please' });
  assert.equal(await current.innerText(), t('wb.board.lastReceived', { text: 'Run the tests again please' }));
  busy.preview.text = null;
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/groups/running');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await refreshed;
  const time = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' }).format(new Date(receivedAt));
  const expected = t('wb.board.lastReceivedAt', { channel: t('wb.platform.telegram'), time });
  await page.waitForFunction(({ group, expected }) => document.querySelector(`#wb-board [data-group="${group}"] .wb-current`)?.textContent === expected, { group: GROUP, expected });
  assert.equal(await current.innerText(), expected, 'receivedAt survives the compact list and renders with the instance timezone');
  await shot('received-time');
  assert.equal(apiReads.filter(path => path === '/api/groups/origin').length, 0, 'list presentation needs no Origin detail request');
  assert.deepEqual(errors, []);
}
