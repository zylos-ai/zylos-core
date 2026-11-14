import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { startPage } from './helpers/workbench-browser.js';
import { startPage as startConversationPage } from './helpers/mobile-conversation-browser.js';

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

// Boundary: the shipped pages and CSS over the same private loopback APIs. The overview's group detail gives a real
// primary button (查看对话) and, through 重启, the real confirmation dialog with its danger button; the conversation page
// gives 新建对话, 发送, 添加附件 and the text field, and its message read is answered with one file attachment so the
// history shows the real attachment action (下载). Run for changes to button or message-box focus styles (.wb-btn and its
// filled variants, .chat-attachment-actions, .conversation-compose-box); skip unrelated backend work. Same isolation
// and cleanup as the case above; no action is sent (the dialog is cancelled).
const CONVERSATION = 'g:' + Buffer.from('dashboard:mobile-browser').toString('hex').toUpperCase();

// Focus a control as the keyboard would, let its transitions finish, and count the rings it draws: an outline, or a
// box-shadow ring (no offset, no blur, a spread of 2px or more, not transparent). A hairline 1px shadow is a border.
async function focusRings(page, locator, frameSelector) {
  await locator.evaluate(node => node.focus({ focusVisible: true }));
  return locator.evaluate((node, frameSelector) => {
    for (const animation of document.getAnimations()) if (animation instanceof CSSTransition) animation.finish();
    const rings = target => {
      if (!target) return { outline: false, shadow: false };
      const style = getComputedStyle(target);
      const shadow = style.boxShadow === 'none' ? false : style.boxShadow.split(/,(?![^(]*\))/).some(part => {
        if (/rgba\(0, 0, 0, 0\)|\/ 0\)/.test(part)) return false;
        const [x, y, blur, spread] = [...part.matchAll(/(-?[\d.]+)px/g)].map(match => Number(match[1]));
        return x === 0 && y === 0 && blur === 0 && spread >= 2;
      });
      return { outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0, shadow, outlineStyle: style.outlineStyle, boxShadow: style.boxShadow };
    };
    return { focused: document.activeElement === node, visible: node.matches(':focus-visible'), self: rings(node), frame: rings(frameSelector ? node.closest(frameSelector) : null) };
  }, frameSelector);
}
const count = rings => Number(rings.outline) + Number(rings.shadow);

test('a button, or the message box around it, shows one focus ring',
  { skip: !chatEnabled(), timeout: 240_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      console.log('Focus ring browser isolation:', JSON.stringify(sandbox.assertIsolation()));
      const chartAsset = process.env.ZYLOS_CHAT_CHART_ASSET;
      assert.ok(chartAsset && fs.existsSync(chartAsset), 'explicit preinstalled Chart.js required');
      const overview = await startPage(sandbox), chat = await startConversationPage(sandbox);
      const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
      const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN,
        headless: true, env: sandbox.env, args: ['--no-sandbox', '--disable-background-networking'] });
      sandbox.addCleanup(() => browser.close());
      const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
      if (evidence) fs.mkdirSync(evidence, { recursive: true });
      const open = async (base, route, width, theme) => {
        const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'zh-CN', colorScheme: theme,
          ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
        sandbox.addCleanup(() => context.close());
        await context.route('**/*', request => request.request().url().startsWith(base + '/') ? request.continue() : request.abort());
        await context.route(base + '/_assets/vendor/chart.umd.js', request => request.fulfill({ path: chartAsset, contentType: 'text/javascript' }));
        await context.route(base + '/api/chat/conversations/*/messages*', async request => {
          const answer = await (await request.fetch()).json();
          const reply = answer.items?.find(item => item.direction === 'out');
          if (reply) reply.attachments = [{ id: 'plan', name: '方案资料.pdf', kind: 'file', available: true, size: 84 }];
          await request.fulfill({ json: answer });
        });
        await context.addInitScript(value => {
          if (window.top !== window) return;
          localStorage.setItem('zylos-dashboard-locale', 'zh');
          localStorage.setItem('zylos-dashboard-theme', value);
        }, theme);
        const page = await context.newPage(); page.setDefaultTimeout(7000);
        const errors = [];
        page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
        await page.goto(base + route);
        return { context, page, errors };
      };
      const shot = async (page, locator, name) => {
        if (!evidence) return;
        const box = await locator.boundingBox(), pad = 12, view = page.viewportSize();
        const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
        await page.screenshot({ path: path.join(evidence, `focus-ring-${name}.png`),
          clip: { x, y, width: Math.min(view.width - x, box.width + 2 * pad), height: Math.min(view.height - y, box.height + 2 * pad) } });
      };
      const one = (name, read) => {
        assert.equal(read.focused, true, `${name}: has focus`);
        assert.equal(read.visible, true, `${name}: keyboard focus is visible`);
        assert.equal(count(read.self), 1, `${name}: one ring, not an outline and a shadow ring together (${read.self.outlineStyle} / ${read.self.boxShadow})`);
      };
      for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
        const tag = `${width}-${theme}`;
        await t.test(`group detail and its confirmation ${width}px ${theme}`, async () => {
          const { context, page, errors } = await open(overview.base, '/', width, theme);
          const sent = overview.actions.length;
          try {
            await page.locator('#wb-board .wb-row', { hasText: 'Telegram direct chat' }).click();
            const view = page.locator('.wb-d-top .wb-d-conv');
            await view.waitFor();
            one('查看对话 (primary)', await focusRings(page, view));
            await shot(page, view, `primary-${tag}`);
            const restart = page.locator('.wb-d-top [data-wb-action="restart"]');
            await restart.click();
            const dialog = page.locator('.wb-modal[role="alertdialog"]'), danger = dialog.locator('.wb-btn-danger');
            await danger.waitFor();
            one('confirm (danger)', await focusRings(page, danger));
            await shot(page, danger, `danger-${tag}`);
            await dialog.locator('.wb-modal-acts .wb-btn:not(.wb-btn-danger)').click();
            await dialog.waitFor({ state: 'detached' });
            assert.equal(overview.actions.length, sent, 'cancelling sends nothing');
            assert.deepEqual(errors, [], 'no page errors');
          } finally { await context.close(); }
        });
        await t.test(`conversation buttons and message box ${width}px ${theme}`, async () => {
          const { context, page, errors } = await open(chat.base, '/chat', width, theme);
          try {
            if (width > 760) { // Phones start a conversation from the mobile header instead.
              const create = page.locator('#wb-chat .conversation-create');
              await create.waitFor();
              one('新建对话 (primary)', await focusRings(page, create));
              await shot(page, create, `create-${tag}`);
            }
            await page.locator(`#wb-chat [data-conversation-id="${CONVERSATION}"]`).first().click();
            const input = page.locator('#wb-chat .conversation-input');
            await input.waitFor();
            const download = page.locator('#wb-chat .conversation-message .chat-attachment-actions .wb-btn').first();
            await download.waitFor();
            await download.scrollIntoViewIfNeeded();
            one('下载 (attachment action)', await focusRings(page, download));
            await shot(page, download, `attachment-${tag}`);
            await input.fill('看一下');
            const frame = '.conversation-compose-box';
            for (const [name, selector] of [['添加附件', '.conversation-attach'], ['发送', '.conversation-send']]) {
              const button = page.locator(`#wb-chat ${selector}`);
              const read = await focusRings(page, button, frame);
              one(name, read);
              assert.equal(count(read.frame), 0, `${name}: the message box does not light around the focused button (${read.frame.outlineStyle} / ${read.frame.boxShadow})`);
              await shot(page, page.locator(`#wb-chat ${frame}`), `${selector === '.conversation-send' ? 'send' : 'attach'}-${tag}`);
            }
            const typing = await focusRings(page, input, frame);
            assert.equal(typing.focused, true, 'the text field has focus');
            assert.equal(count(typing.frame) + count(typing.self), 1,
              `typing: one ring, on the box or on the field (box ${typing.frame.outlineStyle} / field ${typing.self.outlineStyle} ${typing.self.boxShadow})`);
            if (width > 760) assert.equal(typing.frame.outline, true, 'desktop: the message box lights while typing');
            await shot(page, page.locator(`#wb-chat ${frame}`), `typing-${tag}`);
            assert.deepEqual(errors, [], 'no page errors');
          } finally { await context.close(); }
        });
      }
    }, { timeoutMs: 230_000 });
  });
