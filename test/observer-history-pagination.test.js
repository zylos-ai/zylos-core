import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { claudeProjectSlug } from '../skills/dashboard/src/lib/claude-project-path.js';

const record = text => JSON.stringify({ type: 'assistant', timestamp: '2026-01-02T00:00:00.000Z', message: { content: text } }) + '\n';
const ids = Array.from({ length: 80 }, (_, index) => `session-${String(index).padStart(2, '0')}`);

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'history-list-'));
  let port = 0, worker;
  t.after(async () => {
    try { await worker?.terminate(); }
    finally { await fs.rm(home, { recursive: true, force: true }); }
  });
  const zylosDir = path.join(home, 'zylos');
  await fs.mkdir(zylosDir);
  const project = path.join(home, '.claude', 'projects', claudeProjectSlug(zylosDir));
  await fs.mkdir(project, { recursive: true });
  const transcript = path.join(project, `${ids[0]}.jsonl`);
  const messages = Array.from({ length: 500 }, (_, index) => `Entry ${String(index).padStart(3, '0')}${index === 249 ? ' anchor needle' : ''}`);
  await Promise.all(ids.map(async (id, index) => {
    const file = path.join(project, `${id}.jsonl`);
    await fs.writeFile(file, index ? record(id) : messages.map(record).join(''));
    const seconds = 1767312000 - Math.floor(index / 3);
    await fs.utimes(file, seconds, seconds);
  }));
  const stop = async () => {
    if (!worker) return;
    const exit = once(worker, 'exit', { signal: t.signal });
    worker.postMessage('close');
    assert.deepEqual(await exit, [0]);
    worker = null;
  };
  const start = async () => {
    t.signal.throwIfAborted();
    worker = new Worker(new URL('./fixtures/observer-history-server.js', import.meta.url), { workerData: { port, home, zylosDir } });
    [port] = await once(worker, 'message', { signal: t.signal });
    return `http://127.0.0.1:${port}`;
  };
  const origin = await start();
  return { origin, messages, restart: async () => { await stop(); await start(); }, append: text => fs.appendFile(transcript, record(text)) };
}

// Run for history HTTP or transcript paging changes; skip presentation-only changes.
// Requires the isolated Node runner (private HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR).
// Only a loopback worker and synthetic transcripts are used; no tmux or database is opened.
test('history HTTP lists page isolated transcript files, authenticate cursor scope and reject invalid parameters', { timeout: 30000 }, async t => {
  const { origin, messages, append, restart } = await fixture(t);
  const read = async (route, query) => {
    const response = await fetch(`${origin}/api/observer/history/${route}?${new URLSearchParams(query)}`, { signal: t.signal });
    return { status: response.status, body: await response.json() };
  };
  const sessions = (await read('sessions', {})).body;
  assert.deepEqual(sessions.items.map(item => item.id), ids.slice(0, 50));
  const remaining = (await read('sessions', { cursor: sessions.nextCursor, session_group: 'origin' })).body;
  assert.deepEqual(remaining.items.map(item => item.id), ids.slice(50));
  assert.equal(remaining.nextCursor, null);
  assert.equal(Object.hasOwn(remaining, 'total'), false);
  assert.match(sessions.items[0].updatedAt, /Z$/);
  const session = ids[0];
  const entries = async query => (await read('entries', { session, ...query })).body;
  const bodies = page => page.items.map(item => item.fields.body.preview);
  const latest = await entries({});
  assert.deepEqual(bodies(latest), messages.slice(-50));
  assert.ok(latest.afterCursor);
  let all = bodies(latest), cursor = latest.nextCursor;
  for (let pageIndex = 0; pageIndex < 9; pageIndex++) {
    assert.ok(cursor);
    const page = await entries({ cursor });
    all = [...bodies(page), ...all];
    cursor = page.nextCursor;
  }
  assert.equal(cursor, null);
  assert.equal(all.length, messages.length);
  assert.ok(all.every((body, index) => body === messages[index]));
  await append('Appended entry');
  const polled = await entries({ direction: 'after', cursor: latest.afterCursor });
  assert.deepEqual(bodies(polled), ['Appended entry']);
  assert.ok(polled.afterCursor);
  assert.equal((await entries({ direction: 'after', cursor: polled.afterCursor })).items.length, 0);
  const match = (await read('search', { session, q: 'anchor needle' })).body.matches[0];
  const anchored = await entries({ anchor: match.entry, limit: 5 });
  assert.deepEqual(bodies(anchored), messages.slice(247, 252));
  assert.deepEqual(bodies(await entries({ cursor: anchored.nextCursor, limit: 2 })), messages.slice(245, 247));
  assert.deepEqual(bodies(await entries({ cursor: anchored.afterCursor, direction: 'after', limit: 2 })), messages.slice(252, 254));
  for (const [route, query] of [['entries', { session, internal: true, cursor: latest.nextCursor }],
    ['entries', { session: ids[1], cursor: latest.nextCursor }], ['sessions', { cursor: latest.nextCursor }],
    ['sessions', { session_group: 'test:other', cursor: sessions.nextCursor }], ['sessions', { cursor: `${sessions.nextCursor}.bad` }]]) {
    const rejected = await read(route, query);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'invalid_cursor');
  }
  for (const [query, param] of [['bogus=x', 'bogus'], ['limit=1&limit=2', 'limit'], ['limit=0', 'limit'],
    ['limit=101', 'limit'], ['internal=1', 'internal'], ['direction=up', 'direction'], ['anchor=o:1', 'anchor']]) {
    const rejected = await read('entries', `session=${session}&${query}`);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'invalid_parameter');
    assert.equal(rejected.body.error.param, param);
  }
  for (const [route, query] of [['sessions', {}], ['entries', { session }]]) {
    const rejected = await read(route, { ...query, include: 'total' });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.param, 'include');
  }
  const invalidSession = await read('entries', { session: '../invalid' });
  assert.equal(invalidSession.status, 400);
  assert.equal(invalidSession.body.error.param, 'session');
  await restart();
  assert.equal((await read('sessions', { cursor: sessions.nextCursor })).body.error.code, 'invalid_cursor');
  assert.equal((await entries({ cursor: anchored.nextCursor })).error.code, 'invalid_cursor');
  assert.deepEqual(bodies(await entries({ anchor: match.entry, limit: 5 })), bodies(anchored));
});

// Run for history UI, list contract, or responsive control changes; skip unrelated UI or backend changes.
// Requires the isolated Node runner (private HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR)
// plus the browser gate. Chromium sees only the synthetic loopback fixture, with no tmux or database.
test('history browser loads both lists incrementally and recovers after a restart',
  { skip: process.env.ZYLOS_CHAT_INTEGRATION !== '1', timeout: 60000 }, async t => {
    const { origin, append, restart } = await fixture(t);
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const launching = chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, timeout: 15000,
      args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    t.after(async () => { await (await launching.catch(() => null))?.close(); });
    const browser = await launching;
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const selector = name => `[data-history="${name}"]`;
    const waitCount = (query, count) => page.waitForFunction(({ query, count }) => document.querySelectorAll(query).length === count, { query, count });
    const options = `${selector('sessions')} option`;
    const articles = '.history-entry';
    const more = page.locator(selector('more-sessions'));
    const status = page.locator(selector('status'));
    await page.goto(`${origin}/fixture?lang=en&theme=light`);
    await waitCount(options, 50);
    await waitCount(articles, 50);
    await restart();
    const rejectedList = page.waitForResponse(response => response.url().includes('/history/sessions?cursor=') && response.status() === 400);
    const reloadedList = page.waitForResponse(response => response.url().includes('/history/sessions') && !new URL(response.url()).searchParams.has('cursor') && response.status() === 200);
    await more.click();
    await rejectedList; await reloadedList;
    await waitCount(options, 50);
    await more.click();
    await waitCount(options, 80);
    assert.deepEqual(await page.locator(options).evaluateAll(nodes => nodes.map(node => node.value)), ids);
    assert.equal(await more.isVisible(), false);
    assert.equal(await status.textContent(), '');
    const sessions = page.locator(selector('sessions'));
    const offPage = ids.at(-1);
    await sessions.selectOption(offPage);
    await page.locator(articles).filter({ hasText: offPage }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('history-fixture-reactivate')));
    await waitCount(options, 51);
    assert.equal(await sessions.inputValue(), offPage);
    await page.locator(articles).filter({ hasText: offPage }).waitFor();
    await page.locator(selector('internal')).check();
    await page.locator(articles).filter({ hasText: offPage }).waitFor();
    const selectedEntry = await page.locator(articles).elementHandle();
    await restart();
    const staleSelection = page.waitForResponse(response => response.url().includes('/history/sessions?cursor=') && response.status() === 400);
    await more.click();
    await staleSelection;
    await page.waitForFunction(() => !document.querySelector('[data-history="more-sessions"]').disabled);
    assert.equal(await sessions.inputValue(), offPage);
    assert.equal(await selectedEntry.evaluate(element => element.isConnected), true);
    await sessions.selectOption(ids[0]);
    await waitCount(articles, 50);
    const timeline = page.locator(selector('timeline'));
    for (let count = 100; count <= 500; count += 50) {
      await timeline.evaluate(element => { element.scrollTop = 0; });
      await waitCount(articles, count);
    }
    assert.equal(await page.locator(selector('older')).isVisible(), false);
    assert.match(await page.locator(articles).first().textContent(), /Entry 000/);
    await append('Browser append');
    await timeline.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await waitCount(articles, 501);
    assert.match(await page.locator(articles).last().textContent(), /Browser append/);
    await page.locator(selector('query')).fill('anchor needle');
    await page.locator(selector('query')).press('Enter');
    await page.locator('.history-search-match').click();
    await waitCount(articles, 50);
    assert.equal(await timeline.getByText('Entry 249 anchor needle', { exact: true }).count(), 1);
    await restart();
    const anchorReload = page.waitForResponse(response => response.url().includes('/history/entries?') && response.url().includes('&anchor=') && response.status() === 200);
    await timeline.evaluate(element => { element.scrollTop = 0; });
    await anchorReload;
    await waitCount(articles, 50);
    assert.equal(await timeline.getByText('Entry 249 anchor needle', { exact: true }).count(), 1);
    assert.equal(await status.textContent(), '');
    await timeline.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await waitCount(articles, 100);
    const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
    if (evidence) await fs.mkdir(evidence, { recursive: true });
    for (const width of [1280, 390]) for (const lang of ['en', 'zh']) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${origin}/fixture?lang=${lang}&theme=${theme}`);
      await waitCount(articles, 50);
      await more.focus();
      assert.equal(await more.textContent(), lang === 'en' ? 'Load more sessions' : '加载更多会话');
      assert.equal(await more.evaluate(button => button.getBoundingClientRect().height), 36);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (evidence) await page.screenshot({ path: path.join(evidence, `history-${width}-${lang}-${theme}.png`) });
    }
  });
