import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';
import { startPage } from '../skills/dashboard/__tests__/helpers/workbench-browser.js';

function fleetFixture() {
  const summary = {
    running: 4, listKnown: true, counts: { busy: 1, idle: 1, error: 2 }, problemCount: 2,
    problems: [
      { sessionGroup: 'one', displayName: 'Group one', reason: 'start_failed' },
      { sessionGroup: 'two', displayName: 'Group two', reason: 'auth_failed' },
    ],
    pool: { used: 4, capacity: 6 },
  };
  const agents = Array.from({ length: 11 }, (_, index) => ({
    name: `Node ${String(index + 1).padStart(2, '0')}`,
    self: index === 0, state: 'IDLE', pulse_rate: 1, session_mode: 'single',
    daily_cost: 1, weekly_cost: 2, rate_limit_7d_pct: 21,
    cpu_pct: 13, mem_pct: 24, disk_pct: 35, access: 'read',
  }));
  Object.assign(agents[9], { state: 'BUSY', session_mode: 'multi', group_summary: summary });
  Object.assign(agents[10], { state: 'OFFLINE', pulse_rate: 0, last_seen: new Date(Date.now() - 120 * 60_000).toISOString() });
  return { agents, updated_at: new Date().toISOString() };
}

// Loads the actual Dashboard, CSS and Fleet navigation with loopback fixture APIs. Run when
// Fleet view controls, layout, list data, pagination or links change. Skip without the integration
// gate. The private harness checks HOME, ZYLOS_DIR, PM2_HOME, TMPDIR, socket and DB destinations;
// no runtime, PM2, tmux or database is started, and listeners/Chromium are closed on failure.
test('Fleet list persists, pages and links the same machines as cards across desktop and phone',
  { skip: !chatEnabled(), timeout: 90_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
      const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
      const chartAsset = process.env.ZYLOS_CHAT_CHART_ASSET;
      for (const filename of [modulePath, executablePath, chartAsset]) {
        assert.ok(filename && fs.existsSync(filename), 'explicit browser and chart dependencies required');
      }
      const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
      if (evidence) fs.mkdirSync(evidence, { recursive: true });
      console.log('Fleet browser isolation:', JSON.stringify(sandbox.assertIsolation()));
      const { base } = await startPage(sandbox);
      const { chromium } = await import(pathToFileURL(modulePath));
      const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
        args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
      sandbox.addCleanup(() => browser.close());
      const fixture = fleetFixture();

      for (const width of [1280, 390]) {
        await t.test(`${width}px Fleet renders, paginates and opens machines`, async () => {
          const mobile = width === 390;
          const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US',
            ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
          sandbox.addCleanup(() => context.close());
          await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
          await context.route('**/_assets/vendor/chart.umd.js', route => route.fulfill({ path: chartAsset, contentType: 'text/javascript' }));
          await context.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
          await context.addInitScript(base => {
            if (location.origin !== base) return;
            localStorage.setItem('zylos-dashboard-theme', 'light');
            localStorage.setItem('zylos-dashboard-locale', 'en');
          }, base);
          const page = await context.newPage();
          page.setDefaultTimeout(7000);
          let error;
          page.on('pageerror', failure => { error ??= failure; });
          let fleetReads = 0;
          let payload = fixture;
          await page.route('**/api/fleet', route => {
            fleetReads += 1;
            return route.fulfill({ json: payload });
          });
          try {
            await page.goto(base + '/');
            const cards = page.locator('.wb-f-card');
            const rows = page.locator('.wb-f-list-row');
            const cardMode = page.getByRole('button', { name: 'Cards', exact: true });
            const listMode = page.getByRole('button', { name: 'List', exact: true });
            const summary = page.locator('.agent-fleet-summary');
            const pagination = summary.getByRole('navigation', { name: 'Machine pages' });
            const names = locator => locator.evaluateAll(nodes => nodes.map(node => node.dataset.agent));
            const firstPage = ['Node 11', 'Node 10', 'Node 01', 'Node 02', 'Node 03', 'Node 04', 'Node 05', 'Node 06'];
            const lastPage = ['Node 07', 'Node 08', 'Node 09'];

            await cards.first().waitFor();
            assert.equal(await cardMode.getAttribute('aria-pressed'), 'true');
            assert.deepEqual(await names(cards), firstPage);
            assert.equal(await cards.nth(1).getByRole('link', { name: 'Node 10', exact: true }).count(), 1);
            const offlineCard = cards.filter({ hasText: 'Node 11' });
            assert.equal(await offlineCard.getByRole('link').count(), 0);
            const refresh = offlineCard.getByRole('button', { name: 'Refresh status' });
            assert.equal(await refresh.count(), 1);
            const previousReads = fleetReads;
            await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/fleet')), refresh.click()]);
            assert.ok(fleetReads > previousReads);
            assert.equal(await page.getByRole('button', { name: /^(Open|Settings)$/ }).and(page.locator('#agent-fleet-root button')).count(), 0);

            if (evidence) {
              await page.mouse.move(0, 0);
              await page.screenshot({ path: path.join(evidence, `fleet-card-view-${width}-light.png`) });
            }
            await listMode.click();
            await rows.first().waitFor();
            assert.equal(await listMode.getAttribute('aria-pressed'), 'true');
            assert.deepEqual(await names(rows), firstPage);
            const group = rows.nth(1);
            const condition = group.locator(mobile ? '.wb-f-list-mobile' : '.wb-f-list-condition');
            assert.match(await condition.innerText(), mobile ? /2 problems/ : /Group one · Start failed \+1/);
            assert.match(await condition.getAttribute('title'), /Group two · Authentication failed/);
            assert.equal(await group.getByRole('link', { name: 'Node 10', exact: true }).count(), 1);
            const down = rows.first();
            assert.equal(await down.getByRole('link').count(), 0);
            assert.match(await down.innerText(), /Cannot connect · last reachable/);
            assert.equal(await down.locator('.wb-ico-chev').count(), 0);

            const totals = await summary.locator('.sum-states, .sum-costs').allTextContents();
            for (const value of ['1 Working', '9 Idle', '1 Offline', '$11.00', '$22.00']) {
              assert.ok(totals.join(' ').includes(value), value);
            }
            assert.match(await pagination.innerText(), /1–8 \/ 11 machines/);
            assert.equal(await pagination.getByRole('button', { name: 'Previous page' }).isDisabled(), true);
            await pagination.getByRole('button', { name: 'Next page' }).click();
            assert.deepEqual(await names(rows), lastPage);
            assert.match(await pagination.innerText(), /9–11 \/ 11 machines/);
            assert.equal(await pagination.getByRole('button', { name: 'Next page' }).isDisabled(), true);
            assert.deepEqual(await summary.locator('.sum-states, .sum-costs').allTextContents(), totals);
            await cardMode.click();
            assert.deepEqual(await names(cards), lastPage);
            if (!mobile) {
              // Attention makes machines sort earlier. Fill the first page before giving Node 09 its own notice.
              await pagination.getByRole('button', { name: 'Previous page' }).click();
              payload = structuredClone(fixture);
              for (const agent of payload.agents.slice(1, 8)) agent.supervisor_paused = true;
              Object.assign(payload.agents[8], { session_mode: 'multi', group_summary: { ...payload.agents[9].group_summary,
                attention: [{ kind: 'data_unreadable', group: 'node-09-group', displayName: 'Node 09 diagnostic' }],
              } });
              await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/fleet')), refresh.click()]);
              await page.mouse.move(0, 0);
              await cards.locator('[data-supervisor-paused]').first().waitFor();
              await pagination.getByRole('button', { name: 'Next page' }).click();
              assert.match(await cards.filter({ has: page.getByRole('link', { name: 'Node 09', exact: true }) })
                .locator('[data-fleet-attention]').innerText(), /Node 09 diagnostic/);
              payload = fixture;
            }
            await listMode.click();

            await page.reload();
            await rows.first().waitFor();
            assert.equal(await listMode.getAttribute('aria-pressed'), 'true');
            assert.deepEqual(await names(rows), firstPage);
            const host = page.getByRole('columnheader', { name: 'CPU · Memory · Disk' });
            assert.equal(await host.count(), 0);
            if (!mobile) {
              await page.locator('#wb-tech-btn').click();
              await host.waitFor();
              assert.equal(await group.locator('.wb-f-list-host').innerText(), '13% · 24% · 35%');
              await page.locator('#wb-tech-btn').click();
              assert.equal(await host.count(), 0);
            }
            const geometry = await page.evaluate(() => {
              const box = selector => {
                const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
                return { x, y, width, height, center: y + height / 2 };
              };
              return { width: document.documentElement.scrollWidth, toggle: box('#fleet-layout'),
                manage: box('#fleet-manage-open'), prev: box('[data-fleet-page="-1"]'),
                name: box('.wb-f-list-name'), state: box('.wb-f-list-state'), details: box('.wb-f-list-mobile') };
            });
            assert.ok(geometry.width <= width, 'no horizontal page overflow');
            assert.equal(geometry.toggle.height, mobile ? 36 : 30);
            assert.equal(geometry.manage.height, geometry.toggle.height);
            assert.ok(Math.abs(geometry.manage.center - geometry.toggle.center) <= 1);
            assert.equal(geometry.prev.width, mobile ? 36 : 26);
            assert.equal(geometry.prev.height, geometry.prev.width);
            if (mobile) {
              assert.ok(Math.abs(geometry.name.center - geometry.state.center) <= 1, 'name and state share the first row');
              assert.ok(geometry.details.y > geometry.state.y, 'details occupy the second row');
              assert.match(await group.locator('.wb-f-list-mobile').innerText(), /4 groups.*2 problems.*Quota 79%.*Today \$1.00/s);
            } else {
              assert.match(await group.locator('.wb-f-list-running').innerText(), /4 groups · 1 working/);
              assert.equal(await group.locator('.wb-gbar i').count(), 3);
              assert.equal(await group.locator('.wb-f-list-pool').innerText(), '4/6');
              const single = rows.nth(2);
              assert.equal(await single.locator('.wb-f-list-pool').innerText(), '—');
              assert.equal(await single.locator('.wb-f-list-running .wb-pill').innerText(), 'Idle');
            }
            console.log('Fleet layout geometry:', JSON.stringify({ width, ...geometry }));
            if (evidence) {
              await page.mouse.move(0, 0);
              await page.screenshot({ path: path.join(evidence, `fleet-list-${width}-light.png`) });
            }
            const originalDocument = await page.locator('#agent-fleet-root').elementHandle();
            if (mobile) {
              await down.locator('.wb-f-list-mobile').tap();
              assert.equal(new URL(page.url()).pathname, '/');
              const hit = await group.locator('.wb-f-list-mobile').boundingBox();
              await page.touchscreen.tap(hit.x + hit.width / 2, hit.y + hit.height / 2);
            } else {
              await group.getByRole('link', { name: 'Node 10', exact: true }).click();
            }
            await page.waitForURL('**/fleet/Node%2010/');
            await page.locator('#tab-overview.active').waitFor();
            assert.equal(await originalDocument.evaluate(node => node === document.querySelector('#agent-fleet-root')), true,
              'opening a machine retains the original document');
            assert.equal(error, undefined);
          } finally {
            await context.close();
          }
        });
      }
    }, { timeoutMs: 85_000 });
    assert.equal(fs.existsSync(sandbox.root), false);
    assert.ok([...sandbox.servers].every(server => !server.listening));
    assert.deepEqual(sandbox.counts, { db: 0, http: 1, runtime: 0 });
  });
