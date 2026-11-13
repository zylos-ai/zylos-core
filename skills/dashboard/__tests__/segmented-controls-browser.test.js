import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { startPage } from './helpers/workbench-browser.js';
import { startPage as startConversationPage } from './helpers/mobile-conversation-browser.js';

// Boundary: shipped page, CSS and actual controls over private loopback APIs.
// Run for segmented-control palette, focus or geometry changes; skip unrelated
// backend work. The official runner and sandbox prove private HOME/ZYLOS_DIR,
// PM2_HOME, short TMPDIR, socket and test DB paths before starting resources.
// No DB, runtime or tmux starts; contexts, browser and servers close on failure.
test('segmented controls share raised selection in both themes and screen sizes',
  { skip: !chatEnabled(), timeout: 180_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      console.log('Segment browser isolation:', JSON.stringify(sandbox.assertIsolation()));
      const workbench = await startPage(sandbox), conversation = await startConversationPage(sandbox);
      const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
      const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN,
        headless: true, env: sandbox.env, args: ['--no-sandbox', '--disable-background-networking'] });
      sandbox.addCleanup(() => browser.close());
      const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
      if (evidence) fs.mkdirSync(evidence, { recursive: true });
      const cases = [
        ['conversation', conversation.base, '/chat', '.conversation-tabs'],
        ['schedule', workbench.base, '/schedule', '.wb-sched-filters .wb-seg'],
        ['usage', workbench.base, '/usage', '#wb-usage-range'],
        ['memory', workbench.base, '/memory', '.memory-toggle.wb-seg'],
        ['settings', workbench.base, '/settings', '.wb-seg2'],
        ['small', workbench.base, '/', '#wb-range'],
      ];
      for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
        for (const [name, base, route, selector] of cases) await t.test(`${name} ${width}px ${theme}`, async () => {
          const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'zh-CN' });
          sandbox.addCleanup(() => context.close());
          try {
            await context.route('**/*', request => request.request().url().startsWith(base + '/') ? request.continue() : request.abort());
            await context.addInitScript(value => {
              localStorage.setItem('zylos-dashboard-locale', 'zh');
              localStorage.setItem('zylos-dashboard-theme', value);
            }, theme);
            const page = await context.newPage(); page.setDefaultTimeout(7000);
            await page.goto(base + route);
            if (name === 'memory') await page.locator('#memory-tree .memory-file[data-path="state.md"]').click();
            await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
            const control = page.locator(selector).filter({ visible: true }).first();
            await control.waitFor();
            const chosen = control.locator('button:is([aria-selected="true"], [aria-pressed="true"], .active, .wb-on)').first();
            const other = control.locator('button:not([aria-selected="true"], [aria-pressed="true"], .active, .wb-on):not(:disabled)').first();
            await chosen.waitFor(); await other.waitFor();
            await page.waitForTimeout(180); // Finish the existing button background transition before sampling.
            const measure = node => {
              const style = getComputedStyle(node), box = node.getBoundingClientRect();
              const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
              const ctx = canvas.getContext('2d'); ctx.fillStyle = style.backgroundColor; ctx.fillRect(0, 0, 1, 1);
              const bg = [...ctx.getImageData(0, 0, 1, 1).data].join(',');
              return { bg, color: style.color, weight: Number(style.fontWeight), shadow: style.boxShadow,
                border: style.borderLeftWidth, radius: style.borderRadius, opacity: Number(style.opacity),
                outline: style.outlineStyle, outlineWidth: style.outlineWidth,
                clipped: node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1,
                width: box.width };
            };
            const selected = await chosen.evaluate(measure), idle = await other.evaluate(measure);
            const track = await control.evaluate(measure);
            track.padding = await control.evaluate(node => getComputedStyle(node).padding);
            const brightness = bg => bg.split(',').slice(0, 3).reduce((sum, value) => sum + Number(value), 0);
            assert.ok(brightness(selected.bg) > brightness(track.bg), 'selected surface is lighter than track in either theme');
            assert.notEqual(selected.bg, track.bg, 'selected surface differs from track');
            assert.equal(idle.bg, '0,0,0,0', 'idle option shows track');
            assert.notEqual(selected.shadow, 'none'); assert.ok(selected.weight >= 600);
            assert.notEqual(selected.color, idle.color); assert.equal(track.padding, '2px');
            assert.equal(idle.border, '0px'); assert.equal(selected.border, '0px');
            assert.notEqual(selected.radius, '0px');
            await chosen.hover(); await page.waitForTimeout(180); assert.equal((await chosen.evaluate(measure)).bg, selected.bg, 'selected hover stays raised');
            await other.hover();
            await page.waitForTimeout(180);
            assert.notEqual((await other.evaluate(measure)).bg, idle.bg, 'idle hover is visible');
            await page.keyboard.press('Tab'); await other.focus();
            const focus = await other.evaluate(measure);
            assert.equal(focus.outline, 'solid'); assert.equal(focus.outlineWidth, '2px');
            const clipped = await control.locator('button').evaluateAll(nodes => nodes.filter(node => {
              const s = getComputedStyle(node); if (s.display === 'none') return false;
              return node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;
            }).map(node => node.textContent.trim()));
            assert.deepEqual(clipped, [], 'all option labels fit');
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page does not overflow');
            if (evidence) await page.screenshot({ path: path.join(evidence, `segments-${name}-${width}-${theme}.png`) });
            // Native disabled state is a styling-only fixture; no product behavior is changed.
            const disabled = await other.elementHandle();
            assert.equal(await disabled.evaluate(node => { node.disabled = true; return Number(getComputedStyle(node).opacity); }), .5);
            if (name === 'usage' && width === 390) {
              const custom = control.locator('.wb-usage-custom-btn'); await custom.click();
              assert.equal((await custom.evaluate(measure)).bg, selected.bg, 'expanded custom range uses same raised surface');
            }
          } finally { await context.close(); }
        });
      }
    }, { timeoutMs: 170_000 });
  });
