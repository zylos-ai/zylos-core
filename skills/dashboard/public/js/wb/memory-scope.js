import { element, fallbackName, icon, platformOf } from './plain-text.js?v=105';

// Scope metadata is validated by Core's parseSessionGroup on the server.
/**
 * Multi-session instances have background upkeep writing memory per group. Until Core has a locked write
 * path, the editor always says a save may conflict with it; the tree lists groups only on such instances.
 */
export const memoryUpkeepNotice = tree => Array.isArray(tree?.sessionGroups) && tree.sessionGroups.length > 0;

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

/** Which part of memory a file belongs to: shared, a valid group, or an invalid group directory. */
export function memoryFileScope(tree, path) {
  if (typeof path !== 'string' || !path.startsWith('session-groups/')) return { kind: 'shared' };
  const key = path.split('/')[1];
  const group = (tree?.sessionGroups ?? []).find(row => row.sessionGroup === key);
  return group && path.split('/').length >= 3 ? { kind: 'group', group } : { kind: 'invalid' };
}

/**
 * Files under a directory as one flat list: a directory's own files come before the files in its subdirectories,
 * so the core files at the top (identity.md, references.md, state.md) lead the list. Dot files such as .gitkeep
 * are not memory content.
 */
export function memoryFlatFiles(node, files = []) {
  const children = node?.children ?? [];
  for (const child of children) if (child.type === 'file' && !String(child.name).startsWith('.')) files.push(child);
  for (const child of children) if (child.type === 'directory') memoryFlatFiles(child, files);
  return files;
}

const CHANNEL_ICON = { telegram: 'send', lark: 'msg', feishu: 'msg', wechat: 'msg', openmax: 'hex', 'web-console': 'monitor' };
export const memoryGroupIcon = group => group.sessionGroup === 'origin' ? 'origin' : CHANNEL_ICON[platformOf(group)] ?? 'msg';

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

/** "Later" in the conflict dialog: close it without saving; the draft stays in the editor and this browser. */
export function leaveMemoryConflict(memory) {
  memory.conflict = null;
}

/** Submit once. An unknown result permits one readback, never a write retry. */
export function captureMemorySave(memory) {
  return memory.saving ? null : { memory, file: memory.file, path: memory.selectedPath, draft: memory.draft };
}
export function memorySaveOwnerCurrent(captured, current) { return captured?.memory === current; }
export function memorySaveTargetCurrent(captured, current) { return memorySaveOwnerCurrent(captured, current) && captured.path === current.selectedPath; }
export function memorySaveAppliedCurrent(captured, current, saved) {
  return memorySaveTargetCurrent(captured, current) && current.file === saved;
}
export function memorySaveCurrent(captured, current) {
  return memorySaveTargetCurrent(captured, current) && captured.file === current.file;
}

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
  function updateFile(node) {
    if (!node) return;
    if (node.type === 'file' && node.path === saved.path) Object.assign(node, { size_bytes: saved.size_bytes, mtime: saved.mtime });
    else for (const child of node.children ?? []) updateFile(child);
  }
  updateFile(current.tree?.root);
  return true;
}

// Re-rendering rebuilds the textarea. Keep its selection and scroll position;
// focus returns only when the editor had it. Selection is restored first
// because setting it can scroll the caret into view.
export function renderMemoryPreservingEditor(render, document) {
  const editor = document.querySelector('#memory-editor');
  const focused = editor && document.activeElement === editor;
  const selection = editor ? [editor.selectionStart, editor.selectionEnd, editor.selectionDirection] : null;
  const scroll = editor ? [editor.scrollTop, editor.scrollLeft] : null;
  render();
  const replacement = editor ? document.querySelector('#memory-editor') : null;
  if (!replacement) return;
  if (focused) replacement.focus?.();
  if (Number.isInteger(selection[0]) && Number.isInteger(selection[1])) replacement.setSelectionRange?.(selection[0], selection[1], selection[2]);
  if (Number.isFinite(scroll[0])) replacement.scrollTop = scroll[0];
  if (Number.isFinite(scroll[1])) replacement.scrollLeft = scroll[1];
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

export function applyMemoryWriteAccess(edit, save, tree, path) {
  if (memoryWriteAllowed(tree, path)) return;
  if (edit) { edit.hidden = true; edit.disabled = true; }
  if (save) save.disabled = true;
}

const byteSize = value => `${(Number(value) / 1024).toFixed(1)} KiB`;

// C4 timestamps are UTC even when their SQLite text omits the offset.
const millis = value => typeof value !== 'string' || !value ? NaN
  : Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);
/**
 * Backlog rows in reading order. Groups that need a look come first: long-waiting ones, then by pending count
 * (unknown counts after known ones), oldest first on ties. Groups with nothing pending and nothing to report
 * are set apart so a page with many groups can fold them. `threshold` is the one most groups share; rows with a
 * different one keep it as `ownThreshold`.
 */
export function memoryBacklogView(rows) {
  const tally = new Map();
  for (const row of rows ?? []) if (isNumber(row.threshold)) tally.set(row.threshold, (tally.get(row.threshold) ?? 0) + 1);
  const threshold = [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
  const quiet = [], active = [];
  for (const row of rows ?? []) {
    const view = { ...row, ownThreshold: isNumber(row.threshold) && row.threshold !== threshold ? row.threshold : null };
    (row.count === 0 && !row.aged && row.syncing === false && !row.reason ? quiet : active).push(view);
  }
  const first = row => { const value = millis(row.firstAt); return Number.isFinite(value) ? value : Infinity; };
  active.sort((a, b) => Number(Boolean(b.aged)) - Number(Boolean(a.aged))
    || (isNumber(b.count) ? b.count : -1) - (isNumber(a.count) ? a.count : -1) || first(a) - first(b));
  return { threshold, active, quiet };
}
/** How long the oldest pending message has waited, in whole hours or days; null without a readable time. */
export function memoryBacklogAge(firstAt, now = Date.now()) {
  const waited = now - millis(firstAt);
  if (!Number.isFinite(waited) || waited < 0) return null;
  const hours = Math.floor(waited / 3600e3);
  return hours >= 48 ? { unit: 'days', count: Math.floor(hours / 24) } : { unit: 'hours', count: hours };
}
const isNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
// Past this many groups the backlog card offers a name filter.
const BACKLOG_FILTER_AT = 12;

// Browsing is ordinary UI. Progress and file budgets belong to technical details;
// the ordinary view gets a one-line summary instead.
export function createMemoryScope({ document = globalThis.document, root, chartsRoot, listRoot = null, summaryRoot = null,
  t = key => key, request, getTree = () => null, getFile = () => null, onChange = () => {},
  onGroup = () => {}, onFile = () => {}, detail = () => document.documentElement.dataset.detail,
  identity = () => 'local', selectedPath = () => getFile()?.path ?? null, isCollapsed = () => false,
  toggleCollapsed = () => {}, fileTitle = () => '', sizeText = byteSize } = {}) {
  let selected = 'all', selectedGroup = '', backlog = null, loaded = false, owner = identity(), generation = 0, stopped = false,
    query = '', backlogQuery = '', restOpen = false;
  const search = element(document, 'input', undefined, 'wb-input');
  search.type = 'search';
  search.addEventListener('input', () => {
    query = search.value;
    renderList();
  });
  // Kept across redraws so typing in the group filter keeps focus while only the rows refresh.
  const backlogSearch = element(document, 'input', undefined, 'wb-input');
  backlogSearch.type = 'search';
  backlogSearch.addEventListener('input', () => { backlogQuery = backlogSearch.value; renderBacklogRows(); });
  const backlogFilter = element(document, 'label', undefined, 'wb-search wb-memory-gfilter');
  backlogFilter.append(icon(document, 'search', 'xs'), backlogSearch);
  const backlogRows = element(document, 'div', undefined, 'wb-memory-rows');
  const searchWrap = element(document, 'label', undefined, 'wb-search wb-memory-search');
  searchWrap.append(icon(document, 'search', 'xs'), search);
  function currentScope() { return memoryScope(getTree()); }
  function syncIdentity() {
    if (owner !== identity()) {
      owner = identity(); selected = 'all'; selectedGroup = ''; backlog = null; loaded = false; generation++;
    }
  }
  function selectGroup(key) {
    syncIdentity();
    selected = 'groups'; selectedGroup = key ?? '';
    onGroup(key == null ? null : `session-groups/${key}`);
    onChange();
  }
  function clearGroup() {
    selectedGroup = '';
    onGroup(null);
    onChange();
  }
  function tree(value) {
    syncIdentity();
    const partition = memoryScope(value);
    const groups = selectedGroup ? partition.groups.filter(group => group.sessionGroup === selectedGroup) : partition.groups;
    const groupDirs = groups.map(group => ({ ...group.directory, name: memoryGroupLabel(group, t) }));
    if (selected === 'shared') return partition.shared;
    if (selected === 'all') return { ...partition.shared, children: [...partition.shared.children, ...groupDirs] };
    return { ...value?.root, path: '', type: 'directory', children: groupDirs };
  }
  function initialPath(value, previousPath, preferredPath) {
    const scoped = tree(value);
    const contains = node => node.path === previousPath && node.type === 'file' || (node.children ?? []).some(contains);
    return contains(scoped) ? previousPath : preferredPath(scoped);
  }
  function button(parent, text, handler, className) {
    const node = element(document, 'button', text, className); node.type = 'button'; node.addEventListener('click', handler); parent.append(node); return node;
  }
  const backlogRow = key => backlog?.groups?.find(row => row.sessionGroup === key) ?? null;
  /** Section keys that fold, in display order; the caller keeps the folded set. */
  function sectionKeys() {
    const keys = selected === 'groups' ? [] : ['shared'];
    if (selected !== 'shared') for (const group of currentScope().groups) keys.push(`session-groups/${group.sessionGroup}`);
    return keys;
  }
  function render() {
    if (!root || stopped) return;
    syncIdentity();
    root.replaceChildren();
    const nav = element(document, 'div', undefined, 'wb-seg wb-memory-scopes');
    nav.setAttribute('role', 'group'); nav.setAttribute('aria-label', t('wb.memory.scope'));
    for (const [value, label] of [['all', 'wb.memory.all'], ['shared', 'wb.memory.shared'], ['groups', 'wb.memory.groups']]) {
      const item = button(nav, t(label), () => {
        if (value === 'groups') return selectGroup(selectedGroup || null);
        selected = value; onChange();
      }, selected === value ? 'active' : '');
      item.setAttribute('aria-pressed', String(selected === value));
    }
    root.append(nav);
    const filters = element(document, 'div', undefined, 'wb-memory-filter');
    const select = element(document, 'select', undefined, 'wb-input wb-select');
    select.setAttribute('aria-label', t('wb.memory.filter'));
    const all = element(document, 'option', t('wb.memory.allGroups')); all.value = ''; select.append(all);
    for (const group of currentScope().groups) {
      const option = element(document, 'option', memoryGroupLabel(group, t)); option.value = group.sessionGroup; select.append(option);
    }
    if (selectedGroup && !currentScope().groups.some(group => group.sessionGroup === selectedGroup)) {
      const missing = element(document, 'option', fallbackName({ sessionGroup: selectedGroup }, t)); missing.value = selectedGroup; select.append(missing);
    }
    select.value = selectedGroup; select.addEventListener('change', () => select.value ? selectGroup(select.value) : clearGroup());
    select.disabled = selected === 'shared';
    const selectWrap = element(document, 'span', undefined, 'wb-select-wrap');
    const caret = icon(document, 'chev', 'xs');
    selectWrap.append(select, caret);
    search.placeholder = t('wb.memory.search');
    search.setAttribute('aria-label', t('wb.memory.search'));
    filters.append(selectWrap, searchWrap);
    root.append(filters);
    if (selectedGroup && !currentScope().groups.some(group => group.sessionGroup === selectedGroup)) root.append(element(document, 'p', t('wb.memory.noGroupFiles'), 'empty-state'));
    if (currentScope().shared.children.some(node => node.path === 'session-groups')) root.append(element(document, 'p', t('wb.memory.invalidGroup'), 'wb-memory-diagnostic'));
    const file = getFile();
    if (file && !memoryWriteAllowed(getTree(), file.path)) {
      root.append(element(document, 'p', t('wb.memory.invalidGroupFile'), 'wb-memory-diagnostic'));
    }
    renderList();
    renderSummary();
    renderCharts();
  }
  function fileButton(parent, node, prefix, sizeClass = '') {
    const item = button(parent, undefined, () => onFile(node.path),
      'memory-file' + (selectedPath() === node.path ? ' active' : ''));
    item.dataset.path = node.path;
    item.disabled = !node.renderable;
    item.title = fileTitle(node);
    const name = element(document, 'span', undefined, 'memory-file-name');
    if (prefix) name.append(element(document, 'span', prefix, 'memory-file-dir'));
    name.append(element(document, 'span', node.name));
    item.append(icon(document, 'book', 'xs'), name,
      element(document, 'span', isNumber(node.size_bytes) ? sizeText(node.size_bytes) : '', 'memory-file-meta' + sizeClass));
    return item;
  }
  function renderList() {
    if (!listRoot || stopped) return;
    const value = getTree();
    listRoot.replaceChildren();
    if (!value) { listRoot.append(element(document, 'p', t('memory.loading'), 'empty-state')); return; }
    const scope = memoryScope(value);
    const needle = query.trim().toLowerCase();
    const matches = node => !needle || String(node.path).toLowerCase().includes(needle);
    let shown = 0;
    if (selected !== 'groups') {
      const budgets = new Map(memoryBudgetRows(value, backlog?.budgets).map(row => [row.path, row]));
      const files = memoryFlatFiles(scope.shared).filter(matches);
      if (files.length) {
        const section = element(document, 'div', undefined, 'wb-memory-section');
        const head = button(section, undefined, () => toggleCollapsed('shared'), 'wb-memory-section-h');
        head.setAttribute('aria-expanded', String(!isCollapsed('shared')));
        head.append(icon(document, 'chev', 'xs'), element(document, 'span', t('wb.memory.sharedTitle')));
        if (!isCollapsed('shared') || needle) {
          for (const node of files) {
            const slash = node.path.lastIndexOf('/');
            const budget = budgets.get(node.path);
            fileButton(section, node, slash < 0 ? '' : node.path.slice(0, slash + 1),
              budget?.over > 0 || budget?.warned ? ' wb-txt-warn' : '');
          }
        }
        listRoot.append(section);
        shown += files.length;
      }
    }
    if (selected !== 'shared') {
      const groups = selectedGroup ? scope.groups.filter(group => group.sessionGroup === selectedGroup) : scope.groups;
      const blocks = [];
      for (const group of groups) {
        const files = memoryFlatFiles(group.directory).filter(matches);
        const label = memoryGroupLabel(group, t);
        if (needle && !files.length && !label.toLowerCase().includes(needle)) continue;
        const key = `session-groups/${group.sessionGroup}`;
        const block = element(document, 'div', undefined, 'wb-memory-group');
        const head = button(block, undefined, () => toggleCollapsed(key), 'wb-memory-group-h');
        head.setAttribute('aria-expanded', String(!isCollapsed(key)));
        const name = element(document, 'span', undefined, 'wb-memory-group-name');
        name.append(element(document, 'b', label));
        if (detail() === 'technical') name.append(element(document, 'span', group.sessionGroup, 'wb-mono'));
        head.append(icon(document, memoryGroupIcon(group), 'xs'), name);
        const row = backlogRow(group.sessionGroup);
        if (row?.syncing === true) {
          const badge = element(document, 'span', undefined, 'wb-memory-badge');
          badge.append(icon(document, 'loader', 'xs'), element(document, 'span', t('wb.memory.syncing')));
          head.append(badge);
        } else if (isNumber(row?.count) && row.count > 0) {
          head.append(element(document, 'span', t('wb.memory.pending', { count: row.count }), 'wb-memory-count'));
        }
        if (!isCollapsed(key) || needle) for (const node of files) fileButton(block, node, '');
        blocks.push(block);
        shown += files.length;
      }
      if (blocks.length) {
        listRoot.append(element(document, 'p', t('wb.memory.groupsTitle'), 'wb-memory-list-h'), ...blocks);
      }
    }
    if (!shown && needle) listRoot.append(element(document, 'p', t('wb.memory.noMatch'), 'empty-state'));
  }
  function renderSummary() {
    if (!summaryRoot || stopped) return;
    summaryRoot.replaceChildren();
    summaryRoot.hidden = detail() === 'technical' || !getTree();
    if (summaryRoot.hidden) return;
    const rows = backlog?.groups ?? [];
    const unknown = !backlog || rows.some(row => row.count == null || row.syncing === null);
    const late = rows.some(row => row.aged);
    const waiting = rows.filter(row => isNumber(row.count) && row.count > 0).length;
    const syncing = rows.filter(row => row.syncing === true).length;
    summaryRoot.className = 'wb-memory-summary' + (late ? ' wb-warn' : '');
    summaryRoot.append(icon(document, late ? 'alert' : unknown ? 'help' : 'check', 'xs'),
      element(document, 'b', t(!loaded ? 'memory.loading' : late ? 'wb.memory.summaryLate' : unknown ? 'wb.memory.summaryUnknown' : 'wb.memory.summaryOk')));
    if (syncing) summaryRoot.append(element(document, 'span', t('wb.memory.summarySyncing', { count: syncing })));
    if (waiting) summaryRoot.append(element(document, 'span', t('wb.memory.summaryWaiting', { count: waiting })));
    summaryRoot.append(element(document, 'span', t('wb.memory.summaryTech'), 'wb-sub'));
  }
  function chartCard(className, iconName, title, hint) {
    const card = element(document, 'section', undefined, className + ' wb-memory-card');
    const head = element(document, 'h3');
    head.append(icon(document, iconName, 'xs'), element(document, 'span', title), element(document, 'small', hint));
    card.append(head);
    return card;
  }
  function backlogItem(row) {
    const meta = { ...(getTree()?.sessionGroups ?? []).find(group => group.sessionGroup === row.sessionGroup), ...row };
    const item = element(document, 'div', undefined, 'wb-memory-chart-row wb-memory-bl');
    // Name and its badges share one cell: one line beside the bar on wide screens, a line of its own on phones.
    const head = element(document, 'span', undefined, 'wb-memory-bl-head');
    const label = memoryGroupLabel(meta, t);
    const name = button(head, label, () => selectGroup(row.sessionGroup), 'wb-memory-chart-label');
    name.title = label === row.sessionGroup ? label : `${label}\n${row.sessionGroup}`;
    const over = isNumber(row.count) && isNumber(row.threshold) && row.count > row.threshold;
    const value = isNumber(row.count) ? String(row.count) : t('wb.unknown');
    const track = element(document, 'div', undefined, 'wb-memory-track');
    if (isNumber(row.count)) {
      const max = Math.max(row.count, isNumber(row.threshold) ? row.threshold * 1.25 : 0, 1);
      const fill = element(document, 'span', undefined, 'wb-memory-fill' + (over ? ' warning' : ''));
      fill.style.width = `${100 * row.count / max}%`; track.append(fill);
      if (isNumber(row.threshold)) {
        const line = element(document, 'span', undefined, 'wb-memory-threshold'); line.style.left = `${100 * row.threshold / max}%`;
        line.title = t('wb.memory.threshold', { count: row.threshold }); track.append(line);
        track.setAttribute('aria-label', t('wb.memory.countThreshold', { count: row.count, threshold: row.threshold }));
      } else track.setAttribute('aria-label', value);
    }
    const flags = element(document, 'span', undefined, 'wb-memory-flags');
    if (row.aged) {
      const age = memoryBacklogAge(row.firstAt);
      flags.append(element(document, 'span', age ? t(age.unit === 'days' ? 'wb.memory.agedDays' : 'wb.memory.agedHours', { count: age.count }) : t('wb.memory.aged'), 'wb-memory-bl-tag warn'));
    }
    if (row.syncing === true) flags.append(element(document, 'span', t('wb.memory.syncing'), 'wb-memory-bl-tag'));
    else if (row.syncing === null) flags.append(element(document, 'span', t('wb.memory.syncUnknown'), 'wb-memory-bl-tag'));
    if (row.ownThreshold != null) flags.append(element(document, 'span', t('wb.memory.threshold', { count: row.ownThreshold }), 'wb-memory-bl-tag'));
    if (row.reason) flags.append(element(document, 'small', row.reason, 'wb-memory-bl-tag'));
    head.append(flags);
    item.append(head, track, element(document, 'span', value, 'wb-memory-chart-value' + (over ? ' wb-txt-warn' : '')));
    return item;
  }
  function renderBacklogRows() {
    if (stopped) return;
    backlogRows.replaceChildren();
    const view = memoryBacklogView(backlog?.groups);
    const needle = backlogQuery.trim().toLowerCase();
    const match = row => !needle || row.sessionGroup.toLowerCase().includes(needle)
      || memoryGroupLabel({ ...(getTree()?.sessionGroups ?? []).find(group => group.sessionGroup === row.sessionGroup), ...row }, t).toLowerCase().includes(needle);
    const active = view.active.filter(match), quiet = view.quiet.filter(match);
    for (const row of active) backlogRows.append(backlogItem(row));
    // A search shows every match; otherwise groups with nothing pending fold into one line.
    if (needle) for (const row of quiet) backlogRows.append(backlogItem(row));
    else if (quiet.length) {
      const rest = element(document, 'details', undefined, 'wb-memory-rest');
      rest.open = restOpen;
      rest.addEventListener('toggle', () => { restOpen = rest.open; });
      const summary = element(document, 'summary', undefined, 'wb-memory-rest-h');
      summary.append(icon(document, 'chev', 'xs'), element(document, 'span', t(active.length ? 'wb.memory.restQuiet' : 'wb.memory.allQuiet', { count: quiet.length })));
      rest.append(summary);
      for (const row of quiet) rest.append(backlogItem(row));
      backlogRows.append(rest);
    }
    if (needle && !active.length && !quiet.length) backlogRows.append(element(document, 'p', t('wb.memory.noMatch'), 'wb-memory-source'));
  }
  function renderCharts() {
    if (!chartsRoot || stopped) return;
    chartsRoot.replaceChildren();
    chartsRoot.hidden = detail() !== 'technical';
    if (chartsRoot.hidden) return;
    const view = memoryBacklogView(backlog?.groups);
    const progress = chartCard('wb-memory-progress', 'layers', t('wb.memory.backlog'),
      view.threshold == null ? t('wb.memory.backlogHint') : t('wb.memory.thresholdHint', { count: view.threshold }));
    if (!backlog) progress.append(element(document, 'p', t('wb.unknown')));
    else {
      const many = view.active.length + view.quiet.length > BACKLOG_FILTER_AT;
      if (many) { backlogSearch.placeholder = t('wb.memory.filterGroups'); backlogSearch.setAttribute('aria-label', t('wb.memory.filterGroups')); progress.append(backlogFilter); }
      else backlogQuery = backlogSearch.value = '';
      progress.append(backlogRows);
      renderBacklogRows();
    }
    if (backlog?.hasOlder === true) progress.append(element(document, 'p', t('wb.older'), 'wb-memory-source'));
    progress.append(element(document, 'p', t('wb.memory.backlogSource'), 'wb-memory-source'));
    chartsRoot.append(progress);
    const budgets = chartCard('wb-memory-budgets', 'book', t('wb.memory.budgets'), t('wb.memory.budgetHint'));
    for (const row of memoryBudgetRows(getTree(), backlog?.budgets)) {
      const item = element(document, 'div', undefined, 'wb-memory-chart-row');
      button(item, row.path, () => onFile(row.path), 'wb-memory-chart-label');
      const track = element(document, 'div', undefined, 'wb-memory-track');
      if (isNumber(row.limit)) {
        const max = Math.max(row.limit, row.size, 1);
        const fill = element(document, 'span', undefined, 'wb-memory-fill' + (row.warned ? ' warning' : ''));
        fill.style.width = `${100 * Math.min(row.size, row.limit) / max}%`; track.append(fill);
        if (row.over > 0) {
          const excess = element(document, 'span', undefined, 'wb-memory-fill excess'); excess.style.width = `${100 * row.over / max}%`; track.append(excess);
        }
        if (isNumber(row.warning)) { const warning = element(document, 'span', undefined, 'wb-memory-threshold'); warning.style.left = `${100 * row.warning / max}%`; warning.title = t('wb.memory.warnAt', { size: byteSize(row.warning) }); track.append(warning); }
        track.setAttribute('aria-label', t('wb.memory.sizeBudget', { size: byteSize(row.size), budget: byteSize(row.limit) }));
      }
      item.append(track, element(document, 'span', byteSize(row.size) + (isNumber(row.limit) ? ' / ' + byteSize(row.limit) : ''), 'wb-memory-chart-value'));
      const flags = element(document, 'span', undefined, 'wb-memory-flags');
      if (row.over > 0) flags.append(element(document, 'span', t('wb.memory.overBudget', { size: byteSize(row.over) }), 'wb-memory-warning'));
      else if (row.warned) flags.append(element(document, 'span', t('wb.memory.warning'), 'wb-memory-warning'));
      item.append(flags);
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
      backlog = value; loaded = true; owner = captured; render();
    } catch {
      if (!stopped && operation === generation && captured === identity()) { backlog = null; loaded = true; render(); }
    }
  }
  // The page redraws this view when the detail level or language changes (app.js renderMemory).
  return { tree, render, renderList, load, selectGroup, initialPath, sectionKeys, destroy() {
    stopped = true; generation++;
    root?.replaceChildren(); chartsRoot?.replaceChildren(); listRoot?.replaceChildren(); summaryRoot?.replaceChildren();
  } };
}
