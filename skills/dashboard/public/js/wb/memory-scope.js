import { countLabel } from '../count-label.js';
import { element, fallbackName, icon, platformOf } from './plain-text.js';
import { createMemoryEntries, GROUPS_DIR } from './memory-entries.js';

// Scope metadata is validated by Core's parseSessionGroup on the server; the page knows only what it has loaded
// (`known`, from memory-entries.js): the session groups it has seen, invalid group directories and the root files.
/**
 * Multi-session instances have background upkeep writing memory per group. Until Core has a locked write
 * path, the editor always says a save may conflict with it; such instances have session groups.
 */
export const memoryUpkeepNotice = known => (known?.groups?.size ?? 0) > 0;

export function memoryGroupLabel(group, t) {
  return group.displayName || fallbackName(group, t);
}

/**
 * Which part of memory a file belongs to: shared, a valid group, an invalid group directory, or unknown while the
 * file's group has not been loaded yet.
 */
export function memoryFileScope(known, path) {
  if (typeof path !== 'string' || !path.startsWith('session-groups/')) return { kind: 'shared' };
  const parts = path.split('/'), group = known?.groups?.get(parts[1]);
  if (group && parts.length >= 3) return { kind: 'group', group };
  if (parts.length < 3 || known?.invalid?.has(parts[1])) return { kind: 'invalid' };
  return { kind: 'unknown' };
}

const CHANNEL_ICON = { telegram: 'send', lark: 'msg', feishu: 'msg', wechat: 'msg', openmax: 'hex', 'web-console': 'monitor' };
export const memoryGroupIcon = group => group.sessionGroup === 'origin' ? 'origin' : CHANNEL_ICON[platformOf(group)] ?? 'msg';

/** The startup budget rows for the root files identity.md, references.md and state.md, from the root listing. */
export function memoryBudgetRows(rootFiles, budgets) {
  const files = rootFiles ?? [];
  return ['identity.md', 'references.md', 'state.md'].flatMap(path => {
    const file = files.find(node => node.path === path && node.type === 'file');
    if (!file) return [];
    const limit = path === 'state.md' ? null : budgets?.limits?.[path] ?? null;
    const warning = path === 'state.md' ? null : budgets?.warnings?.[path] ?? null;
    if (limit && typeof limit === 'object') {
      const check = budgets?.checks?.[path];
      if (!check) return [{ path, size: file.size_bytes, limit: null, warning: null, over: null, warned: null }];
      const usage = Math.max(check.chars / check.maxChars, check.estimatedTokens / check.maxTokens) * 100;
      return [{ path, check, size: usage, limit: 100, warning: 80,
        over: Math.max(0, usage - 100), warned: check.status !== 'ok' }];
    }
    return [{ path, size: file.size_bytes, limit, warning,
      over: limit == null ? null : Math.max(0, file.size_bytes - limit),
      warned: warning == null ? null : file.size_bytes > warning }];
  });
}

export function memoryWriteMessage(code, t) {
  const keys = {
    memory_sync_busy: 'syncBusy', memory_lock_timeout: 'lockTimeout',
    memory_write_unavailable: 'writeUnavailable', memory_write_failed: 'writeFailed',
    memory_write_unknown: 'writeUnknown', memory_write_empty: 'writeEmpty',
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

/** Applies a save; `updateFile` gives the saved file's new size and time to the loaded lists. */
export function applyMemorySave(captured, current, saved, updateFile = () => {}) {
  if (!memorySaveCurrent(captured, current)) return false;
  if (current.draft === captured.draft) current.draft = saved.text;
  current.file = saved;
  current.dirty = current.draft !== saved.text;
  current.editing = current.dirty;
  current.draftNotice = false;
  current.conflict = null;
  current.conflictRetryText = '';
  current.liveNotice = null;
  updateFile(saved.path, { size_bytes: saved.size_bytes, mtime: saved.mtime });
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
  if (text === '') throw Object.assign(new Error('Cannot save an empty memory file'), { code: 'memory_write_empty' });
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

/** Core saves shared files and files in a valid group directory; an unknown group stays read-only until loaded. */
export function memoryWriteAllowed(known, path) {
  if (typeof path !== 'string') return false;
  const { kind } = memoryFileScope(known, path);
  return kind === 'shared' || kind === 'group';
}

export function applyMemoryWriteAccess(edit, save, known, path) {
  if (memoryWriteAllowed(known, path)) return;
  if (edit) { edit.hidden = true; edit.disabled = true; }
  if (save) save.disabled = true;
}

const byteSize = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

// C4 timestamps are UTC even when their SQLite text omits the offset.
const millis = value => typeof value !== 'string' || !value ? NaN
  : Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);
/**
 * Loaded backlog rows, in the server's order (long-waiting groups first, then by pending count, oldest first). The
 * server lists only groups with something pending, a Sync running or a failed read. `threshold` is the one most
 * groups share (from the page's summary of the listed groups); rows with a different one keep it as `ownThreshold`.
 */
export function memoryBacklogView(rows, threshold = null) {
  return { threshold, rows: (rows ?? []).map(row => ({ ...row, ownThreshold: isNumber(row.threshold) && row.threshold !== threshold ? row.threshold : null })) };
}
/** How long the oldest pending message has waited, in whole hours or days; null without a readable time. */
export function memoryBacklogAge(firstAt, now = Date.now()) {
  const waited = now - millis(firstAt);
  if (!Number.isFinite(waited) || waited < 0) return null;
  const hours = Math.floor(waited / 3600e3);
  return hours >= 48 ? { unit: 'days', count: Math.floor(hours / 24) } : { unit: 'hours', count: hours };
}
const isNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
/**
 * A shared minimum width for the backlog count column when a count is shown as words ("Unknown"), so every
 * row's bar starts at the same place. Measured in `ch`, two per wide (CJK) character; the column still grows
 * to its content, so a low estimate only costs alignment, never a cut word. Empty when every count is a number.
 */
export function memoryBacklogValueWidth(rows, unknownLabel) {
  if (!(rows ?? []).some(row => !isNumber(row.count))) return '';
  const width = [...String(unknownLabel)].reduce((sum, char) => sum + (char.codePointAt(0) >= 0x2e80 ? 2 : 1), 0);
  return `${width + 1}ch`;
}
// Past this many groups the backlog card offers a name filter.
const BACKLOG_FILTER_AT = 12;
// Groups per backlog request, and how long the filter waits after the last keystroke before asking the server.
const BACKLOG_PAGE = 50;
const BACKLOG_SEARCH_DELAY = 300;
// The file search and the group picker ask the server once typing pauses; the list standard's q is at most 64
// characters, and the picker shows a few groups at a time.
const LIST_SEARCH_DELAY = 300;
const SEARCH_MAX = 64;
const PICKER_PAGE = 8;

// Browsing is ordinary UI. Progress and file budgets belong to technical details;
// the ordinary view gets a one-line summary instead.
// The file list reads memory one directory level at a time (memory-entries.js): the root and the session groups
// first, all folded; opening a directory or group reads its first page, and "Load more" the next.
export function createMemoryScope({ document = globalThis.document, root, chartsRoot, listRoot = null, summaryRoot = null,
  t = key => key, request, getFile = () => null, onChange = () => {},
  onFile = () => {}, detail = () => document.documentElement.dataset.detail,
  identity = () => 'local', selectedPath = () => getFile()?.path ?? null, fileTitle = () => '', sizeText = byteSize } = {}) {
  let selected = 'all', selectedGroup = '', backlog = null, loaded = false, owner = identity(), generation = 0, stopped = false,
    query = '', backlogQuery = '', backlogTimer = null, loadingMore = false, searchTimer = null,
    pickerQuery = '', pickerOpen = false, pickerTimer = null;
  let expanded = new Set();
  const entries = createMemoryEntries({ request, onChange: () => { if (!stopped) onChange(); } });
  const search = element(document, 'input');
  search.type = 'search';
  // The server searches; the results change once typing pauses.
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = search.value.trim().slice(0, SEARCH_MAX); renderList(); }, LIST_SEARCH_DELAY);
  });
  // The group picker: type part of a group's name; the server finds the groups.
  const picker = element(document, 'input', undefined, 'wb-input');
  picker.type = 'search';
  picker.autocomplete = 'off';
  const pickerList = element(document, 'div', undefined, 'wb-memory-picker-list');
  pickerList.setAttribute('role', 'listbox');
  // The list opens on a click, typing or ArrowDown, not on keyboard focus alone, so tabbing past the picker never
  // enters its choices.
  const openPicker = () => { if (pickerOpen) return; pickerOpen = true; picker.select?.(); renderPicker(); };
  picker.addEventListener('click', openPicker);
  picker.addEventListener('input', () => {
    pickerOpen = true;
    clearTimeout(pickerTimer);
    pickerTimer = setTimeout(() => { pickerQuery = picker.value.trim().slice(0, SEARCH_MAX); renderPicker(); }, LIST_SEARCH_DELAY);
  });
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape') { pickerOpen = false; renderPicker(); picker.blur?.(); }
    else if (event.key === 'ArrowDown' && !pickerOpen) { event.preventDefault?.(); openPicker(); }
  });
  const pickerWrap = element(document, 'div', undefined, 'wb-memory-picker');
  pickerWrap.addEventListener('focusout', event => {
    if (pickerWrap.contains(event.relatedTarget)) return;
    pickerOpen = false; pickerQuery = ''; renderPicker();
  });
  pickerWrap.append(picker, pickerList);
  // Pressing a choice keeps focus in the field (Safari does not focus a pressed button), so the list is still
  // there when the click arrives.
  pickerList.addEventListener('mousedown', event => event.preventDefault?.());
  // Kept across redraws so typing in the group filter keeps focus while only the rows refresh.
  const backlogSearch = element(document, 'input');
  backlogSearch.type = 'search';
  // The server searches every group; the rows change once typing pauses.
  backlogSearch.addEventListener('input', () => {
    clearTimeout(backlogTimer);
    backlogTimer = setTimeout(() => {
      if (backlogSearch.value.trim() === backlogQuery) return;
      backlogQuery = backlogSearch.value.trim();
      load();
    }, BACKLOG_SEARCH_DELAY);
  });
  const backlogFilter = element(document, 'label', undefined, 'wb-search wb-memory-gfilter');
  backlogFilter.append(icon(document, 'search', 'xs'), backlogSearch);
  const backlogRows = element(document, 'div', undefined, 'wb-memory-rows');
  const searchWrap = element(document, 'label', undefined, 'wb-search wb-memory-search');
  searchWrap.append(icon(document, 'search', 'xs'), search);
  function syncIdentity() {
    if (owner !== identity()) {
      owner = identity(); selected = 'all'; selectedGroup = ''; backlog = null; loaded = false; generation++;
      expanded = new Set(); query = ''; search.value = ''; entries.reset();
    }
  }
  const groupPath = key => `${GROUPS_DIR}/${key}`;
  // A group not on a loaded page is looked up by name: the server's search returns the group directory itself.
  const lookupSpec = key => ({ view: 'groups', q: key.slice(0, SEARCH_MAX), limit: 100 });
  function groupRow(key) {
    const known = entries.known();
    if (known.groups.has(key)) return known.groups.get(key);
    const list = entries.start(lookupSpec(key));
    return list.loading ? undefined : list.items.find(row => row.path === groupPath(key)) ?? null;
  }
  function selectGroup(key) {
    syncIdentity();
    selected = 'groups'; selectedGroup = key ?? '';
    if (key != null) expanded.add(groupPath(key));
    onChange();
  }
  function clearGroup() {
    selectedGroup = '';
    onChange();
  }
  function button(parent, text, handler, className) {
    const node = element(document, 'button', text, className); node.type = 'button'; node.addEventListener('click', handler); parent.append(node); return node;
  }
  function toggle(path) {
    if (expanded.has(path)) expanded.delete(path); else expanded.add(path);
    onChange();
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
    picker.placeholder = t('wb.memory.filter');
    picker.setAttribute('aria-label', t('wb.memory.filter'));
    picker.disabled = selected === 'shared';
    if (document.activeElement !== picker) {
      const row = selectedGroup ? groupRow(selectedGroup) : null;
      picker.value = selectedGroup ? (row ? memoryGroupLabel(row, t) : fallbackName({ sessionGroup: selectedGroup }, t)) : '';
    }
    renderPicker();
    search.placeholder = t('wb.memory.search');
    search.setAttribute('aria-label', t('wb.memory.search'));
    filters.append(pickerWrap, searchWrap);
    root.append(filters);
    if (selectedGroup && groupRow(selectedGroup) === null) root.append(element(document, 'p', t('wb.memory.noGroupFiles'), 'empty-state'));
    if (selected !== 'shared' && entries.known().invalid.size) root.append(element(document, 'p', t('wb.memory.invalidGroup'), 'wb-memory-diagnostic'));
    const file = getFile();
    if (file && memoryFileScope(entries.known(), file.path).kind === 'invalid') {
      root.append(element(document, 'p', t('wb.memory.invalidGroupFile'), 'wb-memory-diagnostic'));
    }
    renderList();
    renderSummary();
    renderCharts();
  }
  /** The picker's choices: the groups matching what is typed, a few at a time, with "All groups" first. */
  function renderPicker() {
    pickerList.replaceChildren();
    pickerList.hidden = !pickerOpen;
    if (!pickerOpen) return;
    const all = button(pickerList, t('wb.memory.allGroups'), () => { pickerOpen = false; picker.blur?.(); clearGroup(); }, 'wb-memory-picker-item');
    all.setAttribute('role', 'option');
    const list = entries.start({ view: 'groups', q: pickerQuery, limit: PICKER_PAGE });
    for (const row of list.items.filter(item => item.type === 'group')) {
      const item = button(pickerList, undefined, () => { pickerOpen = false; pickerQuery = ''; picker.blur?.(); selectGroup(row.sessionGroup); },
        'wb-memory-picker-item' + (row.sessionGroup === selectedGroup ? ' active' : ''));
      item.setAttribute('role', 'option');
      item.append(icon(document, memoryGroupIcon(row), 'xs'), element(document, 'span', memoryGroupLabel(row, t)));
      if (detail() === 'technical') item.append(element(document, 'span', row.sessionGroup, 'wb-mono'));
    }
    if (list.loading) pickerList.append(element(document, 'p', t('memory.loading'), 'wb-memory-source'));
    else if (list.error) pickerList.append(element(document, 'p', t('memory.error_generic'), 'wb-memory-diagnostic'));
    else if (!list.items.some(item => item.type === 'group')) pickerList.append(element(document, 'p', t('wb.memory.noMatch'), 'wb-memory-source'));
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
  /** A group's heading: icon, name, technical ID and its pending count or syncing badge. */
  function groupHead(parent, row, onClick, open) {
    const head = button(parent, undefined, onClick, 'wb-memory-group-h');
    head.dataset.collapseKey = row.path;
    if (open !== undefined) head.setAttribute('aria-expanded', String(open));
    const name = element(document, 'span', undefined, 'wb-memory-group-name');
    name.append(element(document, 'b', memoryGroupLabel(row, t)));
    if (detail() === 'technical') name.append(element(document, 'span', row.sessionGroup, 'wb-mono'));
    head.append(icon(document, memoryGroupIcon(row), 'xs'), name);
    const badge = row.backlog ?? null;
    if (badge?.syncing === true) {
      const node = element(document, 'span', undefined, 'wb-memory-badge');
      node.append(icon(document, 'loader', 'xs'), element(document, 'span', t('wb.memory.syncing')));
      head.append(node);
    } else if (isNumber(badge?.count) && badge.count > 0) {
      head.append(element(document, 'span', t('wb.memory.pending', { count: badge.count }), 'wb-memory-count'));
    }
    return head;
  }
  function groupBlock(parent, row, forceOpen = false) {
    const block = element(document, 'div', undefined, 'wb-memory-group');
    const open = forceOpen || expanded.has(row.path);
    groupHead(block, row, () => forceOpen ? null : toggle(row.path), open);
    if (open) renderDirectory(block, row.path);
    parent.append(block);
  }
  function directoryNode(parent, row) {
    const block = element(document, 'div', undefined, 'wb-memory-dir');
    const open = expanded.has(row.path);
    const head = button(block, undefined, () => toggle(row.path), 'wb-memory-dir-h');
    head.dataset.collapseKey = row.path;
    head.setAttribute('aria-expanded', String(open));
    head.append(icon(document, 'chev', 'xs'), element(document, 'span', `${row.name}/`));
    if (row.diagnostic) head.append(element(document, 'span', t('wb.memory.scopeInvalid'), 'wb-memory-bl-tag warn'));
    if (open) renderDirectory(block, row.path);
    parent.append(block);
  }
  function listState(parent, list, more) {
    if (list.loading) parent.append(element(document, 'p', t('memory.loading'), 'wb-memory-source'));
    else if (list.error) parent.append(element(document, 'p', t('memory.error_generic'), 'wb-memory-diagnostic'));
    else if (list.nextCursor) button(parent, t('wb.detail.loadMore'), more, 'wb-link-btn wb-memory-more');
  }
  /** One directory's loaded rows, folded subdirectories and groups included, then its "Load more". */
  function renderDirectory(parent, dir, { skip = null, budgets = null } = {}) {
    const rows = element(document, 'div', undefined, 'wb-memory-entries');
    const list = entries.start({ dir });
    for (const row of list.items) {
      if (row.path === skip) continue;
      if (row.type === 'file') {
        const budget = budgets?.get(row.path);
        fileButton(rows, row, '', budget?.over > 0 || budget?.warned ? ' wb-txt-warn' : '');
      } else if (row.type === 'group') groupBlock(rows, row);
      else directoryNode(rows, row);
    }
    listState(rows, list, () => entries.more({ dir }));
    parent.append(rows);
    return list;
  }
  /** The search: one flat list of the shallowest matches in the current view, read page by page. */
  function searchSpec() {
    if (selected === 'shared') return { view: 'shared', q: query };
    if (selected === 'groups') return { view: 'groups', q: query, ...(selectedGroup ? { dir: groupPath(selectedGroup) } : {}) };
    return { q: query };
  }
  function renderSearch() {
    const spec = searchSpec(), list = entries.start(spec);
    const rows = element(document, 'div', undefined, 'wb-memory-section');
    for (const row of list.items) {
      if (row.type === 'file') {
        const slash = row.path.lastIndexOf('/');
        fileButton(rows, row, slash < 0 ? '' : row.path.slice(0, slash + 1));
      } else if (row.type === 'group') groupHead(rows, row, () => { query = ''; search.value = ''; selectGroup(row.sessionGroup); });
      else {
        // A matching directory: clearing the search shows it opened in place.
        const head = button(rows, undefined, () => { query = ''; search.value = ''; revealDirectory(row.path); }, 'wb-memory-dir-h');
        head.append(icon(document, 'chev', 'xs'), element(document, 'span', `${row.path}/`));
        if (row.diagnostic) head.append(element(document, 'span', t('wb.memory.scopeInvalid'), 'wb-memory-bl-tag warn'));
      }
    }
    listState(rows, list, () => entries.more(spec));
    if (!list.loading && !list.error && !list.items.length) rows.append(element(document, 'p', t('wb.memory.noMatch'), 'empty-state'));
    listRoot.append(rows);
  }
  function renderList() {
    if (!listRoot || stopped) return;
    const focused = document.activeElement;
    const focusPath = listRoot.contains(focused) ? focused.dataset.path : undefined;
    const focusKey = listRoot.contains(focused) ? focused.dataset.collapseKey : undefined;
    listRoot.replaceChildren();
    if (query) renderSearch();
    else {
      if (selected !== 'groups') {
        const section = element(document, 'div', undefined, 'wb-memory-section');
        section.append(element(document, 'p', t('wb.memory.sharedTitle'), 'wb-memory-list-h'));
        const budgets = new Map(memoryBudgetRows(entries.known().rootFiles, backlog?.budgets).map(row => [row.path, row]));
        renderDirectory(section, '', { skip: GROUPS_DIR, budgets });
        listRoot.append(section);
      }
      if (selected !== 'shared') {
        const section = element(document, 'div', undefined, 'wb-memory-section');
        section.append(element(document, 'p', t('wb.memory.groupsTitle'), 'wb-memory-list-h'));
        if (selectedGroup) {
          const row = groupRow(selectedGroup);
          if (row?.type === 'group') groupBlock(section, row, true);
          else if (row) directoryNode(section, row);
          else if (row === undefined) section.append(element(document, 'p', t('memory.loading'), 'wb-memory-source'));
        } else renderDirectory(section, GROUPS_DIR);
        listRoot.append(section);
      }
    }
    // Async responses rebuild rows while the user may be tabbing.
    const replacement = focusPath !== undefined
      ? [...listRoot.querySelectorAll('.memory-file')].find(node => node.dataset.path === focusPath)
      : focusKey !== undefined
        ? [...listRoot.querySelectorAll('.wb-memory-dir-h'), ...listRoot.querySelectorAll('.wb-memory-group-h')]
          .find(node => node.dataset.collapseKey === focusKey)
        : null;
    replacement?.focus({ preventScroll: true });
  }
  /** Opens every directory from the root down to `path` (itself included), adding folders past the first page. */
  async function revealDirectory(path, { file = null } = {}) {
    const parts = path.split('/');
    if (parts[0] === GROUPS_DIR ? selected === 'shared' || (selectedGroup && parts[1] !== selectedGroup) : selected === 'groups') {
      selected = 'all'; selectedGroup = '';
    }
    onChange();
    for (let depth = 1; depth <= parts.length; depth++) {
      const dir = parts.slice(0, depth).join('/'), parent = parts.slice(0, depth - 1).join('/');
      if (dir === GROUPS_DIR) { await (entries.get({ dir }) ? null : entries.load({ dir })); continue; }
      if (!entries.get({ dir: parent }) || entries.get({ dir: parent }).loading) await entries.load({ dir: parent });
      if (!entries.get({ dir: parent }).items.some(row => row.path === dir)) {
        let row = { path: dir, name: parts[depth - 1], type: 'directory' };
        if (parent === GROUPS_DIR) {
          await entries.load(lookupSpec(parts[1]));
          row = entries.get(lookupSpec(parts[1])).items.find(item => item.path === dir) ?? row;
        }
        entries.insert({ dir: parent }, row);
      }
      expanded.add(dir);
    }
    if (file) {
      if (!entries.get({ dir: path }) || entries.get({ dir: path }).loading) await entries.load({ dir: path });
      entries.insert({ dir: path }, file);
    }
    onChange();
  }
  /** Shows an opened file in the list: its folders open, the file added when it is past their first page. */
  function revealFile(file) {
    const slash = file.path.lastIndexOf('/');
    const row = { path: file.path, name: file.name, type: 'file', size_bytes: file.size_bytes, mtime: file.mtime, renderable: true };
    if (slash < 0) {
      if (selected === 'groups') { selected = 'all'; selectedGroup = ''; }
      return (entries.get({ dir: '' }) ? Promise.resolve() : entries.load({ dir: '' })).then(() => { entries.insert({ dir: '' }, row); onChange(); });
    }
    return revealDirectory(file.path.slice(0, slash), { file: row });
  }
  function renderSummary() {
    if (!summaryRoot || stopped) return;
    summaryRoot.replaceChildren();
    summaryRoot.hidden = detail() === 'technical' || !entries.get({ dir: '' });
    if (summaryRoot.hidden) return;
    // Counted over every group by the server, however many rows are loaded.
    const summary = backlog?.summary ?? null, cross = backlog?.originSync ?? null;
    const unknown = !summary || summary.unknown > 0 || (cross != null && (cross.count == null || cross.syncing === null));
    const late = summary?.aged > 0, crossLate = cross?.aged === true;
    const waiting = summary?.waiting ?? 0, syncing = summary?.syncing ?? 0;
    summaryRoot.className = 'wb-memory-summary' + (late || crossLate ? ' wb-warn' : '');
    summaryRoot.append(icon(document, late || crossLate ? 'alert' : unknown ? 'help' : 'check', 'xs'),
      element(document, 'b', t(!loaded ? 'memory.loading' : late ? 'wb.memory.summaryLate' : crossLate ? 'wb.memory.summaryOriginLate'
        : unknown ? 'wb.memory.summaryUnknown' : 'wb.memory.summaryOk')));
    if (cross?.syncing === true) summaryRoot.append(element(document, 'span', t('wb.memory.summaryOriginSyncing')));
    if (syncing) summaryRoot.append(element(document, 'span', countLabel(t, 'wb.memory.summarySyncing', syncing)));
    if (waiting) summaryRoot.append(element(document, 'span', countLabel(t, 'wb.memory.summaryWaiting', waiting)));
    summaryRoot.append(element(document, 'span', t('wb.memory.summaryTech'), 'wb-sub'));
  }
  function chartCard(className, iconName, title, hint) {
    const card = element(document, 'section', undefined, className + ' wb-memory-card');
    const head = element(document, 'h3');
    head.append(icon(document, iconName, 'xs'), element(document, 'span', title), element(document, 'small', hint));
    card.append(head);
    return card;
  }
  // `cross` is the machine-wide Origin Sync backlog: not a group of its own, so its name selects nothing.
  function backlogItem(row, cross = false) {
    const item = element(document, 'div', undefined, 'wb-memory-chart-row wb-memory-bl' + (cross ? ' wb-memory-bl-cross' : ''));
    // Name and its badges share one cell: one line beside the bar on wide screens, a line of its own on phones.
    const head = element(document, 'span', undefined, 'wb-memory-bl-head');
    if (cross) {
      // Static name: the label class lays it out like a group name, the modifier drops the link look.
      const name = element(document, 'span', t('wb.memory.originSync'), 'wb-memory-chart-label wb-memory-chart-label-static');
      // A plain-words explanation with the row's actual threshold; without one, the count clause is left out.
      name.title = isNumber(row.threshold) ? t('wb.memory.originSyncHint', { count: row.threshold }) : t('wb.memory.originSyncHintNoThreshold');
      head.append(name);
    } else {
      const label = memoryGroupLabel(row, t);
      const name = button(head, label, () => selectGroup(row.sessionGroup), 'wb-memory-chart-label');
      name.title = label === row.sessionGroup ? label : `${label}\n${row.sessionGroup}`;
    }
    const over = isNumber(row.count) && isNumber(row.threshold) && row.count > row.threshold;
    const value = isNumber(row.count) ? String(row.count) : t('wb.unknown');
    const track = element(document, 'div', undefined, 'wb-memory-track');
    if (isNumber(row.count)) {
      const max = Math.max(row.count, isNumber(row.threshold) ? row.threshold * 1.25 : 0, 1);
      const fill = element(document, 'span', undefined, 'wb-memory-fill' + (over ? ' warning' : ''));
      fill.style.width = `${100 * row.count / max}%`; track.append(fill);
      if (isNumber(row.threshold)) {
        const line = element(document, 'span', undefined, 'wb-memory-threshold'); line.style.left = `${100 * row.threshold / max}%`;
        line.title = t(cross ? 'wb.memory.originThreshold' : 'wb.memory.threshold', { count: row.threshold }); track.append(line);
        track.setAttribute('aria-label', countLabel(t, 'wb.memory.countThreshold', row.count, { count: row.count, threshold: row.threshold }));
      } else track.setAttribute('aria-label', value);
    }
    const flags = element(document, 'span', undefined, 'wb-memory-flags');
    if (row.aged) {
      const age = memoryBacklogAge(row.firstAt);
      flags.append(element(document, 'span', age ? t(age.unit === 'days' ? 'wb.memory.agedDays' : 'wb.memory.agedHours', { count: age.count }) : t('wb.memory.aged'), 'wb-memory-bl-tag warn'));
    }
    // Over the threshold is said in words too, not only by the bar's colour.
    if (over) flags.append(element(document, 'span', t('wb.memory.overThreshold'), 'wb-memory-bl-tag warn'));
    if (cross && isNumber(row.pendingSummaries) && row.pendingSummaries > 0) {
      flags.append(element(document, 'span', countLabel(t, 'wb.memory.pendingSummaries', row.pendingSummaries), 'wb-memory-bl-tag'));
    }
    if (row.syncing === true) flags.append(element(document, 'span', t(cross ? 'wb.memory.originSyncing' : 'wb.memory.syncing'), 'wb-memory-bl-tag'));
    else if (row.syncing === null) flags.append(element(document, 'span', t(cross ? 'wb.memory.originSyncUnknown' : 'wb.memory.syncUnknown'), 'wb-memory-bl-tag'));
    if (cross && isNumber(row.threshold)) flags.append(element(document, 'span', t('wb.memory.originThreshold', { count: row.threshold }), 'wb-memory-bl-tag'));
    if (!cross && row.ownThreshold != null) flags.append(element(document, 'span', t('wb.memory.threshold', { count: row.ownThreshold }), 'wb-memory-bl-tag'));
    if (row.reason) flags.append(element(document, 'small', row.reason, 'wb-memory-bl-tag'));
    head.append(flags);
    item.append(head, track, element(document, 'span', value, 'wb-memory-chart-value' + (over ? ' wb-txt-warn' : '')));
    return item;
  }
  function moreButton(parent) {
    const more = button(parent, t('wb.detail.loadMore'), () => loadMore(), 'wb-link-btn wb-memory-more');
    more.disabled = loadingMore;
    return more;
  }
  function renderBacklogRows() {
    if (stopped) return;
    backlogRows.replaceChildren();
    const { rows } = memoryBacklogView(backlog?.groups, backlog?.summary?.threshold ?? null);
    const needle = backlogQuery.toLowerCase();
    // The cross-group row leads; a search keeps it only when its name matches.
    const cross = backlog?.originSync && (!needle || t('wb.memory.originSync').toLowerCase().includes(needle)) ? backlog.originSync : null;
    backlogRows.style.setProperty('--wb-bl-value', memoryBacklogValueWidth(cross ? [cross, ...rows] : rows, t('wb.unknown')));
    if (cross) backlogRows.append(backlogItem(cross, true));
    for (const row of rows) backlogRows.append(backlogItem(row));
    if (backlog?.nextCursor) moreButton(backlogRows);
    if (needle && !cross && !rows.length) backlogRows.append(element(document, 'p', t('wb.memory.noMatch'), 'wb-memory-source'));
    // Without a search, an empty list says so rather than leaving the card blank (the cross-group row is not a group).
    else if (!needle && !rows.length && !backlog?.nextCursor) backlogRows.append(element(document, 'p', t('wb.memory.noBacklogGroups'), 'wb-memory-source'));
  }
  function renderCharts() {
    if (!chartsRoot || stopped) return;
    chartsRoot.replaceChildren();
    chartsRoot.hidden = detail() !== 'technical';
    if (chartsRoot.hidden) return;
    const view = memoryBacklogView(backlog?.groups, backlog?.summary?.threshold ?? null);
    // Each row draws its own scale, so with the cross-group row the subtitle names both thresholds.
    const origin = isNumber(backlog?.originSync?.threshold) ? backlog.originSync.threshold : null;
    const hint = origin == null
      ? (view.threshold == null ? t('wb.memory.backlogHint') : t('wb.memory.thresholdHint', { count: view.threshold }))
      : (view.threshold == null ? t('wb.memory.backlogHintOrigin', { origin }) : t('wb.memory.thresholdHintOrigin', { count: view.threshold, origin }));
    const progress = chartCard('wb-memory-progress', 'layers', t('wb.memory.backlog'), hint);
    if (!backlog) progress.append(element(document, 'p', t('wb.unknown')));
    else {
      const many = (backlog.summary?.groups ?? 0) >= BACKLOG_FILTER_AT || Boolean(backlogQuery);
      if (many) { backlogSearch.placeholder = t('wb.memory.filterGroups'); backlogSearch.setAttribute('aria-label', t('wb.memory.filterGroups')); progress.append(backlogFilter); }
      else backlogSearch.value = '';
      progress.append(backlogRows);
      renderBacklogRows();
    }
    progress.append(element(document, 'p', t('wb.memory.backlogSource'), 'wb-memory-source'));
    chartsRoot.append(progress);
    const budgets = chartCard('wb-memory-budgets', 'book', t('wb.memory.budgets'), t('wb.memory.budgetHint'));
    for (const row of memoryBudgetRows(entries.known().rootFiles, backlog?.budgets)) {
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
        if (isNumber(row.warning)) { const warning = element(document, 'span', undefined, 'wb-memory-threshold'); warning.style.left = `${100 * row.warning / max}%`; warning.title = row.check ? t('wb.memory.startupWarning') : t('wb.memory.warnAt', { size: byteSize(row.warning) }); track.append(warning); }
        track.setAttribute('aria-label', row.check ? t('wb.memory.startupUsage', row.check) : t('wb.memory.sizeBudget', { size: byteSize(row.size), budget: byteSize(row.limit) }));
      }
      item.append(track, element(document, 'span', row.check ? t('wb.memory.startupUsage', row.check) : byteSize(row.size) + (isNumber(row.limit) ? ' / ' + byteSize(row.limit) : ''), 'wb-memory-chart-value'));
      const flags = element(document, 'span', undefined, 'wb-memory-flags');
      if (row.over > 0) flags.append(element(document, 'span', row.check ? t('wb.memory.startupOver') : t('wb.memory.overBudget', { size: byteSize(row.over) }), 'wb-memory-warning'));
      else if (row.warned) flags.append(element(document, 'span', t('wb.memory.warning'), 'wb-memory-warning'));
      item.append(flags);
      budgets.append(item);
    }
    budgets.append(element(document, 'p', t('wb.memory.budgetSource'), 'wb-memory-source'));
    chartsRoot.append(budgets);
  }
  const backlogPath = cursor => {
    const params = new URLSearchParams({ limit: String(BACKLOG_PAGE) });
    if (backlogQuery) params.set('q', backlogQuery);
    if (cursor) params.set('cursor', cursor);
    return `/api/memory/backlog?${params}`;
  };
  // A page's fields describe all groups; the rows add up across the pages read.
  const pageValue = ({ items, ...value }, groups) => ({ ...value, groups });
  /** Reads the backlog from its first page (on opening, refreshing and searching). */
  async function load() {
    const operation = ++generation, captured = identity();
    loadingMore = false;
    try {
      const value = await request(backlogPath(null));
      if (stopped || operation !== generation || captured !== identity()) return;
      backlog = pageValue(value, value.items ?? []); loaded = true; owner = captured; render();
    } catch {
      if (!stopped && operation === generation && captured === identity()) { backlog = null; loaded = true; render(); }
    }
  }
  /** Reads the next page; a cursor the server no longer accepts (after a restart) reads the first page again. */
  async function loadMore() {
    if (!backlog?.nextCursor || loadingMore || stopped) return;
    const operation = generation, captured = identity();
    loadingMore = true; renderBacklogRows();
    try {
      const value = await request(backlogPath(backlog.nextCursor));
      if (stopped || operation !== generation || captured !== identity()) return;
      const seen = new Set(backlog.groups.map(row => row.sessionGroup));
      backlog = pageValue(value, [...backlog.groups, ...(value.items ?? []).filter(row => !seen.has(row.sessionGroup))]);
      loadingMore = false; render();
    } catch (error) {
      if (stopped || operation !== generation || captured !== identity()) return;
      loadingMore = false;
      if (error?.code === 'invalid_cursor') load();
      else renderBacklogRows();
    }
  }
  // The page redraws this view when the detail level or language changes (app.js renderMemory).
  return { render, renderList, load, loadMore, selectGroup, revealFile,
    /** What the loaded lists say about memory (memory-entries.js `known`). */
    known: () => entries.known(),
    /** The root listing, once read: the default file is chosen from it. */
    readRoot: () => entries.get({ dir: '' }) && !entries.get({ dir: '' }).loading ? Promise.resolve(entries.get({ dir: '' })) : entries.load({ dir: '' }).then(() => entries.get({ dir: '' })),
    /** Reads the root and the session groups again, and the first page of every open directory. */
    reload() { entries.reset(); onChange(); },
    updateFile: (path, fields) => entries.updateFile(path, fields),
    anyExpanded: () => expanded.size > 0,
    collapseAll() { expanded = new Set(); onChange(); },
    destroy() {
      stopped = true; generation++; clearTimeout(backlogTimer); clearTimeout(searchTimer); clearTimeout(pickerTimer); entries.reset();
      root?.replaceChildren(); chartsRoot?.replaceChildren(); listRoot?.replaceChildren(); summaryRoot?.replaceChildren();
    } };
}
