import { element, fallbackName } from './plain-text.js?v=85';

// Scope metadata is validated by Core's parseSessionGroup on the server.
export function memoryScope(tree) {
  const root = tree?.root ?? { path: '', type: 'directory', children: [] };
  const metadata = new Map((tree?.sessionGroups ?? []).map(row => [row.sessionGroup, row]));
  const shared = [], groups = [];
  for (const child of root.children ?? []) {
    if (child.path !== 'session-groups' || child.type !== 'directory') { shared.push(child); continue; }
    const invalid = [];
    for (const directory of child.children ?? []) {
      const meta = directory.type === 'directory' && metadata.get(directory.name);
      if (meta) groups.push({ ...meta, directory });
      else invalid.push({ ...directory, diagnostic: 'invalid_session_group' });
    }
    if (invalid.length) shared.push({ ...child, children: invalid });
  }
  return { shared: { ...root, children: shared }, groups };
}

export function memoryGroupLabel(group, t) {
  return group.displayName || fallbackName(group, t);
}

export function memoryBudgetRows(tree, budgets) {
  const files = tree?.root?.children ?? [];
  return ['identity.md', 'references.md', 'state.md'].flatMap(path => {
    const file = files.find(node => node.path === path && node.type === 'file');
    if (!file) return [];
    const limit = path === 'state.md' ? null : budgets?.limits?.[path] ?? null;
    const warning = path === 'state.md' ? null : budgets?.warnings?.[path] ?? null;
    return [{ path, size: file.size_bytes, limit, warning,
      over: limit == null ? null : Math.max(0, file.size_bytes - limit),
      warned: warning == null ? null : file.size_bytes > warning }];
  });
}

export function memoryWriteMessage(code, t) {
  const keys = {
    memory_sync_busy: 'syncBusy', memory_lock_timeout: 'lockTimeout',
    memory_write_unavailable: 'writeUnavailable', memory_write_failed: 'writeFailed',
    memory_write_unknown: 'writeUnknown',
  };
  return keys[code] ? t('wb.memory.' + keys[code]) : null;
}

/** Submit once. An unknown result permits one readback, never a write retry. */
export function captureMemorySave(memory) {
  return memory.saving ? null : { memory, path: memory.selectedPath, draft: memory.draft };
}
export function memorySaveOwnerCurrent(captured, current) { return captured?.memory === current; }
export function memorySaveTargetCurrent(captured, current) { return memorySaveOwnerCurrent(captured, current) && captured.path === current.selectedPath; }
export function memorySaveAppliedCurrent(captured, current, saved) {
  return memorySaveTargetCurrent(captured, current) && current.file === saved;
}
export const memorySaveCurrent = memorySaveTargetCurrent;

export function applyMemorySave(captured, current, saved) {
  if (!memorySaveCurrent(captured, current)) return false;
  if (current.draft === captured.draft) current.draft = saved.text;
  current.file = saved;
  current.dirty = current.draft !== saved.text;
  current.editing = current.dirty;
  current.draftNotice = false;
  current.conflict = null;
  current.conflictRetryText = '';
  current.liveNotice = null;
  return true;
}

export async function saveMemoryOnce({ request, readFile, path, text, sha256, isCurrent = () => true }) {
  try {
    const saved = await request(`/api/memory/file?path=${encodeURIComponent(path)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, sha256 }),
    });
    return isCurrent() ? saved : null;
  } catch (error) {
    if (!isCurrent()) return null;
    if (error.code !== 'memory_write_unknown') throw error;
    const latest = await readFile(`/api/memory/file?path=${encodeURIComponent(path)}`).catch(() => null);
    if (!isCurrent()) return null;
    if (latest?.path === path && latest.text === text) return latest;
    throw error;
  }
}

export function memoryWriteAllowed(tree, path) {
  if (typeof path !== 'string') return false;
  if (!path.startsWith('session-groups/')) return true;
  const parts = path.split('/');
  return parts.length >= 3 && (tree?.sessionGroups ?? []).some(group => group.sessionGroup === parts[1]);
}

const byteSize = value => `${(Number(value) / 1024).toFixed(1)} KiB`;
const isNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Browsing is ordinary UI. Progress and file budgets belong to technical details.
export function createMemoryScope({ document = globalThis.document, root, chartsRoot,
  t = key => key, request, getTree = () => null, getFile = () => null, onChange = () => {},
  onGroup = () => {}, onFile = () => {}, detail = () => document.documentElement.dataset.detail,
  identity = () => 'local' } = {}) {
  let selected = 'shared', selectedGroup = '', backlog = null, owner = identity(), generation = 0, stopped = false;
  function currentScope() { return memoryScope(getTree()); }
  function syncIdentity() {
    if (owner !== identity()) { owner = identity(); selected = 'shared'; selectedGroup = ''; backlog = null; generation++; }
  }
  function selectGroup(key) {
    syncIdentity();
    selected = 'groups'; selectedGroup = key ?? '';
    onGroup(key == null ? null : `session-groups/${key}`);
    onChange();
  }
  function tree(value) {
    syncIdentity();
    const partition = memoryScope(value);
    if (selected === 'shared') return partition.shared;
    const groups = selectedGroup ? partition.groups.filter(group => group.sessionGroup === selectedGroup) : partition.groups;
    return { ...value?.root, path: '', type: 'directory', children: groups.map(group => ({ ...group.directory, name: memoryGroupLabel(group, t) })) };
  }
  function initialPath(value, previousPath, preferredPath) {
    const scoped = tree(value);
    const contains = node => node.path === previousPath && node.type === 'file' || (node.children ?? []).some(contains);
    return contains(scoped) ? previousPath : preferredPath(scoped);
  }
  function button(parent, text, handler, className) {
    const node = element(document, 'button', text, className); node.type = 'button'; node.addEventListener('click', handler); parent.append(node); return node;
  }
  function render() {
    if (!root || stopped) return;
    syncIdentity();
    root.replaceChildren();
    const nav = element(document, 'div', undefined, 'wb-memory-scopes');
    nav.setAttribute('role', 'group'); nav.setAttribute('aria-label', t('wb.memory.scope'));
    button(nav, t('wb.memory.shared'), () => { selected = 'shared'; selectedGroup = ''; onChange(); }, selected === 'shared' ? 'active' : '');
    button(nav, t('wb.memory.groups'), () => selectGroup(null), selected === 'groups' ? 'active' : '');
    root.append(nav);
    if (selected === 'groups') {
      const label = element(document, 'label', t('wb.memory.filter'), 'wb-memory-filter');
      const select = element(document, 'select');
      const all = element(document, 'option', t('wb.memory.allGroups')); all.value = ''; select.append(all);
      for (const group of currentScope().groups) {
        const option = element(document, 'option', memoryGroupLabel(group, t)); option.value = group.sessionGroup; select.append(option);
      }
      if (selectedGroup && !currentScope().groups.some(group => group.sessionGroup === selectedGroup)) {
        const missing = element(document, 'option', fallbackName({ sessionGroup: selectedGroup }, t)); missing.value = selectedGroup; select.append(missing);
      }
      select.value = selectedGroup; select.addEventListener('change', () => selectGroup(select.value || null));
      label.append(select); root.append(label);
      if (selectedGroup && !currentScope().groups.some(group => group.sessionGroup === selectedGroup)) root.append(element(document, 'p', t('wb.memory.noGroupFiles'), 'empty-state'));
    }
    if (currentScope().shared.children.some(node => node.path === 'session-groups')) root.append(element(document, 'p', t('wb.memory.invalidGroup'), 'wb-memory-diagnostic'));
    const file = getFile();
    if (file && !memoryWriteAllowed(getTree(), file.path)) {
      const edit = document.querySelector?.('#memory-edit-btn'), save = document.querySelector?.('#memory-save-btn');
      if (edit) { edit.hidden = true; edit.disabled = true; }
      if (save) save.disabled = true;
      root.append(element(document, 'p', t('wb.memory.invalidGroupFile'), 'wb-memory-diagnostic'));
    }
    renderCharts();
  }
  function renderCharts() {
    if (!chartsRoot || stopped) return;
    chartsRoot.replaceChildren();
    chartsRoot.hidden = detail() !== 'technical';
    if (chartsRoot.hidden) return;
    const progress = element(document, 'section', undefined, 'wb-memory-progress');
    progress.append(element(document, 'h3', t('wb.memory.backlog')));
    if (!backlog) progress.append(element(document, 'p', t('wb.unknown')));
    for (const row of backlog?.groups ?? []) {
      const meta = { ...(getTree()?.sessionGroups ?? []).find(group => group.sessionGroup === row.sessionGroup), ...row };
      const item = element(document, 'div', undefined, 'wb-memory-chart-row');
      const name = button(item, memoryGroupLabel(meta, t), () => selectGroup(row.sessionGroup), 'wb-memory-chart-label');
      name.title = row.sessionGroup;
      const value = isNumber(row.count) ? String(row.count) : t('wb.unknown');
      item.append(element(document, 'span', value, 'wb-memory-chart-value'));
      if (isNumber(row.count)) {
        const track = element(document, 'div', undefined, 'wb-memory-track');
        const max = Math.max(row.count, isNumber(row.threshold) ? row.threshold * 1.25 : 0, 1);
        const fill = element(document, 'span', undefined, 'wb-memory-fill' + (isNumber(row.threshold) && row.count > row.threshold ? ' warning' : ''));
        fill.style.width = `${100 * row.count / max}%`; track.append(fill);
        if (isNumber(row.threshold)) {
          const line = element(document, 'span', undefined, 'wb-memory-threshold'); line.style.left = `${100 * row.threshold / max}%`;
          line.title = t('wb.memory.threshold', { count: row.threshold }); track.append(line);
          track.setAttribute('aria-label', t('wb.memory.countThreshold', { count: row.count, threshold: row.threshold }));
        } else track.setAttribute('aria-label', value);
        item.append(track);
      }
      item.append(element(document, 'span', row.syncing === true ? t('wb.memory.syncing') : row.syncing === null ? t('wb.memory.syncUnknown') : '', 'wb-memory-sync'));
      if (row.aged) item.append(element(document, 'span', t('wb.memory.aged'), 'wb-memory-warning'));
      if (row.reason) item.append(element(document, 'small', row.reason));
      progress.append(item);
    }
    if (backlog?.hasOlder === true) progress.append(element(document, 'p', t('wb.older')));
    progress.append(element(document, 'p', t('wb.memory.backlogSource'), 'wb-memory-source'));
    chartsRoot.append(progress);
    const budgets = element(document, 'section', undefined, 'wb-memory-budgets');
    budgets.append(element(document, 'h3', t('wb.memory.budgets')));
    for (const row of memoryBudgetRows(getTree(), backlog?.budgets)) {
      const item = element(document, 'div', undefined, 'wb-memory-chart-row');
      button(item, row.path, () => onFile(row.path), 'wb-memory-chart-label');
      item.append(element(document, 'span', byteSize(row.size) + (isNumber(row.limit) ? ' / ' + byteSize(row.limit) : ''), 'wb-memory-chart-value'));
      if (isNumber(row.limit)) {
        const track = element(document, 'div', undefined, 'wb-memory-track');
        const max = Math.max(row.limit, row.size, 1);
        const fill = element(document, 'span', undefined, 'wb-memory-fill' + (row.warned ? ' warning' : ''));
        fill.style.width = `${100 * Math.min(row.size, row.limit) / max}%`; track.append(fill);
        if (row.over > 0) {
          const excess = element(document, 'span', undefined, 'wb-memory-fill excess'); excess.style.width = `${100 * row.over / max}%`; track.append(excess);
        }
        if (isNumber(row.warning)) { const warning = element(document, 'span', undefined, 'wb-memory-threshold'); warning.style.left = `${100 * row.warning / max}%`; warning.title = t('wb.memory.warnAt', { size: byteSize(row.warning) }); track.append(warning); }
        track.setAttribute('aria-label', t('wb.memory.sizeBudget', { size: byteSize(row.size), budget: byteSize(row.limit) })); item.append(track);
      }
      if (row.over > 0) item.append(element(document, 'span', t('wb.memory.overBudget', { size: byteSize(row.over) }), 'wb-memory-warning'));
      else if (row.warned) item.append(element(document, 'span', t('wb.memory.warning'), 'wb-memory-warning'));
      budgets.append(item);
    }
    budgets.append(element(document, 'p', t('wb.memory.budgetSource'), 'wb-memory-source'));
    chartsRoot.append(budgets);
  }
  async function load() {
    const operation = ++generation, captured = identity();
    try {
      const value = await request('/api/workbench/memory/backlog');
      if (stopped || operation !== generation || captured !== identity()) return;
      backlog = value; owner = captured; render();
    } catch {
      if (!stopped && operation === generation && captured === identity()) { backlog = null; render(); }
    }
  }
  const toggle = document.querySelector?.('#wb-detail-toggle');
  const redraw = () => queueMicrotask(() => { if (!stopped) render(); });
  toggle?.addEventListener('change', redraw);
  document.addEventListener?.('dashboard-locale-change', redraw);
  return { tree, render, load, selectGroup, initialPath, destroy() {
    stopped = true; generation++;
    toggle?.removeEventListener('change', redraw);
    document.removeEventListener?.('dashboard-locale-change', redraw);
    root?.replaceChildren(); chartsRoot?.replaceChildren();
  } };
}
