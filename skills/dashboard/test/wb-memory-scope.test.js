import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDocument, allNodes, deferred } from './fixtures/workbench-dom.js';
import { memoryBacklogView, memoryBacklogAge, leaveMemoryConflict, memoryFileScope, memoryFlatFiles, memoryUpkeepNotice, memoryScope, memoryGroupLabel, memoryBudgetRows, createMemoryScope, memoryWriteMessage, saveMemoryOnce, applyMemorySave, memoryWriteAllowed, applyMemoryWriteAccess, renderMemoryPreservingEditor, captureMemorySave, memorySaveCurrent, memorySaveTargetCurrent, memorySaveOwnerCurrent, memorySaveAppliedCurrent } from '../public/js/wb/memory-scope.js';
import { parseSessionGroup } from '../../comm-bridge/scripts/c4-session-group.js';

// Direct product imports and injected DOM/request. Run for memory scope, charts,
// save-result interpretation or selection changes; skip unrelated collectors.
// Official runner and outer harness isolate HOME, ZYLOS_DIR, PM2_HOME, short
// TMPDIR and private TMUX_TMPDIR. No database, process, timer or external I/O.
const t = (key, params) => key + (params ? ' ' + JSON.stringify(params) : '');
const file = (path, size_bytes = 100) => ({ path, name: path.split('/').at(-1), type: 'file', size_bytes, renderable: true });
const dir = (path, children) => ({ path, name: path.split('/').at(-1), type: 'directory', children });
function tree() {
  const groups = dir('session-groups', [dir('session-groups/telegram:dm-1001', [file('session-groups/telegram:dm-1001/handoff.md')]), dir('session-groups/bad name', [file('session-groups/bad name/notes.md')])]);
  const root = dir('', [file('identity.md', 17000), file('references.md', 9000), file('state.md', 33000), dir('users', [file('users/profile.md')]), groups]);
  return { root, sessionGroups: groups.children.filter(child => parseSessionGroup(child.name)).map(child => ({ sessionGroup: child.name })) };
}
const nodesOfClass = (root, className) => allNodes(root).filter(node => node.className.split(' ').includes(className));
function fixture(options = {}) {
  const document = createDocument(), root = document.createElement('div'), chartsRoot = document.createElement('div');
  const groups = [], files = [], changes = [];
  let data = tree();
  const controller = createMemoryScope({ document, root, chartsRoot, t, getTree: () => data,
    request: async () => ({ groups: [], hasOlder: false }), onGroup: path => groups.push(path), onFile: path => files.push(path),
    onChange: () => { changes.push(true); controller.render(); }, ...options });
  controller.render();
  return { document, root, chartsRoot, groups, files, changes, controller, setTree: value => { data = value; } };
}

test('memory scopes separate canonical group directories and retain invalid names under shared with diagnostics', () => {
  const value = tree(), scope = memoryScope(value);
  assert.equal(scope.groups.length, 1);
  assert.equal(scope.groups[0].sessionGroup, 'telegram:dm-1001');
  assert.equal(scope.shared.children.find(node => node.path === 'session-groups').children[0].name, 'bad name');
  assert.equal(scope.shared.children.find(node => node.path === 'session-groups').children[0].diagnostic, 'invalid_session_group');
  assert.equal(scope.shared.children.some(node => node.path === 'users'), true);
  assert.equal(value.root.children.at(-1).children.length, 2, 'input tree remains intact');
  assert.equal(memoryGroupLabel(scope.groups[0], t), 'wb.platform.telegram · dm-1001');
  assert.equal(memoryGroupLabel({ sessionGroup: 'x', displayName: '<img>' }, t), '<img>');
  assert.equal(memoryGroupLabel({ sessionGroup: 'origin' }, t), 'wb.term.origin');
  assert.equal(memoryScope(null).groups.length, 0);
});

test('scope controls filter groups and group jumps select the directory without opening an unrelated file', () => {
  const f = fixture();
  assert.equal(f.controller.tree(tree()).children.some(node => node.path === 'identity.md'), true);
  f.controller.selectGroup('telegram:dm-1001');
  const filtered = f.controller.tree(tree());
  assert.equal(filtered.children.length, 1); assert.equal(filtered.children[0].path, 'session-groups/telegram:dm-1001');
  assert.equal(f.groups.at(-1), 'session-groups/telegram:dm-1001'); assert.equal(f.files.length, 0);
  assert.equal(f.controller.initialPath(tree(), 'identity.md', root => root.children[0]?.children[0]?.path ?? null), 'session-groups/telegram:dm-1001/handoff.md');
  const select = allNodes(f.root).find(node => node.tagName === 'SELECT');
  assert.equal(select.value, 'telegram:dm-1001');
  select.value = ''; select.dispatch('change');
  assert.equal(f.controller.tree(tree()).children.length, 1); assert.equal(f.groups.at(-1), null);
  f.controller.selectGroup('openmax:missing');
  assert.equal(f.controller.tree(tree()).children.length, 0); assert.match(f.root.textContent, /wb.memory.noGroupFiles/);
  assert.equal(f.controller.initialPath(tree(), 'identity.md', () => null), null);
  f.controller.destroy();
});

test('budget rows use Core supplied thresholds and give state size without a budget', () => {
  const rows = memoryBudgetRows(tree(), { limits: { 'identity.md': 16384, 'references.md': 16384, 'state.md': 1 }, warnings: { 'references.md': 8192, 'state.md': 1 } });
  assert.equal(rows[0].over, 616); assert.equal(rows[1].warned, true);
  assert.equal(rows[2].limit, null); assert.equal(rows[2].warning, null); assert.equal(rows[2].size, 33000);
  assert.equal(memoryBudgetRows(tree(), null)[0].limit, null);
});

test('technical charts show each threshold, unknown readings, age, Core budgets and clickable destinations safely', async () => {
  const f = fixture({ detail: () => 'technical', request: async () => ({
    groups: [
      { sessionGroup: 'telegram:dm-1001', count: 20, threshold: 15, syncing: true, aged: true },
      { sessionGroup: 'openmax:other', count: 3, threshold: 50, syncing: null },
      { sessionGroup: 'other', count: null, threshold: null, syncing: false, reason: '<script>' },
    ], hasOlder: true, budgets: { limits: { 'identity.md': 16384, 'references.md': 16384 }, warnings: { 'references.md': 8192 } },
  }) });
  await f.controller.load();
  assert.equal(f.chartsRoot.hidden, false);
  assert.match(f.chartsRoot.textContent, /wb.memory.aged/); assert.match(f.chartsRoot.textContent, /wb.memory.syncing/);
  assert.match(f.chartsRoot.textContent, /wb.memory.syncUnknown/); assert.match(f.chartsRoot.textContent, /wb.unknown/);
  assert.match(f.chartsRoot.textContent, /wb.memory.overBudget/); assert.match(f.chartsRoot.textContent, /wb.memory.warning/);
  assert.equal(nodesOfClass(f.chartsRoot, 'wb-memory-threshold').length, 3);
  assert.equal(nodesOfClass(f.chartsRoot, 'excess').length, 1);
  assert.equal(allNodes(f.chartsRoot).some(node => node.tagName === 'SCRIPT'), false);
  const buttons = allNodes(f.chartsRoot).filter(node => node.tagName === 'BUTTON');
  buttons[0].dispatch('click'); assert.equal(f.groups.at(-1), 'session-groups/telegram:dm-1001');
  buttons.find(node => node.textContent === 'state.md').dispatch('click'); assert.equal(f.files.at(-1), 'state.md');
  f.controller.destroy();
});

test('backlog rows: waiting groups first, then by pending count, groups with nothing pending set apart', () => {
  const view = memoryBacklogView([
    { sessionGroup: 'quiet', count: 0, syncing: false, threshold: 15 },
    { sessionGroup: 'few', count: 3, syncing: false, threshold: 15 },
    { sessionGroup: 'unknown', count: null, syncing: null, threshold: 15 },
    { sessionGroup: 'old-small', count: 2, aged: true, firstAt: '2026-11-01 00:00:00', syncing: false, threshold: 15 },
    { sessionGroup: 'many', count: 40, syncing: false, threshold: 15 },
    { sessionGroup: 'old-big', count: 9, aged: true, firstAt: '2026-11-02 00:00:00', syncing: false, threshold: 15 },
    { sessionGroup: 'zero-syncing', count: 0, syncing: true, threshold: 15 },
    { sessionGroup: 'origin', count: 0, syncing: false, threshold: 30 },
  ]);
  assert.deepEqual(view.active.map(row => row.sessionGroup), ['old-big', 'old-small', 'many', 'few', 'zero-syncing', 'unknown']);
  assert.deepEqual(view.quiet.map(row => row.sessionGroup), ['quiet', 'origin']);
  assert.equal(view.threshold, 15, 'the header names the threshold most groups share');
  assert.equal(view.quiet[1].ownThreshold, 30, 'a group with another threshold keeps it on its row');
  assert.equal(view.active[0].ownThreshold, null);
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

test('backlog card: threshold in the header, age as a mark on its row, quiet groups folded, a filter past twelve groups', async () => {
  const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();
  const groups = [{ sessionGroup: 'telegram:dm-1', displayName: 'Waiting long', count: 20, threshold: 15, syncing: false, aged: true, firstAt: hoursAgo(9.5) }];
  for (let i = 0; i < 12; i++) groups.push({ sessionGroup: `telegram:dm-q${i}`, displayName: `Quiet ${i}`, count: 0, threshold: 15, syncing: false });
  const f = fixture({ detail: () => 'technical', request: async () => ({ groups, hasOlder: false }) });
  await f.controller.load();
  const card = nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0];
  assert.match(card.textContent, /wb.memory.thresholdHint \{"count":15\}/);
  const rows = () => nodesOfClass(card, 'wb-memory-bl');
  const first = rows()[0];
  assert.equal(nodesOfClass(first, 'wb-memory-chart-label')[0].textContent, 'Waiting long');
  const mark = nodesOfClass(first, 'wb-memory-bl-tag')[0];
  assert.equal(mark.textContent, 'wb.memory.agedHours {"count":9}'); assert.match(mark.className, /\bwarn\b/);
  assert.equal(nodesOfClass(nodesOfClass(first, 'wb-memory-bl-head')[0], 'wb-memory-bl-tag').includes(mark), true, 'the mark sits with the name, not on a line of its own');
  const rest = nodesOfClass(card, 'wb-memory-rest')[0];
  assert.equal(rest.tagName, 'DETAILS'); assert.equal(rest.open, false);
  assert.match(rest.textContent, /wb.memory.restQuiet \{"count":12\}/);
  assert.equal(nodesOfClass(rest, 'wb-memory-bl').length, 12, 'quiet groups stay reachable inside the fold');
  rest.open = true; rest.dispatch('toggle');
  f.controller.render();
  assert.equal(nodesOfClass(f.chartsRoot, 'wb-memory-rest')[0].open, true, 'an opened fold stays open across refreshes');
  const filter = allNodes(card).find(node => node.tagName === 'INPUT');
  assert.ok(filter, 'thirteen groups get a filter');
  filter.value = 'quiet 1'; filter.dispatch('input');
  const card2 = nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0];
  assert.deepEqual(nodesOfClass(card2, 'wb-memory-chart-label').map(node => node.textContent), ['Quiet 1', 'Quiet 10', 'Quiet 11'], 'a search lists matching quiet groups unfolded');
  assert.equal(nodesOfClass(card2, 'wb-memory-rest').length, 0);
  filter.value = 'nothing'; filter.dispatch('input');
  assert.match(nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0].textContent, /wb.memory.noMatch/);
  f.controller.destroy();
});

test('a short backlog list has no filter and folds an all-quiet list under one line', async () => {
  const f = fixture({ detail: () => 'technical', request: async () => ({ groups: [
    { sessionGroup: 'telegram:dm-1', count: 0, threshold: 15, syncing: false },
    { sessionGroup: 'telegram:dm-2', count: 0, threshold: 15, syncing: false },
  ] }) });
  await f.controller.load();
  const card = nodesOfClass(f.chartsRoot, 'wb-memory-progress')[0];
  assert.equal(allNodes(card).some(node => node.tagName === 'INPUT'), false);
  assert.match(nodesOfClass(card, 'wb-memory-rest')[0].textContent, /wb.memory.allQuiet \{"count":2\}/);
  f.controller.destroy();
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
  const f = fixture({ request: async () => { reads++; return { groups: [] }; } });
  await f.controller.load(); assert.equal(f.chartsRoot.hidden, true);
  f.document.documentElement.dataset.detail = 'technical'; f.controller.render();
  assert.equal(f.chartsRoot.hidden, false); assert.equal(reads, 1);
  f.document.documentElement.dataset.detail = 'plain'; f.controller.render();
  assert.equal(f.chartsRoot.hidden, true); assert.equal(reads, 1);
  f.controller.destroy();
});


test('group navigation after an instance change keeps the requested group selection', () => {
  let owner = 'a'; const f = fixture({ identity: () => owner });
  owner = 'b'; f.controller.selectGroup('telegram:dm-1001');
  assert.equal(f.controller.tree(tree()).children[0].path, 'session-groups/telegram:dm-1001');
  f.controller.destroy();
});


test('workbench language packages contain the same translation keys', async () => {
  const en = JSON.parse(await readFile(new URL('../public/i18n/wb.en.json', import.meta.url), 'utf8'));
  const zh = JSON.parse(await readFile(new URL('../public/i18n/wb.zh.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
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

test('the references warning follows Core below, at and above the warning threshold', () => {
  const value = tree();
  for (const size of [8191, 8192, 8193]) {
    value.root.children.find(file => file.path === 'references.md').size_bytes = size;
    const row = memoryBudgetRows(value, { limits: { 'references.md': 16384 }, warnings: { 'references.md': 8192 } }).find(row => row.path === 'references.md');
    assert.equal(row.warned, size > 8192); assert.equal(row.over, 0);
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

test('invalid group directories and files directly under session-groups explain their read-only status', () => {
  const value = tree(), sessionGroups = value.root.children.find(node => node.path === 'session-groups');
  sessionGroups.children.push(file('session-groups/direct.md'));
  assert.equal(memoryWriteAllowed(value, 'session-groups/bad name/notes.md'), false);
  assert.equal(memoryWriteAllowed(value, 'session-groups/direct.md'), false);
  assert.equal(memoryWriteAllowed(value, 'session-groups/telegram:dm-1001/handoff.md'), true);
  assert.equal(memoryWriteAllowed(value, 'identity.md'), true);
  const document = createDocument(), edit = document.createElement('button'), save = document.createElement('button');
  document.querySelector = selector => selector === '#memory-edit-btn' ? edit : selector === '#memory-save-btn' ? save : null;
  let selected = 'session-groups/bad name/notes.md';
  const f = fixture({ document, getFile: () => ({ path: selected }) }); f.setTree(value); f.controller.render();
  applyMemoryWriteAccess(edit, save, value, selected);
  assert.equal(edit.hidden, true); assert.equal(edit.disabled, true); assert.equal(save.disabled, true);
  assert.match(f.root.textContent, /wb.memory.invalidGroupFile/);
  selected = 'session-groups/direct.md'; edit.hidden = false; edit.disabled = false; save.disabled = false;
  f.controller.render(); applyMemoryWriteAccess(edit, save, value, selected); assert.equal(edit.hidden, true); assert.equal(save.disabled, true);
  assert.equal(memoryScope(value).shared.children.find(node => node.path === 'session-groups').children.length, 2);
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

test('saved metadata updates tree sizes without reopening the editor and preserves typed selection during rendering', () => {
  const value = tree(), state = { selectedPath: 'identity.md', file: { path: 'identity.md', sha256: 'old' }, draft: 'submitted', editing: true, dirty: true, tree: value };
  const captured = captureMemorySave(state); state.draft = 'submitted plus newer typing';
  const saved = { path: 'identity.md', text: 'submitted', sha256: 'new', size_bytes: 9, mtime: 'saved-time' };
  assert.equal(applyMemorySave(captured, state, saved), true);
  const node = value.root.children.find(node => node.path === 'identity.md');
  assert.equal(node.size_bytes, 9); assert.equal(node.mtime, 'saved-time');
  assert.equal(Object.hasOwn(node, 'text'), false); assert.equal(Object.hasOwn(node, 'sha256'), false);
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
  const value = tree(), edit = {}, save = {};
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


test('memory files list flat per section, skip dot files and know their scope', () => {
  const value = tree();
  value.root.children.push(file('.gitkeep'), dir('reference', [file('reference/decisions.md'), file('reference/.gitkeep')]));
  const shared = memoryFlatFiles(memoryScope(value).shared).map(node => node.path);
  assert.deepEqual(shared.filter(path => !path.startsWith('session-groups/')),
    ['identity.md', 'references.md', 'state.md', 'users/profile.md', 'reference/decisions.md']);
  assert.equal(shared.some(path => path.split('/').at(-1).startsWith('.')), false);
  assert.deepEqual(memoryFileScope(value, 'state.md'), { kind: 'shared' });
  assert.equal(memoryFileScope(value, 'session-groups/telegram:dm-1001/handoff.md').kind, 'group');
  assert.equal(memoryFileScope(value, 'session-groups/telegram:dm-1001/handoff.md').group.sessionGroup, 'telegram:dm-1001');
  assert.deepEqual(memoryFileScope(value, 'session-groups/bad name/notes.md'), { kind: 'invalid' });
  assert.deepEqual(memoryFileScope(value, 'session-groups/telegram:dm-1001'), { kind: 'invalid' });
});

test('the file list folds by section, keeps search results open and names the folding state', () => {
  const collapsed = new Set(), toggled = [], listRoot = createDocument().createElement('div');
  const f = fixture({ listRoot, isCollapsed: key => collapsed.has(key), toggleCollapsed: key => toggled.push(key) });
  assert.deepEqual(f.controller.sectionKeys(), ['shared', 'session-groups/telegram:dm-1001']);
  f.controller.renderList();
  const heads = () => nodesOfClass(listRoot, 'wb-memory-section-h').concat(nodesOfClass(listRoot, 'wb-memory-group-h'));
  assert.deepEqual(heads().map(node => node.attributes['aria-expanded']), ['true', 'true']);
  const paths = () => allNodes(listRoot).filter(node => node.dataset.path).map(node => node.dataset.path);
  assert.ok(paths().includes('state.md') && paths().includes('session-groups/telegram:dm-1001/handoff.md'));
  heads()[1].dispatch('click'); assert.deepEqual(toggled, ['session-groups/telegram:dm-1001']);
  collapsed.add('shared'); collapsed.add('session-groups/telegram:dm-1001'); f.controller.renderList();
  assert.deepEqual(heads().map(node => node.attributes['aria-expanded']), ['false', 'false']);
  assert.deepEqual(paths(), []);
  // A search shows matches inside folded sections; no match says so.
  const search = allNodes(f.root).find(node => node.type === 'search');
  search.value = 'handoff'; search.dispatch('input');
  assert.deepEqual(paths(), ['session-groups/telegram:dm-1001/handoff.md']);
  search.value = 'nothing-here'; search.dispatch('input');
  assert.match(listRoot.textContent, /wb\.memory\.noMatch/);
  // The shared scope has no group sections to fold.
  allNodes(f.root).find(node => node.textContent === 'wb.memory.shared').dispatch('click');
  assert.deepEqual(f.controller.sectionKeys(), ['shared']);
  f.controller.destroy();
});

test('later in the conflict dialog closes it and keeps the unsaved draft', () => {
  const memory = { conflict: { mine: 'a', theirs: { text: 'b' } }, draft: 'my draft', dirty: true, editing: true };
  leaveMemoryConflict(memory);
  assert.deepEqual(memory, { conflict: null, draft: 'my draft', dirty: true, editing: true });
});

test('the editor warns about background upkeep only on instances with session groups', () => {
  assert.equal(memoryUpkeepNotice(tree()), true);
  assert.equal(memoryUpkeepNotice({ root: tree().root, sessionGroups: [] }), false);
  assert.equal(memoryUpkeepNotice(null), false);
});

test('the shared list leads with the core files even though the server lists directories first', () => {
  // The memory tree from the server puts directories before files at each level.
  const value = { root: dir('', [dir('reference', [file('reference/decisions.md')]), dir('users', [dir('users/owner', [file('users/owner/profile.md')])]),
    file('identity.md'), file('references.md'), file('state.md')]) };
  assert.deepEqual(memoryFlatFiles(memoryScope(value).shared).map(node => node.path),
    ['identity.md', 'references.md', 'state.md', 'reference/decisions.md', 'users/owner/profile.md']);
});
