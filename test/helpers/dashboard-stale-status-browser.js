import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJsonSample, sampleResult } from '../../cli/lib/session-usage-reader.js';
import { collectStatus } from '../../cli/lib/status-view.js';
import { classify, countRows } from '../../skills/dashboard/src/lib/workbench/group-state.js';
import { sendHtml, sendJson, serveStatic } from '../../skills/dashboard/src/lib/http.js';
import { GROUP, workbenchAnswer } from '../../skills/dashboard/__tests__/fixtures/workbench-browser-api.js';
import { openDashboardTab } from '../../skills/dashboard/__tests__/helpers/browser-navigation.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../skills/dashboard/public/', import.meta.url)));
const ID = 'g:' + Buffer.from(GROUP).toString('hex').toUpperCase();
const identity = { present: true, ready: true, runId: 'run-stale', sessionId: 'session-stale', runtime: 'claude' };

export async function runStaleStatusBrowser(t, sandbox) {
  console.info('Stale status browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const file = path.join(sandbox.paths.zylos, 'activity-monitor/session-groups', GROUP, 'agent-status.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ state: 'busy', health: 'ok', runId: identity.runId, sessionId: identity.sessionId, idle_seconds: 0 }));
  // A stopped writer: the filesystem mtime is the actual setup time and never changes.
  const sampledAt = fs.statSync(file).mtimeMs;
  const idleFile = path.join(path.dirname(file), 'idle-status.json');
  fs.writeFileSync(idleFile, JSON.stringify({ state: 'idle', health: 'ok', runId: identity.runId, sessionId: identity.sessionId, idle_seconds: 4 }));
  const streams = new Set(), errors = [], captures = [], reads = [];
  let sampleMode = 'file';
  async function snapshot(url) {
    const now = Date.now();
    const data = workbenchAnswer(url, now);
    const status = await collectStatus({ mode: () => ({ mode: 'multi' }), list: () => [],
      session: async () => ({ identity, status: sampleResult(sampleMode === 'missing' ? null : readJsonSample(sampleMode === 'idle' ? idleFile : file, 'status'), identity, identity, 5000, now) }),
      runtimes: [], facts: async () => ({ originNeed: null }), configIssue: () => null, resolveRoot: () => sandbox.paths.zylos, now: () => now });
    const row = data.rows.find(row => row.sessionGroup === GROUP);
    row.live = status.origin;
    row.state = classify(row, { now });
    row.name = { displayName: '状态刷新已停止的会话' };
    row.tools = []; row.wait = null; row.working = { on: true, turn: { since: sampledAt - 1000 }, subagents: null };
    row.queue = { known: true, pending: { count: 0 }, running: { count: 0 }, fence: null };
    row.duration = null;
    data.rows = [row]; data.counts = countRows(data.rows);
    if (reads.length < 100) reads.push({ at: now, age: now - sampledAt, state: row.state, status: row.live.status });
    return data;
  }
  const conversation = { id: ID, localId: 'stale-browser', sessionGroup: GROUP, channel: 'telegram', state: 'active', displayName: '状态刷新已停止的会话' };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`event: chat_ready\ndata: ${JSON.stringify({ version: 1, tab: 'mine', conversationId: url.searchParams.get('chat_conversation'), ids: [] })}\n\n`);
        streams.add(res); res.on('close', () => streams.delete(res)); return;
      }
      if (url.pathname === '/api/workbench/groups') return sendJson(res, 200, await snapshot(url));
      if (url.pathname === '/api/chat/conversations') return sendJson(res, 200, { items: [{ ...conversation, session_group: GROUP, display_name: conversation.displayName }], nextCursor: null, tz: 'UTC' });
      if (url.pathname.startsWith('/api/chat/conversations/')) {
        const p = url.pathname;
        const value = p.endsWith('/messages') ? { items: [{ id: 1, direction: 'in', channel: 'telegram', content: '核对最后一次会话状态', timestamp: new Date(sampledAt).toISOString() }], nextCursor: null, afterCursor: 'after-1', tz: 'UTC' }
          : p.endsWith('/activity') ? { now: new Date().toISOString(), items: [] }
          : p.endsWith('/status') || p.endsWith('/questions') ? { items: [], nextCursor: null }
          : { conversation, stored: true, conversationId: ID, deliveryState: null, error: null };
        return sendJson(res, 200, value);
      }
      if (url.pathname.startsWith('/api/')) {
        const value = workbenchAnswer(url, Date.now());
        return sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' });
      }
      if (['/', '/chat'].includes(url.pathname)) return sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin'));
      if (serveStatic(req, res, publicDir)) return;
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) { console.error('Stale API failure:', error.stack); sendJson(res, 500, { error: error.message }); }
  });
  sandbox.addCleanup(() => { for (const stream of streams) stream.end(); });
  const base = await sandbox.startHttp(server);
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const pages = [];
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, locale: 'zh-CN' });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    await context.addInitScript(({ theme }) => { try { localStorage.setItem('zylos-dashboard-theme', theme); localStorage.setItem('zylos-dashboard-locale', 'zh'); } catch {} }, { theme });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('response', response => { if (response.status() >= 400) console.error('Browser HTTP:', response.status(), response.url()); });
    page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
    await page.goto(base + '/');
    try { await page.locator('.wb-row[data-group]').first().waitFor(); } catch (error) { console.error('Stale mount failure:', JSON.stringify({ errors, reads, body: (await page.locator('body').innerText()).slice(0, 3000) })); throw error; }
    pages.push({ page, width, theme });
  }
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  async function shot(page, name) {
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal document overflow');
    await page.mouse.move(0, 0);
    if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png'), animations: 'disabled' });
    captures.push({ name, ageMs: Date.now() - sampledAt });
  }
  async function waitAge(age) {
    const remaining = sampledAt + age - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  }
  async function check(element, stale, kind = 'busy') {
    await element.filter({ hasText: stale ? /秒前/ : /未知/ }).waitFor({ state: 'visible' });
    const text = await element.innerText();
    if (stale) {
      assert.match(text, kind === 'idle' ? /空闲/ : /忙|工作/);
      assert.match(text, /\d+\s*秒前/);
      const age = element.locator('.wb-status-age');
      assert.equal(await age.isVisible(), true);
      const style = await element.evaluate(root => { const node = root.querySelector('.wb-status-age'), css = getComputedStyle(node); return { color: css.color, font: parseFloat(css.fontSize), parentFont: parseFloat(getComputedStyle(root).fontSize) }; });
      assert.ok(style.font <= style.parentFont, 'age stays auxiliary text');
    } else {
      assert.match(text, /未知/);
      assert.match(await element.getAttribute('title'), /最后一次状态.*忙.*前/);
      assert.equal(await element.locator('.wb-status-age').count(), 0);
    }
  }
  await waitAge(19000);
  for (const f of pages) {
    await f.page.reload();
    await check(f.page.locator('.wb-row[data-group] .wb-state').first(), true);
    await shot(f.page, `stale-${f.width}-${f.theme}-overview`);
    await openDashboardTab(f.page, 'chat');
    await f.page.locator(`#wb-chat [data-conversation-id="${ID}"]`).click();
    await f.page.locator('#wb-chat .conversation-message').first().waitFor();
    await check(f.page.locator('.conversation-running'), true);
    await shot(f.page, `stale-${f.width}-${f.theme}-conversation`);
  }
  // Idle has a distinct phone rule: recent stale idle remains visible, fresh idle stays compact/hidden.
  sampleMode = 'idle';
  for (const f of pages.filter(f => f.width === 390)) {
    await f.page.reload();
    await f.page.locator(`#wb-chat [data-conversation-id="${ID}"]`).click();
    await check(f.page.locator('.conversation-running'), true, 'idle');
    await shot(f.page, `stale-idle-${f.width}-${f.theme}-conversation`);
  }
  sampleMode = 'file';
  await waitAge(62000);
  for (const f of pages) {
    await f.page.waitForFunction(() => document.querySelector('.conversation-running')?.textContent.includes('未知'));
    await f.page.locator('.conversation-running').waitFor();
    await check(f.page.locator('.conversation-running'), false);
    await shot(f.page, `unknown-${f.width}-${f.theme}-conversation`);
    if (f.width <= 760) await f.page.locator('#wb-chat .conversation-back').click();
    await openDashboardTab(f.page, 'overview');
    await check(f.page.locator('.wb-row[data-group] .wb-state').first(), false);
    await shot(f.page, `unknown-${f.width}-${f.theme}-overview`);
  }
  // No sample carries no last-state tooltip, even if event-derived working is still on.
  sampleMode = 'missing';
  await pages[0].page.reload();
  const unknown = pages[0].page.locator('.wb-row[data-group] .wb-state').first();
  await unknown.waitFor(); assert.match(await unknown.innerText(), /未知/);
  assert.doesNotMatch(await unknown.getAttribute('title') ?? '', /最后一次状态/);
  await openDashboardTab(pages[0].page, 'chat');
  await pages[0].page.locator(`#wb-chat [data-conversation-id="${ID}"]`).click();
  const missingHeader = pages[0].page.locator('.conversation-running');
  await missingHeader.waitFor(); assert.match(await missingHeader.innerText(), /未知/);
  assert.doesNotMatch(await missingHeader.getAttribute('title') ?? '', /最后一次状态/);
  assert.equal(fs.statSync(file).mtimeMs, sampledAt, 'no status writer refreshed the sample');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.info('Stale status captures:', JSON.stringify(captures));
  if (evidence) fs.writeFileSync(path.join(evidence, 'observations.json'), JSON.stringify({ sampledAt, captures, reads, errors }, null, 2));
}
