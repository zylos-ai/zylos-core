import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderAttention } from '../public/js/wb/attention-bar.js';
import { waitText } from '../public/js/wb/view-mode.js';
import { detailNumbers, renderOverview } from '../public/js/wb/detail-overview.js';
import { renderDistribution } from '../public/js/wb/board.js';
import { systemItems } from '../public/js/wb/instance-strip.js';
import { createMemoryScope } from '../public/js/wb/memory-scope.js';
import { renderDefaults, runtimeConfirmation } from '../public/js/wb/settings-defaults.js';
import { mountSchedule } from '../public/js/wb/schedule.js';
import { createDocument, allNodes, tick } from './fixtures/workbench-dom.js';
import { documentFixture } from './fixtures/settings-dom.js';
const en = JSON.parse(readFileSync(new URL('../public/i18n/wb.en.json', import.meta.url)));
const t = (key, values = {}) => (en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
const groups = count => Array.from({ length: count }, (_, n) => ({ sessionGroup: `telegram:dm-${n}`, presence: 'running', state: { kind: 'working' }, name: { displayName: `Group ${n}` }, target: { runtime: 'claude' } }));
for (const count of [1, 2]) {
  const noun = count === 1 ? '' : 's';
  test(`Workbench waiting and attention render English count ${count}`, () => {
    const document = createDocument(), root = document.createElement('div');
    for (const cooldownUntil of [null, Date.now() + 60000]) assert.match(waitText({ kind: 'rate_wait', pendingCount: count, cooldownUntil }, 'plain', t), new RegExp(`${count} message${noun} ${count === 1 ? 'is' : 'are'} waiting`));
    renderAttention(root, { attention: { problems: [
      { kind: 'auth_failed', runtime: 'claude', groups: groups(count).map(row => row.sessionGroup), extraUnknown: count },
      { kind: 'start_failed', count30m: count }, { kind: 'pool_full', waiting: count },
    ] } }, { document, t });
    for (const text of [`${count} group${noun} affected`, `${count} more group${noun} ${count === 1 ? 'has' : 'have'} unknown status`, `${count} attempt${noun} in 30 minutes`, `${count} group${noun} waiting`]) assert.ok(root.textContent.includes(text), text);
  });
  test(`Workbench overview, board and host render English count ${count}`, () => {
    const document = createDocument(), root = document.createElement('div');
    renderDistribution(root, { rows: groups(count) }, { document, t });
    assert.equal(root.children[0].textContent, `${count} group${noun}`);
    const row = { ...groups(1)[0], createdAt: 1000, live: { runId: 'r' }, working: { on: true, since: 1000000 }, launchConfig: { runtime: 'claude', mode: 'default' }, tools: [] };
    assert.equal(detailNumbers(row, { now: 1000000 + count * 60000 }, t)[2].value, `${count} minute${noun}`);
    renderOverview(root, row, { backlog: { count }, currentEvents: groups(count).map((_, n) => ({ event_type: 'subagent_start', run_id: 'r', agent_id: String(n) })) }, { document, t });
    assert.ok(root.textContent.includes(`${count} background subtask${noun}`), root.textContent);
    assert.ok(root.textContent.includes(`Memory: ${count} new conversation${noun} to save`));
    assert.ok(systemItems(document, { cpu_count: count, cpu_pct: 10, sampledAt: 100 }, { t, readAt: 100 }).some(item => item.title.includes(`${count} core${noun}`)));
  });
  test(`Workbench defaults render English count ${count}`, () => {
    const document = documentFixture(), root = document.createElement('div');
    const snapshot = { rows: groups(count), baselineRuntime: 'claude', overrides: { runtime: [], model: [] } };
    const panel = renderDefaults(root, { document, t, snapshot, page: { runtimeTotal: count }, metadata: { claude: { runtime: 'claude', current_model: 'one', current_effort: 'high', models: [{ id: 'one' }], efforts_by_model: { one: ['high'] } } }, read: async () => ({}) });
    assert.ok(root.textContent.includes(`Switching interrupts ${count} running group${noun}`));
    assert.ok(root.textContent.includes(`${count} group${noun} ${count === 1 ? 'sets its' : 'set their'} own engine`));
    assert.ok(root.textContent.includes(count === 1 ? 'Show this group' : 'Show these 2 groups'));
    assert.ok(root.textContent.includes(`${count} running group${noun} ${count === 1 ? 'uses' : 'use'} these defaults`), root.textContent);
    assert.ok(runtimeConfirmation(snapshot, t).includes(`${count} running group${noun} that ${count === 1 ? 'follows' : 'follow'} the default`));
    panel.destroy();
  });
  test(`Workbench memory renders English count ${count}`, async () => {
    const document = createDocument(), root = document.createElement('div'), chartsRoot = document.createElement('div'), summaryRoot = document.createElement('div');
    const active = groups(count).map(row => ({ sessionGroup: row.sessionGroup, count, threshold: 15, pendingSummaries: count, syncing: true }));
    const quiet = groups(count).map(row => ({ sessionGroup: row.sessionGroup + 'quiet', count: 0, threshold: 15, syncing: false }));
    let rows = [...active, ...quiet], level = 'plain';
    const controller = createMemoryScope({ document, root, chartsRoot, summaryRoot, t, getTree: () => ({ root: { children: [] }, sessionGroups: [] }), detail: () => level, request: async () => ({ groups: rows, originSync: { count, threshold: 15, pendingSummaries: count, syncing: false } }) });
    await controller.load();
    assert.ok(summaryRoot.textContent.includes(`${count} group${noun} being saved`));
    assert.ok(summaryRoot.textContent.includes(`${count} group${noun} ${count === 1 ? 'has' : 'have'} new conversation waiting`));
    level = 'technical'; controller.render();
    assert.ok(chartsRoot.textContent.includes(`${count} unread summar${count === 1 ? 'y' : 'ies'}`));
    assert.ok(chartsRoot.textContent.includes(`${count} more group${noun} with nothing pending`));
    const tracks = []; const visit = node => { if (node.getAttribute?.('aria-label')?.includes('sync threshold')) tracks.push(node.getAttribute('aria-label')); for (const child of node.children ?? []) visit(child); }; visit(chartsRoot);
    assert.ok(tracks.includes(`${count} message${noun}, sync threshold 15`));
    rows = quiet; await controller.load();
    assert.ok(chartsRoot.textContent.includes(count === 1 ? '1 group has nothing pending' : 'All 2 groups have nothing pending'));
    controller.destroy();
  });
}

for (const count of [1, 2]) test(`Schedule detail renders English last ${count} runs`, async context => {
  const document = createDocument();
  const nodes = new Map(['#wb-schedule', '#tab-schedule', '#agent-detail', '#wb-detail-toggle'].map(key => [key, document.createElement('div')]));
  nodes.get('#tab-schedule').className = 'tab-panel active';
  document.querySelector = key => nodes.get(key);
  document.addEventListener = () => {}; document.removeEventListener = () => {}; document.visibilityState = 'visible';
  const window = { addEventListener() {}, removeEventListener() {} };
  context.mock.method(globalThis, 'setInterval', () => 1); context.mock.method(globalThis, 'clearInterval', () => {});
  const task = { promptTruncated: false, id: 'task-1', name: 'Report', prompt: 'Report', type: 'recurring', status: 'pending', cron: '0 8 * * *', nextRunAt: 1800003600, updatedAt: 1799990000, target: { kind: 'origin' }, nextRuns: { runs: [1800003600], in24h: [] } };
  const page = { available: true, tz: 'Asia/Singapore', tasks: [{ ...task, promptSummary: 'Report' }], counts: { pending: 1 }, kpi: {}, daily7d: { days: [] }, timelineTasks: [], nextCursor: null };
  const stop = mountSchedule({ document, window, t, locale: () => 'en', writable: () => false, now: () => 1800000000000,
    fetch: async path => ({ ok: true, json: async () => path.includes('/history') ? { rows: Array.from({ length: count }, (_, id) => ({ id, status: 'success', duration: 1000, executedAt: 1799990000 })), next: null } : path.endsWith('/task-1') ? { task } : page }) });
  context.after(stop);
  await tick();
  allNodes(nodes.get('#wb-schedule')).find(node => node.classList.contains('wb-sched-select')).dispatch('click');
  await tick();
  assert.ok(nodes.get('#wb-schedule').textContent.includes(count === 1 ? 'Last 1 run' : 'Last 2 runs'), nodes.get('#wb-schedule').textContent);
});
