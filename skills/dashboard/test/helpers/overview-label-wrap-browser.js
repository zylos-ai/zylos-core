import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPage } from './workbench-browser.js';

// Short labels on the overview: each must stay on one line as a whole.
const LABELS = ['.wb-dist-total', '.wb-dist-item', '.wb-bh-state', '.wb-bh-now > span', '.wb-bh-right', '.wb-bh > .wb-tech-col',
  '#wb-range button', '.wb-inst-item > :not(.wb-meter):not(.wb-pips):not(.wb-spark)', '.wb-inst-more', '.wb-legend-item', '.wb-row .wb-pill'];
const NOWRAP = ['.wb-dist-total', '.wb-dist-item', '.wb-bh-right', '.wb-bh > .wb-tech-col', '.wb-legend-item', '.wb-account > *',
  '.wb-inst-item:not(.wb-account)', '.wb-inst-more'];

// Read in the page: labels whose visible text spans more than one line, words of the auto-name button split across
// lines, each row's form and whether its full form fits on one line, and what each count and the cost item read as
// and show. Nothing here depends on a font's widths: each result is checked against what the same page measures.
function measureLabels({ labels, nowrap }) {
  const lineCount = el => {
    const middles = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // Text clipped to a 1px box is for screen readers only; it is not on any visible line.
      if (!node.textContent.trim() || node.parentElement.getBoundingClientRect().width <= 1) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) middles.push(rect.top + rect.height / 2);
    }
    middles.sort((a, b) => a - b);
    return middles.filter((value, index) => index === 0 || value - middles[index - 1] > 4).length;
  };
  const broken = [];
  for (const selector of labels) for (const el of document.querySelectorAll(selector)) {
    if (!el.getClientRects().length) continue;
    const lines = lineCount(el);
    if (lines > 1) { broken.push(`${selector} "${el.textContent.trim().slice(0, 30)}" ${lines} lines`); if (broken.length >= 5) break; }
  }
  const wrapping = [];
  for (const selector of nowrap) for (const el of document.querySelectorAll(selector)) {
    if (el.getClientRects().length && getComputedStyle(el).whiteSpace !== 'nowrap') wrapping.push(`${selector} ${getComputedStyle(el).whiteSpace}`);
  }
  // The auto-name button may wrap between words: no word of it may have parts on two lines.
  const autoName = document.querySelector('#wb-auto-name');
  const splitWords = [];
  const words = document.createTreeWalker(autoName, NodeFilter.SHOW_TEXT);
  for (let node = words.nextNode(); node; node = words.nextNode()) {
    for (const match of node.textContent.matchAll(/\S+/g)) {
      const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
      const tops = new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top)));
      if (tops.size > 1) splitWords.push(match[0]);
    }
  }
  // A row is on one line when every shown child starts before the first line ends. The full form is measured by
  // taking the compact class off and putting it back in the same task, so nothing is painted or observed in between.
  const oneLine = row => {
    const boxes = [...row.children].filter(child => child.getClientRects().length).map(child => child.getBoundingClientRect());
    const firstBottom = Math.min(...boxes.map(box => box.bottom));
    return boxes.every(box => box.top < firstBottom);
  };
  const form = row => {
    const compact = row.classList.contains('wb-compact'), fits = oneLine(row);
    row.classList.remove('wb-compact');
    const fullFits = oneLine(row);
    row.classList.toggle('wb-compact', compact);
    return { compact, fits, fullFits };
  };
  // Hidden from sight but still read out: display:none or visibility:hidden would take the text from screen readers too.
  const read = el => Boolean(el) && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  const dist = document.querySelector('#wb-dist'), strip = document.querySelector('#wb-instance');
  const name = document.querySelector('.wb-bh-name');
  const cost = strip.querySelector('.wb-scope')?.closest('.wb-inst-item');
  return {
    broken, wrapping, splitWords, distForm: form(dist), stripForm: form(strip),
    // A label that may not wrap must not stick out of its board head cell either, nor may the auto-name button.
    nameOverflow: name.scrollWidth > name.clientWidth + 1,
    autoNameInside: autoName.getBoundingClientRect().right <= name.getBoundingClientRect().right + 1,
    distCompact: dist.classList.contains('wb-compact'), stripCompact: strip.classList.contains('wb-compact'),
    counts: [...dist.querySelectorAll('.wb-dist-item')].map(item => ({ text: item.textContent, title: item.title,
      wordShown: item.querySelector('.wb-dist-word').getBoundingClientRect().width > 1, wordRead: read(item.querySelector('.wb-dist-word')) })),
    costTitle: cost?.title ?? null,
    scopeShown: (scope => Boolean(scope) && scope.getBoundingClientRect().width > 1)(strip.querySelector('.wb-scope')),
    scopeText: strip.querySelector('.wb-scope')?.textContent ?? null, scopeRead: read(strip.querySelector('.wb-scope')),
  };
}

const WORDS = { zh: ['1 忙碌', '1 空闲', '1 未运行'], en: ['1 Busy', '1 Idle', '1 Not running'] };

export async function runOverviewLabelWrapBrowser(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE, executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath), 'ZYLOS_CHAT_BROWSER_MODULE names the Playwright module');
  assert.ok(executablePath && fs.existsSync(executablePath), 'ZYLOS_CHAT_BROWSER_BIN names the browser');
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  console.log('Overview label browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const { base } = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());

  async function open(width, language, level = 'plain', { listenErrors = false } = {}) {
    const phone = width < 761;
    const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 800 }, locale: language === 'zh' ? 'zh-CN' : 'en-US',
      timezoneId: 'UTC', ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', request => request.request().url().startsWith(base + '/') ? request.continue() : request.abort());
    await context.addInitScript(([locale, detail]) => {
      try { localStorage.setItem('zylos-dashboard-locale', locale); localStorage.setItem('zylos-dashboard-detail-level', detail); } catch {}
    }, [language, level]);
    if (listenErrors) await context.addInitScript(() => {
      window.__overviewErrors = [];
      window.addEventListener('error', event => { if (window.__overviewErrors.length < 5) window.__overviewErrors.push(String(event.message)); });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(base + '/');
    await page.locator('#wb-board .wb-row').first().waitFor();
    await page.locator('#wb-dist .wb-dist-item').first().waitFor();
    return { page, context };
  }
  const openDetail = async page => {
    await page.locator('#wb-board .wb-row', { hasText: 'Product weekly' }).click();
    await page.locator('#wb-side .wb-d-top').waitFor();
  };
  const measureOn = page => page.evaluate(measureLabels, { labels: LABELS, nowrap: NOWRAP });

  const nextFrames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // What holds in any font: no label breaks inside, the auto-name button wraps only between words and stays in its
  // cell, a row is compact exactly when its full form does not fit on one line (so a row that wraps went compact
  // first, and a row whose full form fits is never compact), and a compact row's words stay read out and in titles.
  function checkLabels(result, language, { technical = false } = {}) {
    assert.deepEqual(result.broken, []);
    assert.deepEqual(result.wrapping, []);
    assert.deepEqual(result.splitWords, [], 'the auto-name button wraps only between words');
    assert.equal(result.nameOverflow, false);
    assert.equal(result.autoNameInside, true, 'the auto-name button stays inside its cell');
    for (const [row, form] of [['counts', result.distForm], ['instance strip', result.stripForm]]) {
      assert.equal(form.compact, !form.fullFits, `${row}: compact exactly when the full form does not fit on one line`);
      if (!form.fits) assert.equal(form.compact, true, `${row}: wraps only after going compact`);
    }
    // Each count always reads as number and state word, also when the word is not shown.
    assert.deepEqual(result.counts.map(count => count.text), WORDS[language]);
    assert.equal(result.counts.every(count => count.wordRead), true, 'the state word stays in the accessibility tree');
    assert.deepEqual(result.counts.map(count => count.title), WORDS[language].map(text => `${text.slice(text.indexOf(' ') + 1)} 1`));
    // The technical view shows numbers only; the plain view shows the words unless the counts are compact.
    assert.equal(result.counts.every(count => count.wordShown), !technical && !result.distCompact);
    assert.equal(result.counts.some(count => count.wordShown), !technical && !result.distCompact);
    const scope = language === 'zh' ? '全部组合计' : 'All groups combined';
    assert.equal(result.scopeText, scope);
    assert.equal(result.scopeRead, true, 'the scope stays in the accessibility tree');
    assert.equal(result.scopeShown, !result.stripCompact);
    // The cost item's title names the scope, which the compact strip takes off the screen.
    assert.ok(result.costTitle?.endsWith(` · ${scope}`), `the cost item's title names the scope: ${result.costTitle}`);
  }

  const seen = { counts: new Set(), strip: new Set() };
  for (const language of ['zh', 'en']) for (const width of [1280, 390]) for (const detail of [false, true]) {
    await t.test(`${width}px ${language}, detail ${detail ? 'open' : 'closed'}: no label breaks inside`, async () => {
      const { page, context } = await open(width, language);
      try {
        if (detail) await openDetail(page);
        const result = await measureOn(page);
        checkLabels(result, language);
        seen.counts.add(result.distCompact); seen.strip.add(result.stripCompact);
        if (evidence) await page.screenshot({ path: path.join(evidence, `overview-labels-${width}-${language}-${detail ? 'open' : 'closed'}.png`) });
      } finally { await context.close(); }
    });
  }
  // The checks above hold either way; these widths have to reach both forms of each row for them to mean something.
  assert.deepEqual([...seen.counts].sort(), [false, true], 'the counts were seen in their full and their compact form');
  assert.deepEqual([...seen.strip].sort(), [false, true], 'the instance strip was seen in its full and its compact form');

  // No test width makes the cell narrower than the Chinese label, but a larger font can. The button is given half
  // its own width, whatever the font: English then has to wrap, and "自动起名" is wider than the box.
  for (const language of ['zh', 'en']) {
    await t.test(`the auto-name button splits no word when its box is narrower than its label (${language})`, async () => {
      const { page, context } = await open(1280, language);
      try {
        const result = await page.evaluate(() => {
          const button = document.querySelector('#wb-auto-name');
          button.style.width = `${button.getBoundingClientRect().width / 2}px`;
          const box = button.getBoundingClientRect();
          const words = [];
          const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            for (const match of node.textContent.matchAll(/\S+/g)) {
              const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
              const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
              words.push({ word: match[0], lines: new Set(rects.map(rect => Math.round(rect.top))).size,
                widerThanBox: Math.max(...rects.map(rect => rect.width)) > box.width });
            }
          }
          const all = document.createRange(); all.selectNodeContents(button);
          const lines = new Set([...all.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size;
          button.style.width = '';
          return { words, lines };
        });
        assert.deepEqual(result.words.filter(word => word.lines > 1).map(word => word.word), [], 'no word has parts on two lines');
        if (language === 'zh') assert.equal(result.words.some(word => word.widerThanBox), true, 'the Chinese label is wider than the box');
        else assert.ok(result.lines > 1, 'the English label wraps between words');
      } finally { await context.close(); }
    });
  }

  await t.test('rows refit when the window width changes without a redraw', async () => {
    const { page, context } = await open(1280, 'zh');
    try {
      await openDetail(page);
      checkLabels(await measureOn(page), 'zh');
      // The widths are chosen so that only a refit gives each row the expected form; a poll (every 5s, which also
      // refits) could land in the same 2s, so the resize path itself is pinned down by wb-label-fit's unit tests.
      // With the 480px drawer open, 1700px leaves the
      // list 1220px, room for the full form in any font, and 800px leaves 320px, room for it in none.
      await page.setViewportSize({ width: 1700, height: 800 });
      await page.waitForFunction(() => !document.querySelector('#wb-dist').classList.contains('wb-compact')
        && !document.querySelector('#wb-instance').classList.contains('wb-compact'), null, { timeout: 2000 });
      checkLabels(await measureOn(page), 'zh');
      await page.setViewportSize({ width: 800, height: 800 });
      await page.waitForFunction(() => document.querySelector('#wb-dist').classList.contains('wb-compact')
        && document.querySelector('#wb-instance').classList.contains('wb-compact'), null, { timeout: 2000 });
      checkLabels(await measureOn(page), 'zh');
    } finally { await context.close(); }
  });

  // The strip's own content grows while nothing changes width: the next poll answers with a queue and services
  // down, and only the strip is redrawn. The width is found in the page, not fixed: the narrowest at which the
  // strip still has its full form, so the grown strip no longer fits in any font and only the refit after the
  // strip redraw can give it its compact form.
  await t.test('a strip that grows on a poll refits without a width change', async () => {
    const { page, context } = await open(1700, 'zh');
    let longer = false;
    await context.route(url => url.pathname === '/api/workbench/groups', async route => {
      const response = await route.fetch();
      const body = await response.json();
      if (longer) Object.assign(body.instance, { pool: { ...body.instance.pool, waiting: 12 }, services: { online: 3, total: 6 } });
      await route.fulfill({ response, json: body });
    });
    try {
      await openDetail(page);
      const compact = () => page.evaluate(() => document.querySelector('#wb-instance').classList.contains('wb-compact'));
      let width = 1700;
      assert.equal(await compact(), false, 'the full strip fits beside the drawer at 1700px');
      while (width > 900) {
        await page.setViewportSize({ width: width - 10, height: 800 });
        await nextFrames(page);
        if (await compact()) break;
        width -= 10;
      }
      await page.setViewportSize({ width, height: 800 });
      await nextFrames(page);
      const before = await measureOn(page);
      assert.equal(before.stripCompact, false);
      checkLabels(before, 'zh');
      longer = true;
      // The board polls every 5s.
      await page.waitForFunction(() => document.querySelector('#wb-instance .wb-txt-warn'), null, { timeout: 8000 });
      const after = await measureOn(page);
      assert.equal(after.stripCompact, true, `the grown strip went compact at ${width}px`);
      checkLabels(after, 'zh');
      assert.equal(after.distCompact, before.distCompact, 'the board head did not change, so nothing else refitted');
    } finally { await context.close(); }
  });

  // Coming back from another page: while the overview is hidden its rows measure nothing and refit to the full
  // form, and showing it again refits a compact row to compact. That refit must not change an observed row inside
  // the ResizeObserver callback, which the browser reports as a window error event (not a page error, so it is
  // listened for in the page). The drawer sits beside the list from 901px; starting at 1280px, the width narrows
  // until a row is compact, which it is by 901px in any font.
  const anyCompact = () => ['#wb-dist', '#wb-instance'].some(selector => document.querySelector(selector).classList.contains('wb-compact'));
  for (const language of ['zh', 'en']) {
    await t.test(`returning to the overview from another page refits without a window error (${language})`, async () => {
      const { page, context } = await open(1280, language, 'plain', { listenErrors: true });
      try {
        await openDetail(page);
        let width = 1280;
        await nextFrames(page);
        while (!await page.evaluate(anyCompact) && width > 901) {
          width = Math.max(901, width - 40);
          await page.setViewportSize({ width, height: 800 });
          await nextFrames(page);
        }
        assert.equal(await page.evaluate(anyCompact), true, `a row is compact at ${width}px`);
        await page.locator('.tab-bar .tab[data-tab="chat"]').click();
        await page.locator('#tab-overview').waitFor({ state: 'hidden' });
        await page.waitForFunction(() => !document.querySelector('#wb-dist').classList.contains('wb-compact')
          && !document.querySelector('#wb-instance').classList.contains('wb-compact'), null, { timeout: 2000 });
        await page.locator('.tab-bar .tab[data-tab="overview"]').click();
        await page.locator('#tab-overview').waitFor({ state: 'visible' });
        await page.waitForFunction(anyCompact, null, { timeout: 2000 });
        await nextFrames(page); await nextFrames(page);
        assert.deepEqual(await page.evaluate(() => window.__overviewErrors), []);
        checkLabels(await measureOn(page), language);
      } finally { await context.close(); }
    });
  }

  for (const language of ['zh', 'en']) for (const detail of [false, true]) {
    await t.test(`technical view ${language}, detail ${detail ? 'open' : 'closed'}: numbers shown, state words still read out`, async () => {
      const { page, context } = await open(1280, language, 'technical');
      try {
        if (detail) await openDetail(page);
        checkLabels(await measureOn(page), language, { technical: true });
      } finally { await context.close(); }
    });
  }
}
