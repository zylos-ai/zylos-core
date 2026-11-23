import { registerHooks } from 'node:module';
import test from 'node:test';
import { BUDGETS, WARN_THRESHOLDS, measureMemoryText } from '../../zylos-memory/scripts/memory-budget.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDocument, allNodes, deferred } from './fixtures/workbench-dom.js';
import { memoryEntriesPage } from './fixtures/memory-entries-api.js';
import { memoryBacklogPage, parseBacklogQuery } from '../src/lib/workbench/memory-backlog.js';

const browserDescriptors = new URL('../public/runtime-descriptors.js', import.meta.url).pathname;
const sourceDescriptors = new URL('../../../cli/lib/runtime/descriptors.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserDescriptors) return next(sourceDescriptors, context);
    return next(specifier, context);
  },
});
const { memoryBacklogView, memoryBacklogAge, memoryBacklogValueWidth, leaveMemoryConflict, memoryFileScope, memoryUpkeepNotice, memoryGroupLabel, memoryBudgetRows, createMemoryScope, memoryWriteMessage, saveMemoryOnce, applyMemorySave, memoryWriteAllowed, applyMemoryWriteAccess, renderMemoryPreservingEditor, captureMemorySave, memorySaveCurrent, memorySaveTargetCurrent, memorySaveOwnerCurrent, memorySaveAppliedCurrent } = await import('../public/js/wb/memory-scope.js');

// Direct product imports and injected DOM/request. Run for memory scope, charts,
// save-result interpretation or selection changes; skip unrelated collectors.
// Official runner and outer harness isolate HOME, ZYLOS_DIR, PM2_HOME, short
// TMPDIR and private TMUX_TMPDIR. No database, process or external I/O; the memory
// entries come from an in-memory stand-in for the server's list.
const t = (key, params) => key + (params ? ' ' + JSON.stringify(params) : '');
const file = (path, size_bytes = 100) => ({ path, name: path.split('/').at(-1), type: 'file', size_bytes, mtime: '2026-11-01T00:00:00.000Z', renderable: true });
// The memory directory the fake entries server answers from: files by path, with each group's badge.
function memoryFiles() {
  return [file('identity.md', 17000), file('references.md', 8000), file('state.md', 33000), file('users/profile.md'),
    file('session-groups/telegram:dm-1001/handoff.md'), file('session-groups/bad name/notes.md')];
}
/**
 * A stand-in for GET /api/memory/entries over `files`: one level of `dir` (directories first, valid session-group
 * directories as group rows), or with `q` the shallowest matches below `dir` in the view; `limit` and an opaque
 * cursor page it. `refuse()` makes the next cursor be refused, as after a Dashboard restart.
 */
function entriesServer(files, options = {}) {
  let refused = false;
  const reads = [];
  const serve = async path => {
    const url = new URL(path, 'http://dashboard');
    reads.push(path);
    if (url.searchParams.has('cursor') && refused) { refused = false; throw Object.assign(new Error('invalid_cursor'), { code: 'invalid_cursor' }); }
    return memoryEntriesPage(files, url, options);
  };
  return Object.assign(serve, { reads, refuse: () => { refused = true; } });
}
const startupBudgets = () => ({ limits: BUDGETS, warnings: WARN_THRESHOLDS, checks: { 'identity.md': measureMemoryText('identity.md', 'a'.repeat(17000)), 'references.md': measureMemoryText('references.md', 'a'.repeat(8000)) } });
const nodesOfClass = (root, className) => allNodes(root).filter(node => node.className.split(' ').includes(className));
// Each case lists every group; the page reads them through the server's own ordering, search and paging.
const backlogPage = (value, path) => memoryBacklogPage({ groups: value.groups ?? [],
  budgets: value.budgets ?? null, ...(value.originSync ? { originSync: value.originSync } : {}) },
parseBacklogQuery(new URL(path, 'http://dashboard').searchParams));
const served = (read, entries) => async path => {
  if (path.startsWith('/api/memory/entries')) return entries(path);
  const value = await read(path);
  return path.startsWith('/api/memory/backlog') ? backlogPage(value, path) : value;
};
// The backlog filter, the file search and the group picker ask the server once typing pauses.
const typed = () => new Promise(resolve => setTimeout(resolve, 350));
// Lets the entries reads the drawing started settle.
const settled = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setTimeout(resolve, 0)); };
function fixture(options = {}) {
  const document = options.document ?? createDocument(), root = document.createElement('div'), chartsRoot = document.createElement('div');
  const listRoot = options.listRoot ?? document.createElement('div');
  const files = [], changes = [];
  const entries = options.entries ?? entriesServer(options.files ?? memoryFiles(), options.server);
  const controller = createMemoryScope({ document, root, chartsRoot, listRoot, t, onFile: path => files.push(path),
    onChange: () => { changes.push(true); controller.render(); }, ...options,
    request: served(options.request ?? (async () => ({ groups: [] })), entries) });
  controller.render();
  const paths = () => allNodes(listRoot).filter(node => node.dataset?.path).map(node => node.dataset.path);
  const heads = () => [...nodesOfClass(listRoot, 'wb-memory-dir-h'), ...nodesOfClass(listRoot, 'wb-memory-group-h')];
  return { document, root, chartsRoot, listRoot, files, changes, controller, entries, paths, heads };
}

test('the file list starts folded: the root files, folders and group headings, invalid group directories marked', async () => {
  const f = fixture({ server: { badges: { 'telegram:dm-1001': { count: 12, syncing: false } } } });
  await settled();
  assert.deepEqual(f.entries.reads, ['/api/memory/entries', '/api/memory/entries?dir=session-groups'], 'only the root and the groups are read');
  assert.deepEqual(f.paths(), ['identity.md', 'references.md', 'state.md']);
  assert.deepEqual(f.heads().map(node => [node.textContent.split(' ')[0], node.attributes['aria-expanded']]),
    [['users/', 'false'], ['bad', 'false'], ['wb.platform.telegram', 'false']]);
  assert.match(nodesOfClass(f.listRoot, 'wb-memory-dir-h')[1].textContent, /wb.memory.scopeInvalid/);
  assert.match(f.root.textContent, /wb.memory.invalidGroup/);
  assert.deepEqual(nodesOfClass(f.listRoot, 'wb-memory-count').map(node => node.textContent), [t('wb.memory.pending', { count: 12 })],
    'the group shows its badge from its own row');
  assert.equal(memoryGroupLabel({ sessionGroup: 'telegram:dm-1001' }, t), 'wb.platform.telegram · dm-1001');
  assert.equal(memoryGroupLabel({ sessionGroup: 'x', displayName: '<img>' }, t), '<img>');
  assert.equal(memoryGroupLabel({ sessionGroup: 'origin' }, t), 'wb.term.origin');
  // The shared view has no groups; the groups view has no shared files.
  allNodes(f.root).find(node => node.textContent === 'wb.memory.shared').dispatch('click');
  assert.deepEqual(f.heads().length, 1); assert.doesNotMatch(f.listRoot.textContent, /wb.memory.groupsTitle/);
  allNodes(f.root).find(node => node.textContent === 'wb.memory.groups').dispatch('click');
  assert.deepEqual(f.paths(), []); assert.match(f.listRoot.textContent, /wb.memory.groupsTitle/);
  f.controller.destroy();
});

test('the group picker searches the server for groups and a group jump opens only that group', async () => {
  const f = fixture({ detail: () => 'technical' });
  await settled();
  const picker = allNodes(f.root).find(node => node.tagName === 'INPUT' && node.className.includes('wb-input'));
  const options = () => nodesOfClass(f.root, 'wb-memory-picker-item').map(node => node.textContent);
  picker.dispatch('focus'); await settled();
  assert.deepEqual(options(), [], 'tabbing onto the picker does not open its choices, so Tab moves on to the next field');
  // The filter row stays in the page while the picker's read settles and redraws it, so the field keeps focus.
  const removed = [], removeChild = f.root.removeChild.bind(f.root);
  f.root.removeChild = node => { removed.push(node); return removeChild(node); };
  picker.dispatch('click'); await settled();
  assert.ok(f.changes.length > 0 && !removed.includes(picker.parentNode.parentNode), 'the redraw keeps the filter row mounted');
  assert.deepEqual(options(), ['wb.memory.allGroups', 'wb.platform.telegram · dm-1001telegram:dm-1001']);
  assert.ok(f.entries.reads.includes('/api/memory/entries?view=groups&limit=8'), 'a few groups at a time');
  picker.value = 'no-such-group'; picker.dispatch('input'); await typed(); await settled();
  assert.deepEqual(nodesOfClass(f.root, 'wb-memory-picker-list')[0].children.slice(1).map(node => node.textContent), ['wb.noMatch'],
    'no match says no matching groups, not files');
  picker.value = 'DM-10'; picker.dispatch('input'); await typed(); await settled();
  assert.ok(f.entries.reads.includes('/api/memory/entries?view=groups&q=DM-10&limit=8'));
  nodesOfClass(f.root, 'wb-memory-picker-item')[1].dispatch('click'); await settled();
  assert.deepEqual(f.paths(), ['session-groups/telegram:dm-1001/handoff.md'], 'the chosen group opens on its own');
  assert.equal(f.heads()[0].attributes['aria-expanded'], 'true');
  assert.equal(f.files.length, 0, 'no file is opened');
  // "All groups" lists every group again, folded.
  picker.dispatch('click'); await settled();
  nodesOfClass(f.root, 'wb-memory-picker-item')[0].dispatch('click');
  assert.deepEqual(f.heads().map(node => node.textContent.split(' ')[0]), ['bad', 'wb.platform.telegram']);
  // A group with no memory directory is looked up by name and reported.
  f.controller.selectGroup('openmax:missing'); await settled();
  assert.match(f.root.textContent, /wb.memory.noGroupFiles/);
  assert.ok(f.entries.reads.includes('/api/memory/entries?view=groups&q=openmax%3Amissing&limit=100'));
  f.controller.destroy();
  // Without C4 the groups list is unavailable (503): the picker says so instead of reporting no match.
  const down = fixture({ entries: Object.assign(async path => {
    if (path.includes('view=groups')) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
    return f.entries(path);
  }, { reads: [] }) });
  await settled();
  allNodes(down.root).find(node => node.tagName === 'INPUT' && node.className.includes('wb-input')).dispatch('click'); await settled();
  assert.deepEqual(nodesOfClass(down.root, 'wb-memory-picker-list')[0].children.slice(1).map(node => node.textContent), ['memory.error_generic']);
  down.controller.destroy();
});

test('budget rows use Core supplied thresholds and give state size without a budget', () => {
  const rows = memoryBudgetRows(memoryFiles(), startupBudgets());
  assert.ok(rows[0].over > 0); assert.equal(rows[1].warned, true);
  assert.equal(rows[2].limit, null); assert.equal(rows[2].warning, null); assert.equal(rows[2].size, 33000);
  assert.equal(memoryBudgetRows(memoryFiles(), null)[0].limit, null);
  assert.deepEqual(memoryBudgetRows(null, startupBudgets()), [], 'nothing before the root is read');
});

test('technical charts show each threshold, unknown readings, age, Core budgets and clickable destinations safely', async () => {
  const f = fixture({ detail: () => 'technical', request: async () => ({
    groups: [
      { sessionGroup: 'telegram:dm-1001', count: 20, threshold: 15, syncing: true, aged: true },
      { sessionGroup: 'openmax:other', count: 3, threshold: 50, syncing: null },
      { sessionGroup: 'other', count: null, threshold: null, syncing: false, reason: '<script>' },
    ], budgets: startupBudgets(),
  }) });
  await f.controller.load(); await settled();
  assert.equal(f.chartsRoot.hidden, false);
  assert.match(f.chartsRoot.textContent, /wb.memory.aged/); assert.match(f.chartsRoot.textContent, /wb.memory.syncing/);
  assert.match(f.chartsRoot.textContent, /wb.memory.syncUnknown/); assert.match(f.chartsRoot.textContent, /wb.unknown/);
  assert.match(f.chartsRoot.textContent, /wb.memory.startupOver/); assert.match(f.chartsRoot.textContent, /wb.memory.warning/);
  assert.equal(nodesOfClass(f.chartsRoot, 'wb-memory-threshold').length, 4);
  assert.equal(nodesOfClass(f.chartsRoot, 'excess').length, 1);
  assert.equal(allNodes(f.chartsRoot).some(node => node.tagName === 'SCRIPT'), false);
  const buttons = allNodes(f.chartsRoot).filter(node => node.tagName === 'BUTTON');
  buttons[0].dispatch('click'); await settled();
  assert.deepEqual(f.paths(), ['session-groups/telegram:dm-1001/handoff.md'], 'the group name opens the group');
  buttons.find(node => node.textContent === 'state.md').dispatch('click'); assert.equal(f.files.at(-1), 'state.md');
  f.controller.destroy();
});

test('backlog rows: waiting groups first, then by pending count; groups with nothing pending are not listed', () => {
  const page = backlogPage({ groups: [
    { sessionGroup: 'few', count: 3, syncing: false, threshold: 15 },
    { sessionGroup: 'unknown', count: null, syncing: null, threshold: 15 },
    { sessionGroup: 'old-small', count: 2, aged: true, firstAt: '2026-11-01 00:00:00', syncing: false, threshold: 15 },
    { sessionGroup: 'many', count: 40, syncing: false, threshold: 15 },
    { sessionGroup: 'old-big', count: 9, aged: true, firstAt: '2026-11-02 00:00:00', syncing: false, threshold: 15 },
    { sessionGroup: 'zero-syncing', count: 0, syncing: true, threshold: 15 },
    { sessionGroup: 'origin', count: 1, syncing: false, threshold: 30 },
  ] }, '/api/memory/backlog');
  const view = memoryBacklogView(page.items, page.summary.threshold);
  assert.deepEqual(view.rows.map(row => row.sessionGroup), ['old-big', 'old-small', 'many', 'few', 'origin', 'zero-syncing', 'unknown']);
  assert.equal(view.threshold, 15, 'the header names the threshold most groups share');
  assert.equal(view.rows[4].ownThreshold, 30, 'a group with another threshold keeps it on its row');
  assert.equal(view.rows[0].ownThreshold, null);
  assert.equal(memoryBacklogView(null).threshold, null);
});

test('backlog age reads C4 UTC text in whole hours, then days from 48 hours', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  assert.deepEqual(memoryBacklogAge('2026-11-09 02:30:00', now), { unit: 'hours', count: 9 });
  assert.deepEqual(memoryBacklogAge('2026-11-07T12:00:01Z', now), { unit: 'hours', count: 47 });
  assert.deepEqual(memoryBacklogAge('2026-11-06 12:00:00', now), { unit: 'days', count: 3 });
  assert.equal(memoryBacklogAge(null, now), null); assert.equal(memoryBacklogAge('later', now), null);
  assert.equal(memoryBacklogAge('2026-11-10 00:00:00', now), null, 'a time ahead of the clock gives no age');
});

test('backlog card: threshold in the header, age as a mark on its row, no line for groups with nothing pending, a filter past twelve groups', async () => {
  const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();
  const groups = [{ sessionGroup: 'telegram:dm-1', displayName: 'Waiting long', count: 20, threshold: 15, syncing: false, aged: true, firstAt: hoursAgo(9.5) }];
  for (let i = 0; i < 12; i++) groups.push({ sessionGroup: `telegram:dm-q${i}`, displayName: `Few ${i}`, count: 1, threshold: 15, syncing: false });
  const f = fixture({ detail: () => 'technical', request: async () => ({ groups }) });
  await f.controller.load();
  const card = nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0];
  assert.match(card.textContent, /wb.memory.thresholdHint \{"count":15\}/);
  const rows = () => nodesOfClass(card, 'wb-memory-bl');
  const first = rows()[0];
  assert.equal(nodesOfClass(first, 'wb-memory-chart-label')[0].textContent, 'Waiting long');
  const mark = nodesOfClass(first, 'wb-memory-bl-tag')[0];
  assert.equal(mark.textContent, 'wb.memory.agedHours {"count":9}'); assert.match(mark.className, /\bwarn\b/);
  assert.equal(nodesOfClass(nodesOfClass(first, 'wb-memory-bl-head')[0], 'wb-memory-bl-tag').includes(mark), true, 'the mark sits with the name, not on a line of its own');
  const over = nodesOfClass(first, 'wb-memory-bl-tag')[1];
  assert.equal(over?.textContent, 'wb.memory.overThreshold', 'over the threshold is also said in words'); assert.match(over.className, /\bwarn\b/);
  assert.equal(rows().length, 13, 'every listed group is a row');
  assert.equal(allNodes(card).some(node => node.tagName === 'DETAILS'), false, 'nothing is folded away');
  const originalFilter = allNodes(card).find(node => node.tagName === 'INPUT');
  f.controller.render();
  const mountedCard = nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0];
  const filter = allNodes(mountedCard).find(node => node.tagName === 'INPUT');
  assert.ok(filter, 'thirteen groups get a filter');
  assert.equal(filter, originalFilter, 'refresh keeps the live filter input mounted');
  filter.value = 'few 1'; filter.dispatch('input'); await typed();
  const card2 = nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0];
  assert.deepEqual(nodesOfClass(card2, 'wb-memory-chart-label').map(node => node.textContent), ['Few 1', 'Few 10', 'Few 11'], 'a search lists the matching groups');
  filter.value = 'nothing'; filter.dispatch('input'); await typed();
  assert.match(nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0].textContent, /wb.memory.noMatch/);
  f.controller.destroy();
});

test('the backlog count column gets one shared width when a count is shown in words', async () => {
  assert.equal(memoryBacklogValueWidth([{ count: 3 }, { count: 0 }], 'Unknown'), '', 'numbers only: the column sizes itself');
  assert.equal(memoryBacklogValueWidth([{ count: 3 }, { count: null }], 'Unknown'), '8ch');
  assert.equal(memoryBacklogValueWidth([{ count: null }], '未知'), '5ch', 'a wide character counts twice');
  assert.equal(memoryBacklogValueWidth(null, 'Unknown'), '');
  const f = fixture({ detail: () => 'technical', request: async () => ({ groups: [
    { sessionGroup: 'telegram:dm-1', count: 4, threshold: 15, syncing: false },
    { sessionGroup: 'telegram:dm-2', count: null, threshold: 15, syncing: false },
  ] }) });
  await f.controller.load();
  const rows = nodesOfClass(nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0], 'wb-memory-rows')[0];
  assert.equal(rows.style['--wb-bl-value'], `${[...'wb.unknown'].length + 1}ch`, 'the rows share the width of the unknown label');
  f.controller.destroy();
});

test('the cross-group Origin row leads the backlog with its own count, threshold, unread summaries and lock', async () => {
  const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();
  const groups = [
    { sessionGroup: 'origin', count: 3, threshold: 15, syncing: true },
    { sessionGroup: 'telegram:dm-1', count: 0, threshold: 15, syncing: false },
  ];
  const originSync = { count: 60, pendingSummaries: 2, firstAt: hoursAgo(8.5), aged: true, syncing: false, threshold: 50 };
  const f = fixture({ detail: () => 'technical', request: async () => ({ groups, originSync }) });
  await f.controller.load();
  const card = nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0];
  assert.match(card.textContent, /wb.memory.thresholdHintOrigin \{"count":15,"origin":50\}/,
    'each row has its own scale, so the subtitle names the group threshold and the gathering threshold');
  const rows = nodesOfClass(card, 'wb-memory-bl');
  const [cross, own] = rows;
  assert.match(cross.className, /\bwb-memory-bl-cross\b/);
  assert.equal(nodesOfClass(cross, 'wb-memory-chart-label')[0].textContent, 'wb.memory.originSync');
  assert.equal(allNodes(cross).some(node => node.tagName === 'BUTTON'), false, 'the cross-group row is not a group to open');
  assert.match(nodesOfClass(cross, 'wb-memory-chart-label')[0].className, /\bwb-memory-chart-label-static\b/, 'its name does not look like a link');
  assert.equal(nodesOfClass(cross, 'wb-memory-chart-label')[0].title, 'wb.memory.originSyncHint {"count":50}', 'the hover text carries the row\'s actual threshold');
  assert.equal(nodesOfClass(cross, 'wb-memory-chart-value')[0].textContent, '60');
  const tags = nodesOfClass(cross, 'wb-memory-bl-tag').map(node => node.textContent);
  assert.deepEqual(tags, ['wb.memory.agedHours {"count":8}', 'wb.memory.overThreshold', 'wb.memory.pendingSummaries {"count":2}',
    'wb.memory.originThreshold {"count":50}']);
  const line = nodesOfClass(cross, 'wb-memory-threshold')[0];
  assert.equal(line.title, 'wb.memory.originThreshold {"count":50}', 'the dashed line is named like the tag beside it');
  assert.equal(line.style.left, `${100 * 50 / 62.5}%`, 'the threshold line sits at 50 on the cross-group scale');
  assert.equal(nodesOfClass(own, 'wb-memory-chart-label')[0].textContent, 'wb.term.origin');
  assert.equal(nodesOfClass(own, 'wb-memory-chart-value')[0].textContent, '3');
  assert.equal(nodesOfClass(own, 'wb-memory-threshold')[0].title, 'wb.memory.threshold {"count":15}');
  assert.equal(nodesOfClass(own, 'wb-memory-chart-label-static').length, 0, 'a group name stays a link');
  assert.deepEqual(nodesOfClass(own, 'wb-memory-bl-tag').map(node => node.textContent), ['wb.memory.syncing'],
    'Origin\'s own lock marks only its own row, under the group threshold');
  f.controller.destroy();
  const swapped = fixture({ detail: () => 'technical', request: async () => ({
    groups: [{ sessionGroup: 'origin', count: 3, threshold: 15, syncing: false }],
    originSync: { ...originSync, aged: false, syncing: true } }) });
  await swapped.controller.load();
  const [crossRow, ownRow] = nodesOfClass(swapped.chartsRoot, 'wb-memory-bl');
  assert.equal(nodesOfClass(crossRow, 'wb-memory-bl-tag').some(node => node.textContent === 'wb.memory.originSyncing'), true);
  assert.equal(nodesOfClass(ownRow, 'wb-memory-bl-tag').some(node => /syncing/i.test(node.textContent)), false);
  swapped.controller.destroy();
});

test('an unreadable cross-group backlog shows unknown on its row only, and single mode has no such row', async () => {
  const f = fixture({ detail: () => 'technical', request: async () => ({
    groups: [{ sessionGroup: 'telegram:dm-1', count: 20, threshold: 15, syncing: false }],
    originSync: { count: null, pendingSummaries: null, firstAt: null, aged: false, syncing: null, threshold: 50, reason: 'origin_backlog_failed' } }) });
  await f.controller.load();
  const [cross, group] = nodesOfClass(f.chartsRoot, 'wb-memory-bl');
  assert.equal(nodesOfClass(cross, 'wb-memory-chart-value')[0].textContent, 'wb.unknown');
  assert.equal(nodesOfClass(cross, 'wb-memory-bl-tag').some(node => node.textContent === 'wb.memory.originSyncUnknown'), true);
  assert.equal(nodesOfClass(group, 'wb-memory-chart-value')[0].textContent, '20');
  assert.deepEqual(nodesOfClass(group, 'wb-memory-bl-tag').map(node => node.textContent), ['wb.memory.overThreshold']);
  f.controller.destroy();
  const single = fixture({ detail: () => 'technical', request: async () => ({
    groups: [{ sessionGroup: 'telegram:dm-1', count: 2, threshold: 15, syncing: false }] }) });
  await single.controller.load();
  assert.equal(nodesOfClass(single.chartsRoot, 'wb-memory-bl-cross').length, 0);
  const singleCard = nodesOfClass(single.chartsRoot, 'wb-memory-progress')[0].textContent;
  assert.match(singleCard, /wb.memory.thresholdHint \{"count":15\}/, 'without the cross-group row the subtitle is unchanged');
  assert.doesNotMatch(singleCard, /thresholdHintOrigin|backlogHintOrigin/);
  single.controller.destroy();
});

test('the cross-group row name explains itself in plain words with its actual threshold', async () => {
  const label = async threshold => {
    const f = fixture({ detail: () => 'technical', request: async () => ({ groups: [],
      originSync: { count: 4, pendingSummaries: 0, firstAt: null, aged: false, syncing: false, threshold } }) });
    await f.controller.load();
    const title = nodesOfClass(f.chartsRoot, 'wb-memory-chart-label')[0].title;
    f.controller.destroy();
    return title;
  };
  assert.equal(await label(73), 'wb.memory.originSyncHint {"count":73}', 'the hover text carries the row\'s actual threshold');
  assert.equal(await label(null), 'wb.memory.originSyncHintNoThreshold', 'without a readable threshold the count clause is left out');
  for (const lang of ['zh', 'en']) {
    const pack = JSON.parse(await readFile(new URL(`../public/i18n/wb.${lang}.json`, import.meta.url), 'utf8'));
    assert.match(pack['wb.memory.originSyncHint'], /\{count\}/, lang);
    assert.doesNotMatch(pack['wb.memory.originSyncHintNoThreshold'], /\{count\}/, lang);
    for (const key of ['wb.memory.originSyncHint', 'wb.memory.originSyncHintNoThreshold']) {
      assert.doesNotMatch(pack[key], /Supervisor|lock|锁/i, `${lang} ${key} uses no internal names`);
    }
  }
});

test('the ordinary summary reports a late or running cross-group sync', async () => {
  const document = createDocument(), summaryRoot = document.createElement('div');
  const f = fixture({ document, summaryRoot, detail: () => 'plain', request: async () => ({
    groups: [{ sessionGroup: 'telegram:dm-1', count: 0, threshold: 15, syncing: false }],
    originSync: { count: 60, pendingSummaries: 0, firstAt: null, aged: true, syncing: true, threshold: 50 } }) });
  await f.controller.load();
  assert.match(summaryRoot.className, /\bwb-warn\b/);
  assert.match(summaryRoot.textContent, /wb.memory.summaryOriginLate/);
  assert.match(summaryRoot.textContent, /wb.memory.summaryOriginSyncing/);
  f.controller.destroy();
});

test('the ordinary summary is unknown when only the cross-group backlog cannot be read', async () => {
  const summaryWith = async originSync => {
    const document = createDocument(), summaryRoot = document.createElement('div');
    const f = fixture({ document, summaryRoot, detail: () => 'plain', request: async () => ({
      groups: [{ sessionGroup: 'telegram:dm-1', count: 2, threshold: 15, syncing: false, aged: false }], originSync }) });
    await f.controller.load();
    const text = summaryRoot.textContent;
    f.controller.destroy();
    return text;
  };
  const known = { count: 4, pendingSummaries: 0, firstAt: null, aged: false, syncing: false, threshold: 50 };
  assert.match(await summaryWith(known), /wb.memory.summaryOk/, 'every row known and in order reads as fine');
  for (const unreadable of [
    { count: null, pendingSummaries: null, firstAt: null, aged: false, syncing: null, threshold: 50, reason: 'origin_backlog_failed' },
    { ...known, count: null },
    { ...known, syncing: null }
  ]) {
    const text = await summaryWith(unreadable);
    assert.match(text, /wb.memory.summaryUnknown/, JSON.stringify(unreadable));
    assert.doesNotMatch(text, /wb.memory.summaryOk/, JSON.stringify(unreadable));
  }
});

test('a backlog search keeps the cross-group row only when its name matches', async () => {
  const groups = Array.from({ length: 12 }, (_, i) => ({ sessionGroup: `telegram:dm-q${i}`, displayName: `Quiet ${i}`, count: 0, threshold: 15, syncing: false }));
  const originSync = { count: 60, pendingSummaries: 2, firstAt: null, aged: false, syncing: false, threshold: 50 };
  const f = fixture({ detail: () => 'technical', request: async () => ({ groups, originSync }) });
  await f.controller.load();
  const search = async value => {
    const filter = allNodes(nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0]).find(node => node.tagName === 'INPUT');
    filter.value = value; filter.dispatch('input'); await typed();
    const card = nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0];
    return { cross: nodesOfClass(card, 'wb-memory-bl-cross').length, rows: nodesOfClass(card, 'wb-memory-bl').length,
      noMatch: /wb\.memory\.noMatch/.test(card.textContent) };
  };
  // The test translator returns keys, so the row's name reads `wb.memory.originSync`.
  assert.deepEqual(await search('ORIGINSYNC'), { cross: 1, rows: 1, noMatch: false }, 'a matching search keeps the row and is not "no match"');
  assert.deepEqual(await search('quiet 1'), { cross: 0, rows: 3, noMatch: false }, 'a group search hides the cross-group row');
  assert.deepEqual(await search('nothing'), { cross: 0, rows: 0, noMatch: true }, 'with neither matching, "no match" still shows');
  assert.deepEqual(await search(''), { cross: 1, rows: 13, noMatch: false }, 'clearing the search brings the row back');
  f.controller.destroy();
});

test('the backlog filter appears from twelve groups', async () => {
  const filterWith = async count => {
    const groups = Array.from({ length: count }, (_, i) => ({ sessionGroup: `telegram:dm-${i}`, count: i, threshold: 15, syncing: false }));
    const f = fixture({ detail: () => 'technical', request: async () => ({ groups }) });
    await f.controller.load();
    const found = allNodes(nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0]).some(node => node.tagName === 'INPUT');
    f.controller.destroy();
    return found;
  };
  assert.equal(await filterWith(11), false, 'eleven groups: no filter');
  assert.equal(await filterWith(12), true, 'twelve groups: a filter');
});

test('only a count past the threshold is labelled over it', async () => {
  const f = fixture({ detail: () => 'technical', request: async () => ({ groups: [
    { sessionGroup: 'telegram:dm-at', count: 15, threshold: 15, syncing: false },
    { sessionGroup: 'telegram:dm-past', count: 16, threshold: 15, syncing: false },
  ] }) });
  await f.controller.load();
  const rows = nodesOfClass(nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0], 'wb-memory-bl');
  const said = row => nodesOfClass(row, 'wb-memory-bl-tag').map(node => node.textContent);
  assert.deepEqual(said(rows[0]), ['wb.memory.overThreshold']);
  assert.deepEqual(said(rows[1]), [], 'a count equal to the threshold is not over it');
  f.controller.destroy();
});

test('the header threshold is the one most groups share, not the first or the smallest', () => {
  const view = thresholds => backlogPage({ groups: thresholds.map((threshold, i) => ({ sessionGroup: `g${i}`, count: 1, threshold, syncing: false })) }, '/api/memory/backlog').summary.threshold;
  assert.equal(view([30, 15, 15]), 15);
  assert.equal(view([10, 15, 15]), 15);
  assert.equal(view([15, 30]), 15, 'a tie goes to the smaller threshold');
});

test('a short backlog list has no filter, and an empty list says no group has anything waiting', async () => {
  const f = fixture({ detail: () => 'technical', request: async () => ({ groups: [
    { sessionGroup: 'telegram:dm-1', count: 2, threshold: 15, syncing: false },
    { sessionGroup: 'telegram:dm-2', count: 1, threshold: 15, syncing: false },
  ] }) });
  await f.controller.load();
  const card = nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0];
  assert.equal(allNodes(card).some(node => node.tagName === 'INPUT'), false);
  assert.equal(nodesOfClass(card, 'wb-memory-bl').length, 2);
  f.controller.destroy();
  const empty = fixture({ detail: () => 'technical', request: async () => ({ groups: [] }) });
  await empty.controller.load();
  const rows = nodesOfClass(nodesOfClass(empty.chartsRoot, 'wb-memory-progress')[0], 'wb-memory-rows')[0];
  assert.deepEqual(rows.children.map(node => [node.className, node.textContent]), [['wb-memory-source', t('wb.memory.noBacklogGroups')]],
    'one line and no count, instead of a blank card');
  empty.controller.destroy();
});

test('ordinary view hides progress and budgets and unavailable budgets draw no threshold lines', async () => {
  const f = fixture({ detail: () => 'plain' }); await f.controller.load();
  assert.equal(f.chartsRoot.hidden, true); assert.equal(f.chartsRoot.children.length, 0); f.controller.destroy();
  const technical = fixture({ detail: () => 'technical', request: async () => ({ groups: [{ sessionGroup: 'origin', count: 4, threshold: null }], budgets: null }) });
  await technical.controller.load(); assert.equal(nodesOfClass(technical.chartsRoot, 'wb-memory-threshold').length, 0); technical.controller.destroy();
});

test('stale backlog requests cannot populate a different instance or a destroyed view', async () => {
  let owner = 'a'; const pending = deferred();
  const f = fixture({ identity: () => owner, detail: () => 'technical', request: () => pending.promise });
  const loading = f.controller.load(); owner = 'b'; pending.resolve({ groups: [{ sessionGroup: 'SECRET', count: 4 }] }); await loading;
  f.controller.render(); assert.doesNotMatch(f.chartsRoot.textContent, /SECRET/); f.controller.destroy();
  const next = deferred(), g = fixture({ request: () => next.promise });
  const stopped = g.controller.load(); g.controller.destroy(); next.resolve({ groups: [] }); await stopped;
  assert.equal(g.root.children.length, 0);
  // The same for the file list: instance a's root read answers, and its groups read fails, only after switching to b.
  let viewed = 'a'; const held = deferred(), heldGroups = deferred(), bServer = entriesServer(memoryFiles());
  const entries = Object.assign(path => viewed !== 'a' ? bServer(path) : path.includes('dir=session-groups') ? heldGroups.promise : held.promise,
    { reads: bServer.reads, refuse: bServer.refuse });
  const h = fixture({ identity: () => viewed, entries });
  await settled();
  viewed = 'b'; h.controller.render(); await settled();
  held.resolve(memoryEntriesPage([file('A-ONLY.md')], new URL('/api/memory/entries', 'http://dashboard')));
  heldGroups.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' })); await settled();
  h.controller.render();
  assert.deepEqual(h.paths(), ['identity.md', 'references.md', 'state.md'], "only b's rows");
  assert.equal(h.heads().length, 3, "b's folders and group are kept");
  assert.doesNotMatch(h.listRoot.textContent, /memory.error_generic/, "a's failed read shows no error on b");
  h.controller.destroy();
});

test('unknown save result reads disk once and compares returned text without resubmitting', async () => {
  const text = '草稿\n', sha = 'saved-sha'; let writes = 0, reads = 0;
  const result = await saveMemoryOnce({ path: 'state.md', text, sha256: 'old',
    request: async () => { writes++; throw { code: 'memory_write_unknown' }; },
    readFile: async () => { reads++; return { path: 'state.md', text, sha256: sha }; } });
  assert.equal(result.sha256, sha); assert.equal(writes, 1); assert.equal(reads, 1);
  await assert.rejects(saveMemoryOnce({ path: 'state.md', text, sha256: 'old',
    request: async () => { writes++; throw { code: 'memory_write_unknown' }; }, readFile: async () => { reads++; return { path: 'state.md', text: 'old', sha256: 'different' }; } }), error => error.code === 'memory_write_unknown');
  assert.equal(writes, 2); assert.equal(reads, 2);
});

test('empty memory save keeps the draft and rejects before any request or readback', async () => {
  const state = { draft: '', file: { text: 'original', sha256: 'old' } };
  let writes = 0, reads = 0;
  await assert.rejects(saveMemoryOnce({ path: 'state.md', text: state.draft, sha256: state.file.sha256,
    request: async () => { writes++; }, readFile: async () => { reads++; } }), error => error.code === 'memory_write_empty');
  assert.equal(writes, 0); assert.equal(reads, 0);
  assert.equal(state.draft, ''); assert.equal(state.file.text, 'original');
  const messages = { zh: '不能保存为空文件，草稿已保留。', en: "A memory file can't be saved empty. Your draft is kept." };
  for (const [locale, message] of Object.entries(messages)) {
    const pack = JSON.parse(await readFile(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url), 'utf8'));
    assert.equal(memoryWriteMessage('memory_write_empty', key => pack[key]), message);
  }
  assert.equal(memoryWriteMessage('invalid_memory_write', t), null);
});

test('whitespace memory saves are submitted unchanged and server empty rejection uses the same code', async () => {
  let writes = 0, reads = 0;
  const text = ' \n';
  await saveMemoryOnce({ path: 'state.md', text, sha256: 'old', request: async (url, options) => {
    writes++; assert.equal(JSON.parse(options.body).text, text); return { text };
  } });
  const error = { code: 'memory_write_empty' };
  await assert.rejects(saveMemoryOnce({ path: 'state.md', text: 'draft', sha256: 'old',
    request: async () => { writes++; throw error; }, readFile: async () => { reads++; } }), value => value === error);
  assert.equal(writes, 2); assert.equal(reads, 0);
  assert.equal(memoryWriteMessage(error.code, t), 'wb.memory.writeEmpty');
});

test('sync busy preserves the write rejection without a readback and has a specific message', async () => {
  const error = { code: 'memory_sync_busy' }; let reads = 0;
  await assert.rejects(saveMemoryOnce({ path: 'x', text: 'draft', sha256: 'old', request: async () => { throw error; }, readFile: async () => { reads++; } }), value => value === error);
  assert.equal(reads, 0); assert.equal(memoryWriteMessage(error.code, t), 'wb.memory.syncBusy');
  assert.equal(memoryWriteMessage('other', t), null);
});

test('save completion is fenced when the instance or selected file changes', async () => {
  const state = { selectedPath: 'state.md', file: {}, draft: 'draft' }, captured = captureMemorySave(state);
  assert.equal(memorySaveCurrent(captured, state), true);
  assert.equal(memorySaveCurrent(captured, { ...state }), false);
  state.file = {}; assert.equal(memorySaveCurrent(captured, state), false);
  assert.equal(memorySaveTargetCurrent(captured, state), true);
  state.selectedPath = 'identity.md'; assert.equal(memorySaveTargetCurrent(captured, state), false);
  const request = deferred(); let reads = 0, current = true;
  const saving = saveMemoryOnce({ path: 'state.md', text: 'draft', sha256: 'old', request: () => request.promise,
    readFile: async () => { reads++; }, isCurrent: () => current });
  current = false; request.reject({ code: 'memory_write_unknown' });
  assert.equal(await saving, null); assert.equal(reads, 0);
});

test('a redraw after the detail level changes shows or hides the memory charts without reading again', async () => {
  let reads = 0;
  const f = fixture({ request: async path => { if (path.startsWith('/api/memory/backlog')) reads++; return { groups: [] }; } });
  await f.controller.load(); assert.equal(f.chartsRoot.hidden, true);
  f.document.documentElement.dataset.detail = 'technical'; f.controller.render();
  assert.equal(f.chartsRoot.hidden, false); assert.equal(reads, 1);
  f.document.documentElement.dataset.detail = 'plain'; f.controller.render();
  assert.equal(f.chartsRoot.hidden, true); assert.equal(reads, 1);
  f.controller.destroy();
});

test('group navigation after an instance change keeps the requested group selection', async () => {
  let owner = 'a'; const f = fixture({ identity: () => owner });
  await settled();
  owner = 'b'; f.controller.selectGroup('telegram:dm-1001'); await settled();
  assert.deepEqual(f.paths(), ['session-groups/telegram:dm-1001/handoff.md']);
  f.controller.destroy();
});

test('a pending save excludes overlapping captures and releases its owner after selecting another file', async () => {
  const state = { selectedPath: 'state.md', file: {}, draft: 'draft', saving: false }, captured = captureMemorySave(state);
  state.saving = true;
  assert.equal(captureMemorySave(state), null);
  const request = deferred();
  const saving = saveMemoryOnce({ path: 'state.md', text: 'draft', sha256: 'old', request: () => request.promise,
    isCurrent: () => memorySaveCurrent(captured, state) });
  state.selectedPath = 'identity.md'; state.file = {};
  request.resolve({ path: 'state.md', text: 'draft', sha256: 'saved' });
  assert.equal(await saving, null);
  assert.equal(memorySaveOwnerCurrent(captured, state), true);
  state.saving = false;
  assert.ok(captureMemorySave(state));
  assert.equal(memorySaveOwnerCurrent(captured, { ...state }), false);
});

test('a conflict readback cannot update a selection that changed while it was loading', async () => {
  const state = { selectedPath: 'state.md', file: {}, draft: 'draft' }, captured = captureMemorySave(state);
  const latest = deferred();
  assert.equal(memorySaveCurrent(captured, state), true);
  state.selectedPath = 'identity.md'; state.file = {};
  latest.resolve({ path: 'state.md', text: 'newer' }); await latest.promise;
  assert.equal(memorySaveCurrent(captured, state), false);
});

test('post-save history readback requires the same applied file while allowing newer typing', async () => {
  const state = { selectedPath: 'state.md', file: {}, draft: 'draft' }, captured = captureMemorySave(state);
  const saved = { path: 'state.md', text: 'saved', sha256: 'new' };
  state.file = saved; state.draft = saved.text;
  const git = deferred();
  assert.equal(memorySaveAppliedCurrent(captured, state, saved), true);
  state.draft = 'new edit'; git.resolve({ commit: null }); await git.promise;
  assert.equal(memorySaveAppliedCurrent(captured, state, saved), true);
  state.draft = saved.text; state.file = { ...saved };
  assert.equal(memorySaveAppliedCurrent(captured, state, saved), false);
  state.file = saved; state.selectedPath = 'identity.md';
  assert.equal(memorySaveAppliedCurrent(captured, state, saved), false);
});

test('the references warning follows Core on both sides of its token threshold', () => {
  const value = memoryFiles();
  const edge = Math.ceil(WARN_THRESHOLDS['references.md'].estimatedTokens);
  for (const tokens of [edge - 1, edge, edge + 1]) {
    const check = measureMemoryText('references.md', 'a'.repeat(tokens * 4));
    const row = memoryBudgetRows(value, { limits: BUDGETS, warnings: WARN_THRESHOLDS, checks: { 'references.md': check } }).find(row => row.path === 'references.md');
    assert.equal(row.warned, tokens >= edge); assert.equal(row.over, 0);
  }
});

test('successful save updates the file sha while retaining typing that arrived during the request', async () => {
  const state = { selectedPath: 'state.md', file: { path: 'state.md', text: 'old', sha256: 'old-sha' }, draft: 'submitted', editing: true, dirty: true };
  const captured = captureMemorySave(state), pending = deferred(), requests = [];
  const saving = saveMemoryOnce({ path: 'state.md', text: state.draft, sha256: state.file.sha256,
    request: async (path, options) => { requests.push(JSON.parse(options.body)); return pending.promise; },
    isCurrent: () => memorySaveCurrent(captured, state) });
  state.draft = 'submitted plus newer typing';
  const saved = { path: 'state.md', text: 'submitted', sha256: 'new-sha' };
  pending.resolve(saved);
  assert.equal(applyMemorySave(captured, state, await saving), true);
  assert.equal(state.file, saved); assert.equal(state.draft, 'submitted plus newer typing');
  assert.equal(state.editing, true); assert.equal(state.dirty, true);
  await saveMemoryOnce({ path: 'state.md', text: state.draft, sha256: state.file.sha256,
    request: async (path, options) => { requests.push(JSON.parse(options.body)); return { path: 'state.md', text: state.draft, sha256: 'next-sha' }; } });
  assert.equal(requests[1].sha256, 'new-sha');
  assert.equal(requests[1].text, 'submitted plus newer typing');
});

test('success without newer typing finishes editing and clears dirty state', () => {
  const state = { selectedPath: 'state.md', file: {}, draft: 'submitted', editing: true, dirty: true }, captured = captureMemorySave(state);
  const saved = { path: 'state.md', text: 'submitted', sha256: 'new-sha' };
  assert.equal(applyMemorySave(captured, state, saved), true);
  assert.equal(state.file, saved); assert.equal(state.draft, 'submitted'); assert.equal(state.dirty, false); assert.equal(state.editing, false);
});

test('same-file save failures remain visible when the user types during the request', async () => {
  for (const code of ['memory_sync_busy', 'memory_lock_timeout', 'memory_write_unknown']) {
    const state = { selectedPath: 'state.md', file: {}, draft: 'submitted' }, captured = captureMemorySave(state), pending = deferred();
    let writes = 0, reads = 0;
    const saving = saveMemoryOnce({ path: 'state.md', text: state.draft, sha256: 'old',
      request: async () => { writes++; return pending.promise; }, readFile: async () => { reads++; return { path: 'state.md', text: 'still old' }; },
      isCurrent: () => memorySaveCurrent(captured, state) });
    state.draft = 'newer draft'; pending.reject({ code });
    await assert.rejects(saving, error => error.code === code);
    assert.equal(memorySaveCurrent(captured, state), true);
    assert.ok(memoryWriteMessage(code, t)); assert.equal(state.draft, 'newer draft');
    assert.equal(writes, 1); assert.equal(reads, code === 'memory_write_unknown' ? 1 : 0);
  }
});

test('unknown save readback requires the submitted path as well as exact Unicode text', async () => {
  await assert.rejects(saveMemoryOnce({ path: 'state.md', text: '草稿\n', sha256: 'old',
    request: async () => { throw { code: 'memory_write_unknown' }; },
    readFile: async () => ({ path: 'other.md', text: '草稿\n' }) }), error => error.code === 'memory_write_unknown');
});

test('backlog chart names come from the active snapshot even for groups without memory directories', async () => {
  const f = fixture({ detail: () => 'technical', request: async () => ({ groups: [
    { sessionGroup: 'openmax:no-memory', displayName: 'Named <group>', count: 3, threshold: 15 },
    { sessionGroup: 'unknown-namespace:chat', displayName: null, c4: { componentName: 'telegram' }, count: 1, threshold: 15 },
  ] }) });
  await f.controller.load();
  const labels = nodesOfClass(f.chartsRoot, 'wb-memory-chart-label').map(node => node.textContent);
  assert.equal(labels[0], 'Named <group>'); assert.equal(labels[1], 'wb.platform.telegram · chat');
  assert.equal(allNodes(f.chartsRoot).some(node => node.tagName === 'GROUP'), false);
  f.controller.destroy();
});

test('invalid group directories and files directly under session-groups explain their read-only status', async () => {
  const document = createDocument(), edit = document.createElement('button'), save = document.createElement('button');
  let selected = 'session-groups/bad name/notes.md';
  const f = fixture({ document, getFile: () => ({ path: selected }), files: [...memoryFiles(), file('session-groups/direct.md')] });
  await settled();
  const known = f.controller.known();
  assert.equal(memoryWriteAllowed(known, 'session-groups/bad name/notes.md'), false);
  assert.equal(memoryWriteAllowed(known, 'session-groups/direct.md'), false);
  assert.equal(memoryWriteAllowed(known, 'session-groups/telegram:dm-1001/handoff.md'), true);
  assert.equal(memoryWriteAllowed(known, 'identity.md'), true);
  assert.equal(memoryWriteAllowed(known, 'session-groups/telegram:not-loaded/state.md'), false, 'a group not loaded yet stays read-only');
  f.controller.render();
  applyMemoryWriteAccess(edit, save, known, selected);
  assert.equal(edit.hidden, true); assert.equal(edit.disabled, true); assert.equal(save.disabled, true);
  assert.match(f.root.textContent, /wb.memory.invalidGroupFile/);
  selected = 'session-groups/direct.md'; edit.hidden = false; edit.disabled = false; save.disabled = false;
  f.controller.render(); applyMemoryWriteAccess(edit, save, known, selected); assert.equal(edit.hidden, true); assert.equal(save.disabled, true);
  assert.deepEqual(f.paths(), ['identity.md', 'references.md', 'state.md', 'session-groups/direct.md'],
    'a file directly under session-groups is listed with the groups, not hidden');
  f.controller.destroy();
});

test('success arriving during a same-path reload is discarded without applying or persisting an empty draft', async () => {
  const state = { selectedPath: 'state.md', file: { path: 'state.md', text: 'old', sha256: 'old-sha' }, draft: 'submitted', editing: true, dirty: true };
  const captured = captureMemorySave(state), pending = deferred(), persisted = [];
  const saving = saveMemoryOnce({ path: 'state.md', text: state.draft, sha256: state.file.sha256,
    request: () => pending.promise, isCurrent: () => memorySaveCurrent(captured, state) });
  state.file = null; state.draft = ''; state.editing = false; state.dirty = false;
  const saved = { path: 'state.md', text: 'submitted', sha256: 'saved-sha' };
  pending.resolve(saved);
  const result = await saving;
  if (result && applyMemorySave(captured, state, result)) persisted.push(state.draft);
  assert.equal(result, null); assert.equal(state.file, null); assert.equal(state.draft, '');
  assert.equal(persisted.length, 0); assert.equal(state.dirty, false); assert.equal(state.editing, false);
  state.file = { path: 'state.md', text: 'submitted', sha256: 'saved-sha' }; state.draft = 'reloaded current draft';
  assert.equal(applyMemorySave(captured, state, saved), false);
  assert.equal(state.draft, 'reloaded current draft');
});

test('conflict arriving during a same-path reload cannot create an empty mine version', async () => {
  const state = { selectedPath: 'state.md', file: { path: 'state.md', sha256: 'old' }, draft: 'submitted', conflict: null };
  const captured = captureMemorySave(state), pending = deferred();
  const saving = saveMemoryOnce({ path: 'state.md', text: state.draft, sha256: state.file.sha256,
    request: () => pending.promise, isCurrent: () => memorySaveCurrent(captured, state) });
  state.file = null; state.draft = '';
  pending.reject({ code: 'memory_conflict', current: { path: 'state.md', text: 'updated on disk' } });
  assert.equal(await saving, null); assert.equal(state.conflict, null); assert.equal(state.draft, '');
});

test('a conflict latest-version readback is fenced while the same path reloads', async () => {
  const state = { selectedPath: 'state.md', file: { path: 'state.md' }, draft: 'submitted', conflict: null };
  const captured = captureMemorySave(state), latest = deferred();
  await assert.rejects(saveMemoryOnce({ path: 'state.md', text: state.draft, sha256: 'old',
    request: async () => { throw { code: 'memory_conflict' }; }, isCurrent: () => memorySaveCurrent(captured, state) }), error => error.code === 'memory_conflict');
  state.file = null; state.draft = '';
  latest.resolve({ path: 'state.md', text: 'latest' }); await latest.promise;
  assert.equal(memorySaveCurrent(captured, state), false); assert.equal(state.conflict, null);
});

test('saved metadata updates the loaded file rows without reopening the editor and preserves typed selection during rendering', async () => {
  const f = fixture(); await settled();
  const state = { selectedPath: 'identity.md', file: { path: 'identity.md', sha256: 'old' }, draft: 'submitted', editing: true, dirty: true };
  const captured = captureMemorySave(state); state.draft = 'submitted plus newer typing';
  const saved = { path: 'identity.md', text: 'submitted', sha256: 'new', size_bytes: 9, mtime: 'saved-time' };
  assert.equal(applyMemorySave(captured, state, saved, f.controller.updateFile), true);
  const node = f.controller.known().rootFiles.find(row => row.path === 'identity.md');
  assert.equal(node.size_bytes, 9); assert.equal(node.mtime, 'saved-time');
  assert.equal(Object.hasOwn(node, 'text'), false); assert.equal(Object.hasOwn(node, 'sha256'), false);
  f.controller.destroy();
  let editor = { value: state.draft, selectionStart: 13, selectionEnd: 18, selectionDirection: 'forward' }, renders = 0;
  const document = { activeElement: editor, querySelector: () => editor };
  renderMemoryPreservingEditor(() => {
    renders++;
    editor = { value: state.draft, focus() { document.activeElement = this; }, setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; } };
  }, document);
  assert.equal(renders, 1); assert.equal(document.activeElement, editor);
  assert.equal(editor.value, 'submitted plus newer typing'); assert.equal(editor.selectionStart, 13); assert.equal(editor.selectionEnd, 18);
  assert.equal(state.file, saved); assert.equal(state.editing, true); assert.equal(state.dirty, true); assert.equal(state.draftNotice, false);
});

test('a rejected save re-render restores the editor scroll position and selection', () => {
  const fresh = () => ({ scrollTop: 0, scrollLeft: 0, focused: false, focus() { this.focused = true; },
    setSelectionRange(start, end, direction) { this.selection = [start, end, direction]; this.scrollTop = 0; } });
  for (const focused of [true, false]) {
    let editor = { scrollTop: 2124, scrollLeft: 7, selectionStart: 40, selectionEnd: 52, selectionDirection: 'backward' };
    const document = { activeElement: focused ? editor : null, querySelector: () => editor };
    renderMemoryPreservingEditor(() => { editor = fresh(); }, document);
    assert.equal(editor.scrollTop, 2124); assert.equal(editor.scrollLeft, 7);
    assert.deepEqual(editor.selection, [40, 52, 'backward']); assert.equal(editor.focused, focused);
  }
  let renders = 0;
  renderMemoryPreservingEditor(() => { renders++; }, { activeElement: null, querySelector: () => null });
  assert.equal(renders, 1, 'a view without an editor renders normally');
});

test('repeated action renders keep invalid group drafts read-only', () => {
  const value = { groups: new Map([['telegram:dm-1001', { sessionGroup: 'telegram:dm-1001' }]]), invalid: new Set(['bad name']), rootFiles: [] };
  const edit = {}, save = {};
  for (const path of ['session-groups/bad name/notes.md', 'session-groups/direct.md']) {
    for (let render = 0; render < 3; render++) {
      Object.assign(edit, { hidden: false, disabled: false }); Object.assign(save, { disabled: false });
      applyMemoryWriteAccess(edit, save, value, path);
      assert.equal(edit.hidden, true); assert.equal(edit.disabled, true); assert.equal(save.disabled, true);
    }
  }
  Object.assign(edit, { hidden: false, disabled: false }); save.disabled = true;
  applyMemoryWriteAccess(edit, save, value, 'identity.md');
  assert.equal(edit.hidden, false); assert.equal(edit.disabled, false); assert.equal(save.disabled, true, 'ordinary pending/clean restrictions remain in force');
});

test('a file\'s scope comes from the loaded groups: shared, a valid group, invalid, or unknown until loaded', () => {
  const group = { sessionGroup: 'telegram:dm-1001' };
  const known = { groups: new Map([['telegram:dm-1001', group]]), invalid: new Set(['bad name']), rootFiles: [] };
  assert.deepEqual(memoryFileScope(known, 'state.md'), { kind: 'shared' });
  assert.deepEqual(memoryFileScope(known, 'session-groups/telegram:dm-1001/handoff.md'), { kind: 'group', group });
  assert.deepEqual(memoryFileScope(known, 'session-groups/bad name/notes.md'), { kind: 'invalid' });
  assert.deepEqual(memoryFileScope(known, 'session-groups/telegram:dm-1001'), { kind: 'invalid' });
  assert.deepEqual(memoryFileScope(known, 'session-groups/direct.md'), { kind: 'invalid' });
  assert.deepEqual(memoryFileScope(known, 'session-groups/telegram:other/state.md'), { kind: 'unknown' });
});

test('opening a folder or group reads its first page, folding all closes them, and the search asks the server', async () => {
  const requested = [];
  const f = fixture({ request: async path => { requested.push(path.split('?')[0]); return { groups: [] }; } });
  await settled();
  await f.controller.load();
  assert.deepEqual(requested, ['/api/memory/backlog'], 'the backlog card reads only the backlog');
  assert.equal(f.controller.anyExpanded(), false);
  nodesOfClass(f.listRoot, 'wb-memory-group-h')[0].dispatch('click'); await settled();
  assert.ok(f.entries.reads.includes('/api/memory/entries?dir=session-groups%2Ftelegram%3Adm-1001'));
  assert.ok(f.paths().includes('session-groups/telegram:dm-1001/handoff.md'));
  nodesOfClass(f.listRoot, 'wb-memory-dir-h')[0].dispatch('click'); await settled();
  assert.ok(f.paths().includes('users/profile.md'));
  assert.equal(f.controller.anyExpanded(), true);
  f.controller.collapseAll();
  assert.deepEqual(f.paths(), ['identity.md', 'references.md', 'state.md']);
  assert.equal(f.controller.anyExpanded(), false);
  // A search is one flat list of the server's matches in the current view; no match says so.
  const search = allNodes(f.root).find(node => node.type === 'search' && node.className !== 'wb-input');
  search.value = 'handoff'; search.dispatch('input'); await typed(); await settled();
  assert.ok(f.entries.reads.includes('/api/memory/entries?q=handoff'));
  assert.deepEqual(f.paths(), ['session-groups/telegram:dm-1001/handoff.md']);
  // A match shows its file name whole first and its folder on the second line, so a long group ID cannot hide it.
  const match = nodesOfClass(f.listRoot, 'memory-file-match')[0];
  assert.deepEqual(nodesOfClass(match, 'memory-file-name')[0].children.map(node => [node.className, node.textContent]),
    [['', 'handoff.md'], ['memory-file-dir', 'session-groups/telegram:dm-1001/']]);
  allNodes(f.root).find(node => node.textContent === 'wb.memory.shared').dispatch('click'); await settled();
  assert.ok(f.entries.reads.includes('/api/memory/entries?view=shared&q=handoff'));
  assert.match(f.listRoot.textContent, /wb\.memory\.noMatch/);
  f.controller.destroy();
});

test('a list past its first page loads more without repeats, and a refused cursor reads the first page again silently', async () => {
  const files = [...memoryFiles(), ...Array.from({ length: 120 }, (_, index) => file(`session-groups/telegram:dm-1001/sessions/d${String(index).padStart(3, '0')}.md`))];
  // A file saved between two reads comes back on the next page: the server's second page repeats one of the first.
  const server = entriesServer(files);
  let firstRow = null, repeated = false;
  const entries = Object.assign(async path => {
    const page = await server(path);
    if (!new URL(path, 'http://dashboard').searchParams.get('dir')?.endsWith('/sessions')) return page;
    if (!path.includes('cursor=')) { firstRow ??= page.items[0]; return page; }
    if (repeated) return page;
    repeated = true;
    return { ...page, items: [firstRow, ...page.items] };
  }, { reads: server.reads, refuse: server.refuse });
  const f = fixture({ files, entries });
  await settled();
  f.controller.selectGroup('telegram:dm-1001'); await settled();
  nodesOfClass(f.listRoot, 'wb-memory-dir-h')[0].dispatch('click'); await settled();
  const sessions = () => f.paths().filter(path => path.includes('/sessions/'));
  assert.equal(sessions().length, 50);
  nodesOfClass(f.listRoot, 'wb-memory-more')[0].dispatch('click'); await settled();
  assert.equal(repeated, true);
  assert.equal(sessions().length, 100, 'the repeated path is shown once');
  assert.equal(new Set(sessions()).size, 100);
  f.entries.refuse();
  nodesOfClass(f.listRoot, 'wb-memory-more')[0].dispatch('click'); await settled();
  assert.equal(sessions().length, 50, 'the first page again');
  assert.doesNotMatch(f.listRoot.textContent, /memory.error_generic/, 'no error is shown');
  nodesOfClass(f.listRoot, 'wb-memory-more')[0].dispatch('click'); await settled();
  nodesOfClass(f.listRoot, 'wb-memory-more')[0].dispatch('click'); await settled();
  assert.equal(sessions().length, 120); assert.equal(new Set(sessions()).size, 120);
  assert.equal(nodesOfClass(f.listRoot, 'wb-memory-more').length, 0);
  f.controller.destroy();
});

test('a linked file opens its folders and is added to its folder when past the first page', async () => {
  const files = [...memoryFiles(), ...Array.from({ length: 60 }, (_, index) => file(`session-groups/telegram:dm-1001/sessions/d${String(index).padStart(3, '0')}.md`))];
  const f = fixture({ files, getFile: () => ({ path: 'session-groups/telegram:dm-1001/sessions/d059.md' }),
    selectedPath: () => 'session-groups/telegram:dm-1001/sessions/d059.md' });
  await settled();
  await f.controller.revealFile({ path: 'session-groups/telegram:dm-1001/sessions/d059.md', name: 'd059.md', size_bytes: 3, mtime: 'now' });
  assert.deepEqual(f.heads().filter(node => node.attributes['aria-expanded'] === 'true').map(node => node.dataset.collapseKey).sort(),
    ['session-groups/telegram:dm-1001', 'session-groups/telegram:dm-1001/sessions']);
  const active = nodesOfClass(f.listRoot, 'memory-file').filter(node => node.className.includes('active'));
  assert.deepEqual(active.map(node => node.dataset.path), ['session-groups/telegram:dm-1001/sessions/d059.md']);
  assert.equal(f.paths().filter(path => path.includes('/sessions/')).length, 51, 'the first page plus the linked file');
  // A group past the first page of groups is looked up by name and added.
  const many = [...memoryFiles(), ...Array.from({ length: 55 }, (_, index) => file(`session-groups/lark:g${String(index).padStart(2, '0')}/state.md`)),
    file('session-groups/telegram:zz/state.md')];
  const g = fixture({ files: many }); await settled();
  await g.controller.revealFile({ path: 'session-groups/telegram:zz/state.md', name: 'state.md', size_bytes: 1, mtime: 'now' });
  assert.ok(g.paths().includes('session-groups/telegram:zz/state.md'));
  assert.equal(g.controller.known().groups.has('telegram:zz'), true);
  f.controller.destroy(); g.controller.destroy();
});

test('memory list redraws restore files, folders and group headers by stable identity without scrolling', async () => {
  for (const kind of ['file', 'directory', 'group']) {
    const document = createDocument(), listRoot = document.createElement('div'), calls = [];
    const create = document.createElement;
    document.createElement = tag => {
      const node = create(tag), focus = node.focus.bind(node);
      node.focus = options => { calls.push(options); focus(); };
      return node;
    };
    const f = fixture({ document, listRoot });
    await settled();
    const target = () => kind === 'file' ? nodesOfClass(listRoot, 'memory-file')[1]
      : nodesOfClass(listRoot, kind === 'directory' ? 'wb-memory-dir-h' : 'wb-memory-group-h')[0];
    const original = target(); original.focus(); calls.length = 0;
    f.controller.renderList();
    assert.ok(target() !== original, `${kind} rows were really rebuilt`);
    assert.ok(document.activeElement === target(), `${kind} focus follows its identity`);
    assert.equal(listRoot.contains(document.activeElement), true);
    assert.deepEqual(calls, [{ preventScroll: true }]);
    f.controller.destroy();
  }
});

test('memory list redraws do not take focus from search or editor controls', async () => {
  const document = createDocument(), listRoot = document.createElement('div');
  const f = fixture({ document, listRoot });
  await settled();
  for (const tag of ['input', 'textarea']) {
    const external = document.createElement(tag);
    external.dataset.path = nodesOfClass(listRoot, 'memory-file')[0].dataset.path;
    external.dataset.collapseKey = 'users';
    external.focus();
    f.controller.renderList();
    assert.ok(document.activeElement === external, `${tag} focus stays outside the list`);
  }
  f.controller.destroy();
});

test('memory list redraws do not redirect focus when the focused row disappears', async () => {
  for (const reason of ['filtered', 'folded', 'reloaded']) {
    const document = createDocument(), listRoot = document.createElement('div');
    const f = fixture({ document, listRoot });
    await settled();
    if (reason === 'folded') { nodesOfClass(listRoot, 'wb-memory-dir-h')[0].dispatch('click'); await settled(); }
    const original = reason === 'folded' ? nodesOfClass(listRoot, 'memory-file').find(node => node.dataset.path === 'users/profile.md')
      : nodesOfClass(listRoot, 'memory-file')[0];
    original.focus();
    if (reason === 'filtered') {
      const search = allNodes(f.root).find(node => node.type === 'search' && node.className !== 'wb-input');
      search.value = 'no-matching-path'; search.dispatch('input'); await typed();
    } else if (reason === 'folded') f.controller.collapseAll();
    else f.controller.reload();
    assert.equal(listRoot.contains(original), false);
    assert.ok(document.activeElement === original, `${reason}: injected DOM records no fallback focus call`);
    f.controller.destroy();
  }
});

test('later in the conflict dialog closes it and keeps the unsaved draft', () => {
  const memory = { conflict: { mine: 'a', theirs: { text: 'b' } }, draft: 'my draft', dirty: true, editing: true };
  leaveMemoryConflict(memory);
  assert.deepEqual(memory, { conflict: null, draft: 'my draft', dirty: true, editing: true });
});

test('the editor warns about background upkeep only on instances with session groups', () => {
  assert.equal(memoryUpkeepNotice({ groups: new Map([['telegram:dm-1001', {}]]) }), true);
  assert.equal(memoryUpkeepNotice({ groups: new Map(), invalid: new Set(['bad name']) }), false);
  assert.equal(memoryUpkeepNotice(null), false);
});

test('the cross-group row name keeps the label layout without the link cursor or hover underline', async () => {
  const css = await readFile(new URL('../public/css/wb.css', import.meta.url), 'utf8');
  const rule = selector => css.match(new RegExp(`^${selector.replace(/[.:]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';
  assert.match(rule('.wb-memory-chart-label'), /cursor: pointer/);
  assert.match(rule('.wb-memory-chart-label.wb-memory-chart-label-static'), /cursor: default/);
  assert.match(rule('.wb-memory-chart-label.wb-memory-chart-label-static:hover'), /text-decoration: none/);
});

test('the backlog subtitle names the gathering threshold even when no group threshold is known', async () => {
  const f = fixture({ detail: () => 'technical', request: async () => ({ groups: [],
    originSync: { count: 4, pendingSummaries: 0, firstAt: null, aged: false, syncing: false, threshold: 50 } }) });
  await f.controller.load();
  assert.match(nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0].textContent, /wb.memory.backlogHintOrigin \{"origin":50\}/);
  f.controller.destroy();
});

test('memory budget labels and tooltips use B KB MB with 1024 based values', async () => {
  const f = fixture({ detail: () => 'technical', files: [
    file('identity.md', 1023), file('references.md', 1024), file('state.md', 1024 * 1024),
  ], request: async () => ({ groups: [], budgets: {
    limits: { 'identity.md': 10240, 'references.md': 1536 }, warnings: { 'identity.md': 512 },
  } }) });
  await f.controller.load(); await settled();
  const values = nodesOfClass(f.chartsRoot, 'wb-memory-chart-value').map(node => node.textContent);
  assert.deepEqual(values, ['1023 B / 10 KB', '1.0 KB / 1.5 KB', '1.0 MB']);
  const warning = nodesOfClass(f.chartsRoot, 'wb-memory-threshold')[0];
  assert.match(warning.title, /512 B/);
  const tracks = nodesOfClass(f.chartsRoot, 'wb-memory-track');
  assert.match(tracks[0].attributes['aria-label'], /1023 B.*10 KB/);
  assert.doesNotMatch(f.chartsRoot.textContent, /KiB/);
  f.controller.destroy();
});
