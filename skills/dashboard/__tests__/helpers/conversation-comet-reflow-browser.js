import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startWorkingPage, workingBrowserNow as NOW } from './conversation-working-browser.js';

const text = '回复完成后的布局核对：真实页面会把活动区折叠在回复上方，并保持阅读位置。';
const stamp = ms => new Date(ms).toISOString();
const message = (id, direction, content) => ({ id, direction, channel: 'dashboard', content,
  timestamp: stamp(NOW - (40 - id) * 1000), status: 'delivered' });
const tool = (i, done) => ({ kind: 'tool', label: { key: 'described', arg: `核对布局项目 ${i + 1}` },
  start: NOW - 70000 + i * 1000, end: done ? NOW - 1000 : null, status: done ? 'done' : 'running' });
function activity(done, replyId = null) {
  return { now: stamp(NOW), items: [{ id: 31, state: 'round', round: '31' }], rounds: [{ key: '31',
    messageIds: [31], state: done ? 'done' : 'running', start: NOW - 73000, end: done ? NOW : null,
    segments: [{ replyId, start: NOW - 73000, end: done ? NOW : null,
      steps: Array.from({ length: 12 }, (_, i) => tool(i, done || i < 11)) }] }] };
}

export async function runCometReflowBrowser(t, sandbox, engine) {
  console.log('Comet reflow isolation:', JSON.stringify(sandbox.assertIsolation()));
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
  const executablePath = engine === 'webkit' ? process.env.ZYLOS_CHAT_WEBKIT_BIN : process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath), 'explicit Playwright module required');
  assert.ok(executablePath && fs.existsSync(executablePath), `explicit ${engine} executable required`);
  const playwright = await import(pathToFileURL(modulePath));
  const browser = await playwright[engine].launch({ executablePath, headless: true, env: sandbox.env,
    ...(engine === 'chromium' ? { args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] } : {}) });
  sandbox.addCleanup(() => browser.close());
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const fixture = await startWorkingPage(sandbox);
  for (const mobile of [false, true]) {
    let failed = false;
    await t.test(`${mobile ? 'touch dpr3' : 'desktop dpr1'} reply transitions`, async () => {
      const readsBefore = { ...fixture.counts };
      const history = Array.from({ length: 10 }, (_, i) => message(i + 1, i % 2 ? 'out' : 'in', `先前消息 ${i + 1}：${text}`));
      const input = message(31, 'in', '请输出回复并核对布局。');
      fixture.setScene('main'); fixture.setTitle('短标题'); fixture.setMainSince(NOW - 45000);
      fixture.setMessages([...history, input]); fixture.setActivity(activity(false));
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'UTC',
        isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 3 : 1, reducedMotion: 'no-preference' });
      sandbox.addCleanup(() => context.close());
      await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
      await context.addInitScript(() => {
        try { localStorage.setItem('zylos-dashboard-locale', 'zh'); } catch {}
      });
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      let pageError;
      page.on('pageerror', error => { pageError ??= error.message; });
      await page.clock.install({ time: new Date(NOW) });
      const name = `${engine}-${mobile ? 'touch3' : 'desktop1'}`;
      const phases = [];
      try {
        await page.goto(fixture.base + '/chat');
        await page.locator(`[data-conversation-id="${fixture.activeId()}"]`).click();
        await page.locator('.conversation-running .wi-comet').waitFor();
        await page.locator('.conversation-activity').first().waitFor();
        // Sample from rAF rather than polling at one coarse delay. Stop on the first
        // counterexample and cap captures, so failures cannot grow an unbounded log.
        await page.evaluate(() => {
          const capture = window.cometCapture = { phase: 'initial', frames: [], failure: null, running: true, limit: 2400 };
          const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
          const sample = time => {
            if (!capture.running || capture.frames.length >= capture.limit) return;
            const pill = document.querySelector('.conversation-running'), svg = pill?.querySelector('.wi-comet');
            const visible = pill && !pill.hidden && pill.getBoundingClientRect().height > 0;
            const frame = { time, phase: capture.phase, state: pill?.dataset.state, caption: pill?.innerText,
              pill: visible ? box(pill) : null, svg: visible && svg ? box(svg) : null,
              rect: visible && svg ? box(svg.querySelector('rect')) : null,
              scroll: document.querySelector('.conversation-stream')?.scrollTop,
              title: document.querySelector('.conversation-title-line h2')?.textContent };
            capture.frames.push(frame);
            if (frame.pill && frame.svg) {
              const delta = Math.max(...['left', 'top', 'right', 'bottom'].map(key => Math.abs(frame.pill[key] - frame.svg[key])));
              const rectDelta = Math.max(...['left', 'top', 'right', 'bottom'].map(key => Math.abs(frame.pill[key] - frame.rect[key])));
              if (delta > 2 || rectDelta > 2) capture.failure = { ...frame, delta, rectDelta };
            }
            if (capture.failure) { capture.running = false; return; }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        const phase = async (label, change, ms = 1000) => {
          await page.evaluate(label => { window.cometCapture.phase = label; }, label);
          await change();
          await page.clock.runFor(ms);
          const result = await page.evaluate(() => ({ failure: window.cometCapture.failure, frames: window.cometCapture.frames.length,
            visible: !!document.querySelector('.wi-comet'), state: document.querySelector('.conversation-running')?.dataset.state,
            messageIds: [...document.querySelectorAll('article[data-message-id]')].map(node => node.dataset.messageId),
            liveActivity: document.querySelectorAll('.conversation-activity-live').length,
            title: document.querySelector('.conversation-title-line h2')?.textContent }));
          phases.push({ label, ...result });
          if (evidence) await page.screenshot({ path: path.join(evidence, `${name}-${label}.png`) });
          assert.equal(pageError, undefined);
          assert.equal(result.failure, null, JSON.stringify(result.failure));
          return result;
        };
        const output = await phase('output', async () => {});
        assert.equal(output.liveActivity, 1, 'output phase mounts the open live activity area');
        const firstReply = message(32, 'out', text);
        const written = await phase('reply-write', async () => {
          fixture.setMessages([...history, input, firstReply]); fixture.setActivity(activity(true, 32));
          fixture.setTitle('回复写入时标题省略号变化'.repeat(3).slice(0, 40)); fixture.publish();
          await page.locator('[data-message-id="32"]').waitFor({ state: 'attached' });
        });
        assert.equal(written.liveActivity, 0, 'reply commit folds the former live activity area');
        assert.ok(written.title.length > 20, 'reply commit also changes the header title');
        await phase('reply-grow', async () => {
          fixture.setMessages([...history, input, firstReply, message(33, 'out', Array.from({ length: 16 }, (_, i) => `### 第 ${i + 1} 段\n\n${text}`).join('\n\n'))]);
          fixture.setTitle('短标题'); fixture.setScene('both'); fixture.publish();
          await page.locator('[data-message-id="33"]').waitFor({ state: 'attached' });
        }, 5200);
        await phase('scroll', async () => {
          await page.locator('.conversation-stream').evaluate(node => { node.scrollTop = 0; });
          await page.clock.runFor(100);
          await page.locator('.conversation-stream').evaluate(node => { node.scrollTop = Math.min(500, node.scrollHeight - node.clientHeight); });
        });
        await phase('minute-boundary', async () => {
          const until = await page.evaluate(since => Math.max(0, since + 60000 - Date.now() - 500), NOW - 45000);
          if (until) await page.clock.fastForward(until);
        }, 1800);
        await phase('subtasks', async () => { fixture.setScene('sub'); }, 5200);
        const idle = await phase('idle', async () => { fixture.setScene('idle'); fixture.publish(); }, 5200);
        assert.equal(idle.state, 'idle', 'working poll observes idle');
        assert.equal(idle.visible, false, 'idle removes the comet');
        const busy = await phase('busy-again', async () => {
          fixture.setScene('main'); fixture.setActivity(activity(false)); fixture.publish();
          await page.clock.fastForward(30000);
        }, 1200);
        assert.equal(busy.state, 'busy');
        assert.equal(busy.visible, true, 'new busy state restores the comet');
        const captures = await page.evaluate(() => { window.cometCapture.running = false; return window.cometCapture.frames; });
        assert.ok(captures.length >= 100, `recorded ${captures.length} frames`);
        assert.ok(captures.length < 2400, 'capture limit was not exhausted');
        assert.ok(fixture.counts.messages - readsBefore.messages >= 3 && fixture.counts.activity - readsBefore.activity >= 3, 'real polling/SSE fetched reply and activity changes');
        const widths = captures.filter(frame => frame.pill).map(frame => frame.pill.width);
        assert.ok(Math.max(...widths) - Math.min(...widths) > 2, 'capsule width really changed');
        const scrolls = captures.map(frame => frame.scroll).filter(Number.isFinite);
        assert.ok(Math.max(...scrolls) - Math.min(...scrolls) > 100, 'message list really scrolled');
        assert.equal(fixture.missing.size, 0, [...fixture.missing].join(', '));
        if (evidence) fs.writeFileSync(path.join(evidence, `${name}-frames.json`), JSON.stringify({ engine, version: browser.version(), mobile,
          dpr: mobile ? 3 : 1, phases, counts: fixture.counts, frames: captures }, null, 2));
        console.log('Comet reflow result:', JSON.stringify({ engine, version: browser.version(), mobile, frames: captures.length, phases }));
      } catch (error) { failed = true; throw error; } finally {
        if (!page.isClosed() && evidence) {
          const capture = await page.evaluate(() => {
            if (!window.cometCapture) return null;
            window.cometCapture.running = false;
            return { frames: window.cometCapture.frames, failure: window.cometCapture.failure };
          }).catch(() => null);
          fs.writeFileSync(path.join(evidence, `${name}-trace.json`), JSON.stringify({ engine, version: browser.version(), mobile, phases, capture }, null, 2));
        }
        if (!page.isClosed()) await page.evaluate(() => { if (window.cometCapture) window.cometCapture.running = false; }).catch(() => {});
        await context.close();
      }
    });
    if (failed) return;
  }
}
