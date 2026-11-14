import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateToFleetRecord } from '../../src/lib/fleet-poller.js';
import { workbenchAnswer, GROUP } from '../fixtures/workbench-browser-api.js';
import { startPage } from './workbench-browser.js';

const LONG_NAME = '多 session #56 — 需要完整显示名称的非常长的运维会话与工作任务';
const recordDiagnostic = (items, value) => {
  if (items.length < 10) items.push(String(value).slice(0, 1000));
};
function problem(sessionGroup, displayName, reason, durationSeconds) {
  return { sessionGroup, displayName, name: { displayName }, createdAt: 1, c4: null, reason, durationSeconds };
}
function summary(problems = [], extras = {}) {
  const noResponse = problems.filter(p => p.reason === 'no_response').length;
  return { running: 9, counts: { busy: 2, idle: 7 - problems.length, waiting: 0, unknown: 0,
    error: problems.length - noResponse, no_response: noResponse || null },
    problems: problems.slice(0, 2), problemCount: problems.length, pool: { used: 9, capacity: 12 },
    noResponse: null, autoRestarts: null, listKnown: true, ...extras };
}
const TWO = [problem(GROUP, LONG_NAME, 'no_response', 1020), problem('lark:oc_product', 'Lark 运维群', 'auth_failed', null)];
const THREE_ERRORS = [problem(GROUP, LONG_NAME, 'start_failed', null), TWO[1],
  problem('telegram:dm-1002', 'Third startup failure', 'start_failed', null)];
const CASES = [
  { name: 'normal', summary: summary(), rows: 0 },
  // Supervisor integration is pending: these future no-response/restart fields exercise PRESENTATION ONLY. They do
  // not claim production detection, elapsed-time correctness, or live restart history integration.
  { name: 'two-problems', summary: summary(TWO), rows: 2, future: true },
  { name: 'more-problems', summary: summary(THREE_ERRORS), rows: 2, more: true },
  { name: 'restart', summary: summary(TWO, { autoRestarts: { count: 1, windowSeconds: 3600 } }), rows: 2, restart: true, future: true },
  { name: 'remote-multi', summary: summary([TWO[1]]), rows: 1, remote: true },
  { name: 'legacy-remote', rows: 0, remote: true, legacy: true },
];

// Keep the pre-existing workbench snapshot deliberately smaller than the summary (three old rows versus
// nine running groups). A card derived from that snapshot instead of /api/fleet must fail this case.
function fixtureAnswer(url, now, scenario, fleet) {
  if (url.pathname === '/api/fleet') return fleet;
  const value = workbenchAnswer(url, now);
  if (url.pathname === '/api/state') return { ...value, session_mode: 'multi', group_summary: fleet.agents[0].group_summary };
  if (url.pathname !== '/api/workbench/groups') return value;
  const rows = value.rows.map(row => {
    const issue = scenario.summary?.problems.find(item => item.sessionGroup === row.sessionGroup);
    return issue ? { ...row, presence: 'running', name: { displayName: issue.displayName },
      state: issue.reason === 'no_response' ? { kind: 'busy' } : { kind: 'error', error: issue.reason } } : row;
  });
  return { ...value, rows };
}

async function assertProblemLayout(card, scenario) {
  const rows = card.locator('[data-fleet-group]');
  assert.equal(await rows.count(), scenario.rows, 'at most two visible abnormal rows');
  for (const [index, row] of (await rows.all()).entries()) {
    const issue = scenario.summary.problems[index];
    assert.equal(await row.getAttribute('data-fleet-group'), issue.sessionGroup, 'problem retains group navigation key');
    assert.equal(await row.locator('.wb-f-problem-name').innerText(), issue.displayName, 'saved name shown as text');
    const reason = await row.locator('.wb-f-problem-reason').innerText();
    const expectedReason = { no_response: '无响应', auth_failed: '认证失败', start_failed: '启动失败' }[issue.reason];
    assert.ok(reason.startsWith(expectedReason), 'named row includes the correct localized reason');
    if (issue.reason === 'no_response') assert.match(await row.innerText(), /无响应\s*17\s*分钟/, 'supplied future duration renders as 17 minutes');
    if (issue.durationSeconds === null) assert.doesNotMatch(await row.innerText(), /\d+\s*分钟/, 'unknown problem age stays hidden');
    const layout = await row.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const children = [...node.querySelectorAll('.wb-f-problem-name, .wb-f-problem-reason')];
      return { height: rect.height, children: children.map(child => {
        const box = child.getBoundingClientRect(), style = getComputedStyle(child);
        return { top: box.top, bottom: box.bottom, height: box.height, lineHeight: parseFloat(style.lineHeight),
          whiteSpace: style.whiteSpace, overflow: style.overflow, textOverflow: style.textOverflow,
          clipped: child.scrollWidth > child.clientWidth + 1 };
      }) };
    });
    assert.ok(layout.height >= 18 && layout.height <= 20, 'one fixed compact 19px problem row');
    assert.equal(layout.children.length, 2, 'both name and reason measurable');
    for (const child of layout.children) {
      assert.equal(child.whiteSpace, 'nowrap', 'name/reason never wraps');
      assert.equal(child.overflow, 'hidden', 'long text stays within row');
      assert.equal(child.textOverflow, 'ellipsis', 'clipped content uses an ellipsis');
      assert.ok(child.height <= child.lineHeight + 1, 'content occupies one line');
    }
    assert.ok(Math.abs(layout.children[0].top - layout.children[1].top) <= 2, 'name and reason share a single line');
    if (issue.displayName === LONG_NAME) assert.equal(layout.children[0].clipped, true, 'long fixture name actually overflows and receives ellipsis');
  }
}

export async function runFleetRunningGroupsBrowser(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE, executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  const chartAsset = process.env.ZYLOS_CHAT_CHART_ASSET, evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  for (const [label, value] of [['Playwright module', modulePath], ['browser', executablePath], ['Chart.js', chartAsset]]) {
    assert.ok(value && fs.existsSync(value), `explicit preinstalled ${label} required`);
  }
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, 'fleet-running-manifest.json'), JSON.stringify({
      source: 'Actual Dashboard assets with isolated API rendering fixtures',
      boundary: 'No-response age and automatic-restart fixtures are supplied future contracts, not ZYLO-428 live integration evidence.',
      widths: [390, 1280], themes: ['light', 'dark'],
      cases: CASES.map(({ name, future, remote, legacy }) => ({ name, futureContract: !!future, remote: !!remote, legacy: !!legacy })),
    }, null, 2) + '\n');
  }
  console.log('Running groups browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const { base, unserved } = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(async () => { await browser.close(); assert.equal(browser.isConnected(), false, 'browser reclaimed'); });

  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) for (const scenario of CASES) {
    let scenarioFailure;
    await t.test(`${width}px ${theme}: ${scenario.name}${scenario.future ? ' (future-contract rendering fixture)' : ''}`, async () => {
      const now = Date.now(), errors = [], external = [], remoteReads = [];
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, locale: 'zh-CN',
        ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
      sandbox.addCleanup(() => context.close());
      try {
        await context.route('**/*', route => {
          const url = route.request().url();
          if (url.startsWith(base + '/')) return route.continue();
          // Fonts referenced by production CSS have no network access. Other external calls fail the case.
          if (!/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//.test(url)) recordDiagnostic(external, url);
          return route.abort();
        });
        await context.route('**/_assets/vendor/chart.umd.js', route => route.fulfill({ path: chartAsset, contentType: 'text/javascript' }));
        await context.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
        await context.addInitScript(theme => {
          try { localStorage.setItem('zylos-dashboard-locale', 'zh'); localStorage.setItem('zylos-dashboard-theme', theme);
            localStorage.setItem('zylos-dashboard-detail-level', 'technical'); } catch {}
        }, theme);
        const page = await context.newPage(); page.setDefaultTimeout(10_000);
        page.on('pageerror', error => recordDiagnostic(errors, error.message));
        page.on('console', message => { if (message.type() === 'error' && !message.text().includes('net::ERR_FAILED')) recordDiagnostic(errors, message.text()); });
        const make = (name, self) => ({ ...stateToFleetRecord({ name }, { state: 'IDLE' }, { self, access: 'admin', nowMs: now }),
          session_mode: 'multi', group_summary: summary() });
        const own = make('browser-case', true), remote = make('remote-case', false);
        const target = scenario.remote ? remote : own;
        if (scenario.legacy) { delete target.session_mode; delete target.group_summary; }
        else target.group_summary = scenario.summary;
        const fleet = { agents: [own, remote], updated_at: new Date(now).toISOString() };
        await page.route('**/api/**', route => {
          const url = new URL(route.request().url());
          assert.equal(route.request().method(), 'GET', 'render/navigation never mutates a runtime');
          if (url.pathname.startsWith('/fleet/remote-case/api/')) {
            remoteReads.push(url.pathname);
            url.pathname = url.pathname.slice('/fleet/remote-case'.length);
          }
          if (url.pathname === '/api/stream') return route.fulfill({ contentType: 'text/event-stream', body: '' });
          const answer = fixtureAnswer(url, now, scenario, fleet);
          if (answer !== undefined) return route.fulfill({ json: answer });
          return route.fallback();
        });
        await page.goto(base + '/');
        const card = page.locator(`#agent-fleet-root .wb-f-card[data-agent="${target.name}"]`);
        await card.waitFor();
        await page.waitForFunction(() => document.documentElement.dataset.theme === localStorage.getItem('zylos-dashboard-theme'));
        if (scenario.remote) {
          const ownCard = page.locator('#agent-fleet-root .wb-f-card[data-agent="browser-case"]');
          assert.match(await ownCard.innerText(), /全部正常/, 'remote problems never contaminate the local summary');
          assert.equal(await ownCard.locator('[data-fleet-group]').count(), 0, 'local and remote problem rows remain isolated');
        }
        if (scenario.legacy) {
          assert.doesNotMatch(await card.innerText(), /单 session|Single session/, 'missing remote mode is never guessed single');
          assert.match(await card.locator('.wb-mode-tag').innerText(), /未知|unknown/i, 'legacy mode explicitly unknown');
          assert.equal(await card.locator('[data-fleet-group]').count(), 0, 'legacy remote does not invent problems');
          assert.doesNotMatch(await card.innerText(), /全部正常|All normal/i, 'legacy remote does not invent a healthy group summary');
        } else {
          assert.match(await card.locator('.wb-mode-tag').innerText(), /多|Multi/, 'remote and self use actual multi mode');
          assert.match(await card.innerText(), /运行中\s*9|9\s*running/i, 'API summary wins over older workbench rows');
          await assertProblemLayout(card, scenario);
          const moreProblems = card.locator('[data-fleet-problems]').filter({ hasText: /另\s*\d+\s*个异常/ });
          assert.equal(await moreProblems.count(), scenario.more ? 1 : 0, 'more-problems line only beyond two');
          if (scenario.more) {
            assert.match(await moreProblems.innerText(), /另\s*1\s*个异常/, 'more count accounts for undisplayed abnormal group');
            const moreLayout = await moreProblems.evaluate(node => {
              const more = node.getBoundingClientRect(), last = node.previousElementSibling.getBoundingClientRect();
              return { height: more.height, gap: more.top - last.bottom };
            });
            assert.ok(moreLayout.height >= 18 && moreLayout.height <= 20, 'more link occupies one fixed compact line');
            assert.ok(moreLayout.gap >= 0 && moreLayout.gap <= 6, 'more link follows the second problem as the third line');
          }
          const displayedCounts = (await card.locator('.wb-f-running').innerText()).match(/\d+/g).map(Number);
          const expectedCounts = ['busy', 'idle', 'waiting', 'unknown', 'no_response', 'error']
            .map(kind => scenario.summary.counts[kind]).filter(value => value > 0);
          assert.deepEqual(displayedCounts, [9, ...expectedCounts], 'displayed categories use the supplied running partition');
          assert.equal(displayedCounts.slice(1).reduce((sum, value) => sum + value, 0), 9, 'visible categories sum to running total');
          if (scenario.restart) assert.match(await card.innerText(), /近\s*1\s*小时.*重启\s*1|restart.*1/i);
          if (!scenario.restart) assert.doesNotMatch(await card.innerText(), /近\s*1\s*小时.*重启|restarts?/i, 'absent restart data stays hidden');
          if (!scenario.rows) {
            assert.match(await card.innerText(), /全部正常|All normal/i);
            assert.equal(await card.locator('.wb-f-problem-name').count(), 0, 'normal summary has no empty problem rows');
            assert.equal(await card.locator('.wb-f-normal').evaluate(node => {
              const range = document.createRange(); range.selectNodeContents(node);
              return range.getClientRects().length;
            }), 1, 'all-normal summary stays on one line');
          }
          assert.doesNotMatch(await card.innerText(), /telegram:|lark:|dm-1001|oc_product|Bash|npm test/, 'card text exposes no raw addresses or tool detail');
          assert.doesNotMatch((await card.locator('[title]').evaluateAll(nodes => nodes.map(node => node.title))).join('\n'),
            /telegram:|lark:|dm-1001|oc_product|Bash|npm test/, 'card titles expose no raw addresses or tool detail');
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal page overflow');
        if (evidence) {
          const stem = `fleet-running-${scenario.name}-${width}-${theme}`;
          await page.screenshot({ path: path.join(evidence, stem + '.png'), fullPage: true });
          await card.screenshot({ path: path.join(evidence, stem + '-card.png') });
        }
        if (scenario.more) {
          await card.locator('[data-fleet-problems]').click();
          await page.locator('#wb-board').waitFor({ state: 'visible' });
          await page.locator('#fleet-view').waitFor({ state: 'hidden' });
          assert.equal(await page.locator('#fleet-view').isVisible(), false, 'more opens the group list');
          assert.ok(await page.locator('#wb-board .wb-row').count() > 0, 'group list contains actual workbench rows');
          const located = page.locator(`#wb-board .wb-row[data-group="${scenario.summary.problems[0].sessionGroup}"][aria-current="true"]`);
          await located.waitFor({ state: 'visible' });
          assert.equal(await located.getAttribute('aria-current'), 'true', 'more locates the actual first abnormal row');
          assert.equal(await located.evaluate(node => document.activeElement === node), true, 'located row receives keyboard focus');
          assert.equal(await page.locator('.wb-d-top').isVisible(), false, 'more enters list rather than group detail');
          if (evidence) await page.screenshot({ path: path.join(evidence, `fleet-running-more-located-${width}-${theme}.png`), fullPage: true });
        }
        if (scenario.remote && !scenario.legacy) {
          await card.locator('[data-fleet-group]').first().click();
          await page.locator('#fleet-view').waitFor({ state: 'hidden' });
          await page.locator('#wb-side .wb-d-top').waitFor({ state: 'visible' });
          assert.match(new URL(page.url()).pathname, /^\/fleet\/remote-case\//, 'remote problem enters the selected remote machine');
          assert.match(await page.locator('#wb-side .wb-d-title').innerText(), /Lark 运维群/, 'remote detail resolves the actual named problem');
          assert.ok(remoteReads.some(url => url === '/fleet/remote-case/api/workbench/groups'), 'remote group list uses the remote API prefix');
        }
        assert.deepEqual(errors, [], 'no browser errors');
        assert.deepEqual(external, [], 'no unexpected external requests');
      } catch (error) { scenarioFailure = error; throw error; }
      finally { await context.close(); }
    });
    // Stop after the first failing rendering/navigation case. In particular, the first phone problem row
    // proves the fixed-height CSS before spending time rendering the rest of the viewport/theme matrix.
    if (scenarioFailure) throw scenarioFailure;
  }
  assert.deepEqual([...unserved], [], 'all production API reads answered by fixture');
}
