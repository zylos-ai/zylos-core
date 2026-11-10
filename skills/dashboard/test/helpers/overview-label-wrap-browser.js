import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPage } from './workbench-browser.js';

// Short labels on the overview: each must stay on one line as a whole.
const LABELS = ['.wb-dist-total', '.wb-dist-item', '.wb-bh-state', '.wb-bh-now > span', '.wb-bh-right', '.wb-bh > .wb-tech-col',
  '#wb-range button', '.wb-inst-item > :not(.wb-meter):not(.wb-pips):not(.wb-spark):not(.wb-pool-note)', '.wb-inst-more', '.wb-legend-item', '.wb-row .wb-pill'];
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
  // The auto-name button and the pool's notes may wrap between words: no word of them may have parts on two lines.
  // A word ends at a space or after Chinese punctuation (，。；：、）) and starts before （: line breaks there are
  // between words, so 「内存只够系统助手，」 and 「同时运行上限按」 are two words.
  const autoName = document.querySelector('#wb-auto-name');
  const splitWords = [];
  const wrapsBetweenWords = [autoName, ...[...document.querySelectorAll('.wb-pool-note')].filter(note => note.getBoundingClientRect().width > 1)];
  for (const words of wrapsBetweenWords.map(el => document.createTreeWalker(el, NodeFilter.SHOW_TEXT)))
  for (let node = words.nextNode(); node; node = words.nextNode()) {
    for (const match of node.textContent.matchAll(/（?[^\s，。；：、（）]+[，。；：、）]?/g)) {
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
  const pool = strip.querySelector('.wb-pool');
  const shownText = el => Boolean(el) && el.getBoundingClientRect().width > 1;
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
    pool: pool && { amount: pool.querySelector('b')?.textContent, amountShown: shownText(pool.querySelector('b')), title: pool.title,
      inside: pool.getBoundingClientRect().right <= strip.getBoundingClientRect().right + 1,
      warnings: [...pool.querySelectorAll(':scope > .wb-txt-warn')].map(el => ({ text: el.textContent, shown: shownText(el) })),
      text: pool.textContent,
      notes: [...pool.querySelectorAll('.wb-pool-note')].map(note => ({ text: note.textContent, shown: shownText(note), read: read(note) })) },
  };
}

// A pool set by hand above the memory recommendation, with every capacity explanation and a queue.
const GiB = 1073741824;
const RICH_POOL = { used: 2, capacity: 4, waiting: 2, capacityRecord: { valid: true, fresh: true, source: 'fixed', kMemory: 3, reason: 'floor',
  memory: { source: 'host', limitBytes: 16 * GiB, usedBytes: 9.5 * GiB, reserveBytes: 2 * GiB },
  model: { state: 'fitted', slopeBytes: 1.2 * GiB, interceptBytes: 0.8 * GiB, windowDays: 7 } } };
const SOURCE = { zh: '手动设定 4（按内存建议 3）', en: 'Manually set to 4 (memory recommendation: 3)' };
const EXPLANATIONS = {
  zh: ['未设内存上限，按整机内存 · 内存上限 16 GiB · 已用 9.5 GiB · 保底 2 GiB', '每会话约 1.2 GiB · 固定开销约 0.8 GiB · 近 7 天',
    '内存只够系统助手，同时运行上限按 1 运行'],
  en: ['No memory limit set; using host memory · Memory limit 16 GiB · used 9.5 GiB · reserve 2 GiB',
    'about 1.2 GiB per session · fixed overhead about 0.8 GiB · over the last 7 days', 'Memory fits only the system assistant; running with a limit of 1'],
};
const HOST_POOL = { zh: { title: '会话池', slots: '名额', source: '来源' }, en: { title: 'Session pool', slots: 'Slots', source: 'Source' } };
const POOL_HINT = { zh: '系统助手常驻，不占这里的名额', en: 'The system assistant is resident and does not take a slot here' };
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

  async function open(width, language, level = 'plain', { listenErrors = false, pool = null, mode = null } = {}) {
    const phone = width < 761;
    const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 800 }, locale: language === 'zh' ? 'zh-CN' : 'en-US',
      timezoneId: 'UTC', ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', request => request.request().url().startsWith(base + '/') ? request.continue() : request.abort());
    await context.addInitScript(([locale, detail]) => {
      try { localStorage.setItem('zylos-dashboard-locale', locale); localStorage.setItem('zylos-dashboard-detail-level', detail); } catch {}
    }, [language, level]);
    // A pool answer (and run mode) of its own, from the first load on: the fixture's other answers stay as they are.
    if (pool || mode) await context.route(url => url.pathname === '/api/workbench/groups', async route => {
      const response = await route.fetch();
      const body = await response.json();
      if (pool) body.instance.pool = { ...body.instance.pool, ...pool };
      if (mode) body.mode = mode;
      await route.fulfill({ response, json: body });
    });
    // narrowTo(box, items): each item's min-content width (its widest piece that may not break) and max-content
    // width (its one-line width), as this browser lays them out, and a set() that narrows the box to half the widest
    // item but never below the widest min-content width plus the box's padding and border (edges).
    await context.addInitScript(() => {
      window.narrowTo = (box, items) => {
        const width = (el, value) => { const old = el.style.width; el.style.width = value; const result = el.getBoundingClientRect().width; el.style.width = old; return result; };
        const content = items.map(el => ({ el, min: width(el, 'min-content'), max: width(el, 'max-content') }));
        const style = getComputedStyle(box);
        content.edges = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, key) => sum + parseFloat(style[key]), 0);
        const target = Math.max(Math.max(...content.map(item => item.max)) / 2, Math.max(...content.map(item => item.min)) + content.edges);
        return { content, set: () => { box.style.width = `${target}px`; } };
      };
    });
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
    // The pool keeps its capacity, its warnings and its one source note on screen; the capacity explanations are not
    // in the strip at all (the host panel shows them). The note stays read out and is in the item's title.
    const pool = result.pool;
    assert.ok(pool, 'the strip has a pool item');
    assert.equal(pool.amountShown, true, `the pool capacity is shown: ${pool.amount}`);
    assert.equal(pool.inside, true, 'the pool item stays inside the strip');
    assert.equal(pool.warnings.every(warning => warning.shown), true, 'pool warnings stay on screen');
    assert.ok(pool.title.startsWith(POOL_HINT[language]), `the pool title keeps its hint: ${pool.title}`);
    assert.ok(pool.notes.length <= 1, 'the strip has at most the source note');
    for (const text of Object.values(EXPLANATIONS).flat()) assert.equal(pool.text.includes(text), false, `the strip leaves out: ${text}`);
    for (const note of pool.notes) {
      assert.equal(note.read, true, `a pool note stays in the accessibility tree: ${note.text}`);
      assert.equal(note.shown, true, `the pool's source note is shown: ${note.text}`);
      assert.ok(pool.title.includes(note.text.replace(/^ · /, '')), `the pool title carries the note: ${note.text}`);
    }
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
            for (const match of node.textContent.matchAll(/（?[^\s，。；：、（）]+[，。；：、）]?/g)) {
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

  // A pool set by hand above the memory recommendation, with every capacity explanation and a queue: the longest pool
  // item there is. The strip shows the source note in both views; the explanations are in the host panel only.
  for (const language of ['zh', 'en']) for (const level of ['plain', 'technical']) {
    await t.test(`the pool item keeps its capacity and source note whole: ${language}, ${level}`, async () => {
      const forms = new Set();
      for (const [width, detail] of [[3840, false], [1280, false], [1280, true], [390, true]]) {
        const { page, context } = await open(width, language, level, { pool: RICH_POOL });
        try {
          if (detail) await openDetail(page);
          await page.locator('#wb-instance .wb-pool .wb-pool-note').first().waitFor({ state: 'attached' });
          const result = await measureOn(page);
          checkLabels(result, language, { technical: level === 'technical' });
          assert.equal(result.pool.amount, '2 / 4');
          assert.equal(result.pool.warnings.length, 1, 'the queue is shown');
          assert.deepEqual(result.pool.notes.map(note => note.text), [' · ' + SOURCE[language]]);
          if (level === 'technical') for (const text of EXPLANATIONS[language]) assert.ok(result.pool.title.includes(text), `the pool title keeps: ${text}`);
          forms.add(result.stripCompact ? 'compact' : 'full');
        } finally { await context.close(); }
      }
      assert.deepEqual([...forms].sort(), ['compact', 'full'], 'the pool item is seen in the full and the compact strip');
    });
  }

  // No test width makes the note wider than its box, so the page narrows the pool item: to half the note's width,
  // but never below the note's min-content width (its widest piece that may not break, as the browser lays it out)
  // plus the item's own padding and border, so every piece fits and the check does not depend on glyph widths. The
  // note must still be wider than that box, so it has to wrap.
  for (const language of ['zh', 'en']) {
    await t.test(`the pool source note wraps between words inside a box narrower than it is (${language})`, async () => {
      const { page, context } = await open(3840, language, 'technical', { pool: RICH_POOL });
      try {
        await page.locator('#wb-instance .wb-pool .wb-pool-note').first().waitFor({ state: 'attached' });
        const result = await page.evaluate(() => {
          const pool = document.querySelector('#wb-instance .wb-pool');
          const notes = [...pool.querySelectorAll('.wb-pool-note')];
          const { content, set } = narrowTo(pool, notes);
          set();
          const box = pool.getBoundingClientRect();
          const measured = notes.map(note => {
            const all = document.createRange(); all.selectNodeContents(note);
            const rects = [...all.getClientRects()].filter(rect => rect.width > 0);
            const split = [];
            const walker = document.createTreeWalker(note, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              for (const match of node.textContent.matchAll(/（?[^\s，。；：、（）]+[，。；：、）]?/g)) {
                const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
                if (new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size > 1) split.push(match[0]);
              }
            }
            return { text: note.textContent, lines: new Set(rects.map(rect => Math.round(rect.top))).size,
              overflow: Math.max(...rects.map(rect => rect.right)) - box.right, split, oneLine: content.find(item => item.el === note).max };
          });
          const room = box.width - content.edges;
          pool.style.width = '';
          return { room, notes: measured };
        });
        assert.equal(result.notes.length, 1, 'the source note only');
        for (const note of result.notes) {
          assert.ok(note.oneLine > result.room + 1, `the box is narrower than the note: ${note.oneLine} > ${result.room}`);
          assert.ok(note.overflow <= 1, `the note stays inside the pool item: ${note.text} (${note.overflow}px out)`);
          assert.deepEqual(note.split, [], `no word of the note has parts on two lines: ${note.text}`);
          assert.ok(note.lines > 1, `the note wraps in the narrow box: ${note.text}`);
        }
      } finally { await context.close(); }
    });
  }

  // The host panel's pool section: slots, source and the three explanations, each whole on screen, wrapping only
  // between words, with nothing sticking out sideways. Both views show it.
  const openHost = async page => {
    await page.locator('#wb-host-open').click();
    await page.locator('#wb-side .wb-host-body').waitFor();
  };
  const measureHostPool = page => page.evaluate(() => {
    const section = document.querySelector('#wb-side .wb-host-pool');
    if (!section || !section.getClientRects().length) return { shown: false, present: Boolean(section) };
    const side = document.querySelector('#wb-side'), root = document.documentElement;
    const lines = [...section.querySelectorAll('.wb-host-pool-notes li')];
    const items = lines.map(line => {
      line.scrollIntoView({ block: 'nearest' });
      const box = line.getBoundingClientRect(), card = section.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(line);
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
      const split = [];
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const match of node.textContent.matchAll(/（?[^\s，。；：、（）]+[，。；：、）]?/g)) {
          const word = document.createRange(); word.setStart(node, match.index); word.setEnd(node, match.index + match[0].length);
          if (new Set([...word.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size > 1) split.push(match[0]);
          if (split.length >= 5) break;
        }
      }
      return { text: line.textContent, lines: new Set(rects.map(rect => Math.round(rect.top))).size, split,
        onScreen: box.width > 1 && box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1,
        inCard: Math.max(...rects.map(rect => rect.right)) <= card.right + 1 && Math.min(...rects.map(rect => rect.left)) >= card.left - 1,
        visible: getComputedStyle(line).visibility !== 'hidden' };
    });
    return { shown: true, present: true, text: section.textContent, items,
      overflow: { section: section.scrollWidth - section.clientWidth, side: side.scrollWidth - side.clientWidth, page: root.scrollWidth - innerWidth } };
  });
  for (const language of ['zh', 'en']) for (const width of [1280, 390]) {
    await t.test(`the host panel shows the pool explanations whole: ${width}px ${language}`, async () => {
      for (const level of ['plain', 'technical']) {
        const { page, context } = await open(width, language, level, { pool: RICH_POOL });
        try {
          await openHost(page);
          await page.locator('#wb-side .wb-host-pool-notes li').first().waitFor();
          const result = await measureHostPool(page);
          assert.equal(result.shown, true, `${level}: the pool section is shown`);
          assert.ok(result.text.includes(HOST_POOL[language].title), `${level}: the section has its title`);
          assert.ok(result.text.includes(HOST_POOL[language].slots + '2 / 4'), `${level}: the slots are shown`);
          assert.ok(result.text.includes(HOST_POOL[language].source + SOURCE[language]), `${level}: the source is shown`);
          assert.deepEqual(result.items.map(item => item.text), EXPLANATIONS[language], `${level}: the three explanations, word for word`);
          for (const item of result.items) {
            assert.equal(item.onScreen && item.visible, true, `${level}: on screen: ${item.text}`);
            assert.equal(item.inCard, true, `${level}: inside the section: ${item.text}`);
            assert.deepEqual(item.split, [], `${level}: no word has parts on two lines: ${item.text}`);
          }
          assert.ok(result.overflow.section <= 1 && result.overflow.side <= 1 && result.overflow.page <= 1,
            `${level}: nothing sticks out sideways: ${JSON.stringify(result.overflow)}`);
          if (evidence) await page.screenshot({ path: path.join(evidence, `host-pool-${width}-${language}-${level}.png`) });
        } finally { await context.close(); }
      }
    });
  }

  // The section reads the board's own snapshot: the shell redraws the open panel on every poll, so a poll that
  // changes the pool changes the open section.
  await t.test('the host panel pool section follows the board polls', async () => {
    const { page, context } = await open(1280, 'zh', 'plain', { pool: RICH_POOL });
    let next = null;
    await context.route(url => url.pathname === '/api/workbench/groups', async route => {
      const response = await route.fetch();
      const body = await response.json();
      const { mode, ...pool } = next ?? {};
      body.instance.pool = { ...body.instance.pool, ...RICH_POOL, ...pool };
      if (mode) body.mode = mode;
      await route.fulfill({ response, json: body });
    });
    try {
      await openHost(page);
      await page.locator('#wb-side .wb-host-pool-notes li').first().waitFor();
      next = { used: 3 };
      // The board polls every 5s.
      await page.locator('#wb-side .wb-host-pool', { hasText: '名额3 / 4' }).waitFor({ timeout: 8000 });
      next = { mode: 'single' };
      await page.locator('#wb-side .wb-host-pool').waitFor({ state: 'hidden', timeout: 8000 });
      assert.equal((await measureHostPool(page)).shown, false, 'single mode, no section');
      assert.equal(await page.locator('#wb-side .wb-host-svc, #wb-side .wb-kvs').first().isVisible(), true, 'the host panel stays open');
    } finally { await context.close(); }
  });

  // No test width makes an explanation wider than the list at a line break inside a word, so the page narrows the
  // list: to half its widest explanation, but never below the widest min-content width (the widest piece that may
  // not break, as the browser lays it out) plus the list's padding and border. An explanation wraps exactly when
  // it is wider than the room left, and at least one is.
  for (const language of ['zh', 'en']) {
    await t.test(`the host panel pool explanations wrap between words inside a box narrower than they are (${language})`, async () => {
      const { page, context } = await open(1280, language, 'plain', { pool: RICH_POOL });
      try {
        await openHost(page);
        await page.locator('#wb-side .wb-host-pool-notes li').first().waitFor();
        const sizes = await page.evaluate(() => {
          const list = document.querySelector('#wb-side .wb-host-pool-notes');
          const { content, set } = narrowTo(list, [...list.children]);
          set();
          const room = list.getBoundingClientRect().width - content.edges;
          return { room, oneLine: content.map(item => item.max) };
        });
        const result = await measureHostPool(page);
        assert.equal(result.items.length, 3);
        for (const [index, item] of result.items.entries()) {
          assert.deepEqual(item.split, [], `no word has parts on two lines: ${item.text}`);
          assert.equal(item.inCard, true, `inside the section: ${item.text}`);
          assert.equal(item.lines > 1, sizes.oneLine[index] > sizes.room + 1,
            `wraps exactly when wider than the room left (${sizes.oneLine[index]} vs ${sizes.room}): ${item.text}`);
        }
        assert.ok(result.items.some(item => item.lines > 1), 'an explanation wraps in the narrow box');
      } finally { await context.close(); }
    });
  }

  // Single and unreadable modes have no pool section. In multi mode the server always sends a record, at least
  // { valid: false, fresh: false } when the record file is missing: then the section has the slots and the source only.
  await t.test('the host panel has a pool section in multi mode only', async () => {
    for (const mode of ['single', 'unreadable']) {
      const { page, context } = await open(1280, 'zh', 'technical', { pool: RICH_POOL, mode });
      try {
        await openHost(page);
        await page.locator('#wb-side .wb-host-svc').waitFor();
        const result = await measureHostPool(page);
        assert.equal(result.shown, false, `no pool section in ${mode} mode`);
      } finally { await context.close(); }
    }
    const { page, context } = await open(1280, 'zh', 'technical', { pool: { used: 1, capacity: 3, capacityRecord: { valid: false, fresh: false } } });
    try {
      await openHost(page);
      await page.locator('#wb-side .wb-host-pool').waitFor();
      const result = await measureHostPool(page);
      assert.equal(result.shown, true, 'a missing record file still shows the section');
      assert.ok(result.text.includes('名额1 / 3') && result.text.includes('来源上限数据不可用，按 3 运行'), result.text);
      assert.equal(result.items.length, 0, 'no explanations');
    } finally { await context.close(); }
  });

  await t.test('rows refit when the window width changes without a redraw', async () => {
    const { page, context } = await open(1280, 'zh');
    try {
      await openDetail(page);
      checkLabels(await measureOn(page), 'zh');
      // The widths are chosen so that only a refit gives each row the expected form; a poll (every 5s, which also
      // refits) could land in the same 2s, so the resize path itself is pinned down by wb-label-fit's unit tests.
      // With the 480px drawer open, 1700px leaves the list 1220px, room for the full form in any font, and 800px
      // leaves 320px, room for it in none.
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
