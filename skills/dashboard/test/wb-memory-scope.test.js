import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDocument, allNodes, deferred } from './fixtures/workbench-dom.js';
import { memoryScope, memoryGroupLabel, memoryBudgetRows, createMemoryScope, memoryWriteMessage, saveMemoryOnce, sha256Text, captureMemorySave, memorySaveCurrent, memorySaveTargetCurrent, memorySaveOwnerCurrent, memorySaveAppliedCurrent } from '../public/js/wb/memory-scope.js';
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
  assert.equal(memoryGroupLabel({ sessionGroup: 'origin', fallbackName: '系统助手' }, t), 'wb.term.origin');
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

test('unknown save result reads disk once and uses draft sha without resubmitting', async () => {
  const text = '草稿\n', sha = createHash('sha256').update(text).digest('hex'); let writes = 0, reads = 0;
  const result = await saveMemoryOnce({ path: 'state.md', text, sha256: 'old', digest: value => sha256Text(value, webcrypto),
    request: async () => { writes++; throw { code: 'memory_write_unknown' }; },
    readFile: async () => { reads++; return { path: 'state.md', text, sha256: sha }; } });
  assert.equal(result.sha256, sha); assert.equal(writes, 1); assert.equal(reads, 1);
  await assert.rejects(saveMemoryOnce({ path: 'state.md', text, sha256: 'old', digest: async () => sha,
    request: async () => { writes++; throw { code: 'memory_write_unknown' }; }, readFile: async () => { reads++; return { path: 'state.md', text: 'old', sha256: 'different' }; } }), error => error.code === 'memory_write_unknown');
  assert.equal(writes, 2); assert.equal(reads, 2);
});

test('sync busy preserves the write rejection without a readback and has a specific message', async () => {
  const error = { code: 'memory_sync_busy' }; let reads = 0;
  await assert.rejects(saveMemoryOnce({ path: 'x', text: 'draft', sha256: 'old', request: async () => { throw error; }, readFile: async () => { reads++; } }), value => value === error);
  assert.equal(reads, 0); assert.equal(memoryWriteMessage(error.code, t), 'wb.memory.syncBusy');
  assert.equal(memoryWriteMessage('other', t), null);
});


test('save completion is fenced when the instance, selected file or draft changes', async () => {
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

test('detail toggle redraws memory charts after the shared mode changes without reading again', async () => {
  const document = createDocument(), toggle = document.createElement('input');
  document.querySelector = selector => selector === '#wb-detail-toggle' ? toggle : null;
  let reads = 0;
  const f = fixture({ document, request: async () => { reads++; return { groups: [] }; } });
  await f.controller.load(); assert.equal(f.chartsRoot.hidden, true);
  toggle.dispatch('change'); document.documentElement.dataset.detail = 'technical';
  await Promise.resolve(); assert.equal(f.chartsRoot.hidden, false); assert.equal(reads, 1);
  toggle.dispatch('change'); document.documentElement.dataset.detail = 'plain';
  await Promise.resolve(); assert.equal(f.chartsRoot.hidden, true); assert.equal(reads, 1);
  f.controller.destroy(); assert.equal(toggle.listeners.get('change').length, 0);
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

test('post-save history readback requires the applied file and draft to still be current', async () => {
  const state = { selectedPath: 'state.md', file: {}, draft: 'draft' }, captured = captureMemorySave(state);
  const saved = { path: 'state.md', text: 'saved', sha256: 'new' };
  state.file = saved; state.draft = saved.text;
  const git = deferred();
  assert.equal(memorySaveAppliedCurrent(captured, state, saved), true);
  state.draft = 'new edit'; git.resolve({ commit: null }); await git.promise;
  assert.equal(memorySaveAppliedCurrent(captured, state, saved), false);
  state.draft = saved.text; state.file = { ...saved };
  assert.equal(memorySaveAppliedCurrent(captured, state, saved), false);
  state.file = saved; state.selectedPath = 'identity.md';
  assert.equal(memorySaveAppliedCurrent(captured, state, saved), false);
});

test('the references warning starts at the Core warning threshold', () => {
  const value = tree(); value.root.children.find(file => file.path === 'references.md').size_bytes = 8192;
  const row = memoryBudgetRows(value, { limits: { 'references.md': 16384 }, warnings: { 'references.md': 8192 } }).find(row => row.path === 'references.md');
  assert.equal(row.warned, true); assert.equal(row.over, 0);
});
