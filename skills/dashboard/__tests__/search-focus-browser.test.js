import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { startPage } from './helpers/workbench-browser.js';

// Boundary: shipped pages, CSS and the real search boxes over private loopback APIs; the memory backlog read is
// answered with enough groups for the group filter to show, and the overview's charts get the preinstalled Chart.js. Run for changes to the search box (.wb-search) or
// input styles, or to the search boxes of the schedule, memory and overview pages; skip unrelated backend work.
// The official runner and sandbox prove private HOME/ZYLOS_DIR, PM2_HOME, short TMPDIR, socket and test DB paths
// before starting resources. No DB, runtime or tmux starts; contexts, browser and server close on failure.
const BOXES = [
  ['schedule', '/schedule', '.wb-sched-filters .wb-search'],
  ['memory', '/memory', '.wb-memory-search'],
  ['memory-groups', '/memory', '.wb-memory-gfilter'],
  // The group list's search box never carried the input class: the reference the others must match.
  ['overview', '/', '.wb-bh-now .wb-search'],
];

// Enough groups for the memory page to offer its group filter.
function backlog() {
  const groups = Array.from({ length: 14 }, (_, index) => ({ sessionGroup: `telegram:${9000 + index}`,
    displayName: `Group ${index + 1}`, c4: { componentName: 'telegram' }, count: 20 - index, firstAt: null,
    aged: false, syncing: false, threshold: 15 }));
  return { groups, hasOlder: false, budgets: { limits: {}, warnings: {} } };
}

test('a search box shows one focus ring, drawn by the box, while typing',
  { skip: !chatEnabled(), timeout: 180_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      console.log('Search focus browser isolation:', JSON.stringify(sandbox.assertIsolation()));
      const chartAsset = process.env.ZYLOS_CHAT_CHART_ASSET;
      assert.ok(chartAsset && fs.existsSync(chartAsset), 'explicit preinstalled Chart.js required');
      const { base } = await startPage(sandbox);
      const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
      const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN,
        headless: true, env: sandbox.env, args: ['--no-sandbox', '--disable-background-networking'] });
      sandbox.addCleanup(() => browser.close());
      const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
      if (evidence) fs.mkdirSync(evidence, { recursive: true });
      for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
        for (const [name, route, selector] of BOXES) await t.test(`${name} ${width}px ${theme}`, async () => {
          const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'zh-CN', colorScheme: theme,
            ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
          sandbox.addCleanup(() => context.close());
          try {
            await context.route('**/*', request => request.request().url().startsWith(base + '/') ? request.continue() : request.abort());
            await context.route(base + '/api/workbench/memory/backlog*', request => request.fulfill({ json: backlog() }));
            await context.route(base + '/_assets/vendor/chart.umd.js', request => request.fulfill({ path: chartAsset, contentType: 'text/javascript' }));
            await context.addInitScript(value => {
              if (window.top !== window) return; // The overview's sandboxed preview frame has no storage.
              localStorage.setItem('zylos-dashboard-locale', 'zh');
              localStorage.setItem('zylos-dashboard-theme', value);
              localStorage.setItem('zylos-dashboard-detail-level', 'technical');
            }, theme);
            const page = await context.newPage(); page.setDefaultTimeout(7000);
            const errors = [];
            page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
            await page.goto(base + route);
            const box = page.locator(selector).filter({ visible: true }).first();
            await box.waitFor();
            const input = box.locator('input');
            await box.scrollIntoViewIfNeeded();
            await input.focus();
            await page.keyboard.type('a');
            assert.equal(await input.inputValue(), 'a', `${name}: typing goes into the box`);
            const read = await box.evaluate(node => {
              const field = node.querySelector('input'), outer = getComputedStyle(node), inner = getComputedStyle(field);
              const frame = node.getBoundingClientRect(), text = field.getBoundingClientRect();
              const border = { top: parseFloat(outer.borderTopWidth), bottom: parseFloat(outer.borderBottomWidth) };
              return { focused: document.activeElement === field, font: inner.fontSize, cancel: getComputedStyle(field, '::-webkit-search-cancel-button').display, inner: { style: inner.outlineStyle, width: inner.outlineWidth },
                outer: { style: outer.outlineStyle, width: outer.outlineWidth },
                frame: { left: frame.left, top: frame.top, width: frame.width, height: frame.height, innerTop: frame.top + border.top, innerBottom: frame.bottom - border.bottom },
                text: { top: text.top, bottom: text.bottom, left: text.left, right: text.right } };
            });
            if (evidence) {
              const pad = 10, clip = { x: Math.max(0, read.frame.left - pad), y: Math.max(0, read.frame.top - pad),
                width: Math.min(width - Math.max(0, read.frame.left - pad), read.frame.width + 2 * pad), height: read.frame.height + 2 * pad };
              await page.screenshot({ path: path.join(evidence, `search-focus-${name}-${width}-${theme}.png`), clip });
              fs.writeFileSync(path.join(evidence, `search-focus-${name}-${width}-${theme}.json`), JSON.stringify(read));
            }
            assert.equal(read.focused, true, `${name}: the input has focus`);
            assert.equal(read.inner.style, 'none', `${name}: the input draws no ring of its own (${read.inner.style} ${read.inner.width})`);
            assert.notEqual(read.outer.style, 'none', `${name}: the box draws the focus ring`);
            assert.ok(parseFloat(read.outer.width) > 0, `${name}: the box ring has a width (${read.outer.width})`);
            assert.ok(read.text.top >= read.frame.innerTop - 0.5 && read.text.bottom <= read.frame.innerBottom + 0.5,
              `${name}: the input sits inside the box (${read.text.top}-${read.text.bottom} in ${read.frame.innerTop}-${read.frame.innerBottom})`);
            assert.deepEqual(errors, [], `${name}: no page errors`);
          } finally { await context.close(); }
        });
      }
    }, { timeoutMs: 170_000 });
  });
