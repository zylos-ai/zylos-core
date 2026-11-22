import { element, icon } from './plain-text.js';

/** Rows per page in the settings page's long lists. */
export const PAGE_SIZE = 8;

/**
 * Which items a long list shows: the ones whose text contains the search (case-insensitive), one page of them.
 * A page past the end shows the last page.
 */
export function listPage(items, { query = '', page = 1, size = PAGE_SIZE, text = item => String(item) } = {}) {
  const term = String(query).trim().toLocaleLowerCase();
  const matched = term ? items.filter(item => String(text(item) ?? '').toLocaleLowerCase().includes(term)) : items;
  const pages = Math.max(1, Math.ceil(matched.length / size));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  return { matched: matched.length, pages, page: current, items: matched.slice((current - 1) * size, current * size) };
}

// The search box, the "no matching results" note and the "Previous / Next · Page x / y" pager both modes share.
function pagerControls(document, t, placeholder) {
  const search = element(document, 'div', undefined, 'wb-plist-search');
  const input = element(document, 'input', undefined, 'wb-input'); input.type = 'search'; input.autocomplete = 'off';
  input.placeholder = placeholder; input.setAttribute('aria-label', placeholder);
  search.append(input);
  const empty = element(document, 'p', t('wb.list.noMatch'), 'wb-note wb-plist-empty'); empty.hidden = true;
  const pager = element(document, 'div', undefined, 'wb-plist-pager');
  const previous = element(document, 'button', undefined, 'wb-btn wb-plist-prev'); previous.type = 'button';
  const previousLabel = element(document, 'span', t('wb.list.previous'));
  const at = element(document, 'span', '', 'wb-plist-at');
  const next = element(document, 'button', undefined, 'wb-btn wb-plist-next'); next.type = 'button';
  const nextLabel = element(document, 'span', t('wb.list.next'));
  previous.append(icon(document, 'chev', 'xs'), previousLabel); next.append(nextLabel, icon(document, 'chev', 'xs'));
  pager.append(previous, at, next); pager.hidden = true;
  const relabel = () => { previousLabel.textContent = t('wb.list.previous'); nextLabel.textContent = t('wb.list.next'); empty.textContent = t('wb.list.noMatch'); };
  const setPlaceholder = value => { input.placeholder = value; input.setAttribute('aria-label', value); };
  return { search, input, empty, pager, previous, next, at, relabel, setPlaceholder };
}

// Leaving a full page keeps the list's height for the rest of it, so the buttons stay where they are.
function holdHeight(list, shown, size) {
  const height = list.getBoundingClientRect?.().height ?? 0;
  if (shown >= size && height > 0) list.style.minHeight = `${Math.ceil(height)}px`;
}

/**
 * The settings page's long lists all look the same: a search box above the rows once there are more than one page
 * of them, one page of rows, "no matching results" when the search finds nothing, and "Previous / Next · Page x / y"
 * below while there is more than one page. A full page fixes the list's height, so the buttons stay where they are
 * on a shorter last page or result.
 *
 * Without `server` the list pages rows already on the page. The rows are the caller's own elements and stay where
 * they are: rows off the page are only hidden, so a row being edited keeps what was typed. `rows()` lists them in
 * order and `text(row)` is what the search looks in; `refresh()` applies the search and page again after the caller
 * re-renders them.
 *
 * With `server` the server pages and searches (see `mountServerPages`).
 */
export function mountPagedList({ document, t = key => key, list, rows, text = row => row.dataset.search ?? row.textContent, placeholder = '', size = PAGE_SIZE, server = null }) {
  if (server) return mountServerPages({ document, t, list, placeholder, size, ...server });
  let query = '', page = 1;
  const controls = pagerControls(document, t, placeholder);
  const { search, input, empty, pager, previous, next, at } = controls;

  const hold = () => holdHeight(list, rows().filter(row => !row.hidden).length, size);
  function refresh({ reveal = null } = {}) {
    const all = rows();
    search.hidden = all.length <= size;
    if (search.hidden && query) { query = ''; input.value = ''; }
    if (reveal && all.includes(reveal)) {
      if (!listPage([reveal], { query, text }).matched) { query = ''; input.value = ''; }
      const matched = listPage(all, { query, size: all.length || 1, text }).items;
      page = Math.floor(matched.indexOf(reveal) / size) + 1;
    }
    const view = listPage(all, { query, page, size, text });
    page = view.page;
    const shown = new Set(view.items);
    for (const row of all) row.hidden = !shown.has(row);
    empty.hidden = !query || view.matched > 0;
    pager.hidden = view.pages <= 1;
    if (view.pages <= 1 && !query) list.style.minHeight = '';
    at.textContent = t('wb.list.page', { page, pages: view.pages });
    previous.disabled = page <= 1; next.disabled = page >= view.pages;
  }
  input.addEventListener('input', () => { hold(); query = input.value; page = 1; refresh(); });
  previous.addEventListener('click', () => { hold(); page--; refresh(); });
  next.addEventListener('click', () => { hold(); page++; refresh(); });
  return {
    search, empty, pager, refresh,
    relabel() { controls.relabel(); refresh(); },
    setPlaceholder: controls.setPlaceholder,
  };
}

/** How long the search box waits after the last keystroke before asking the server. */
export const SEARCH_DELAY = 300;

/**
 * A long list the server pages, under the list API standard: `readPage({ q, cursor, limit, total })` resolves to one page
 * `{ items, nextCursor, total? }` (it asks for `include=total` when `total` is true) or throws an error carrying the
 * response's `code`; `render(items, page)` draws the rows; `onError(error)` reports a failed read.
 *
 * The search box sends its text as `q` once typing pauses. "Next" reads after the page's `nextCursor`; "Previous"
 * reads after the cursor remembered for the page before, so going back shows the same pages again. The total behind
 * "Page x / y" is read with the first page, when the search changes, and when the caller reloads after a change; the
 * pages in between do not count again. A cursor the server refuses (after a Dashboard restart) goes back to the
 * first page without an error.
 */
function mountServerPages({ document, t, list, placeholder, size, readPage, render, onError = () => {} }) {
  const controls = pagerControls(document, t, placeholder);
  const { search, input, empty, pager, previous, next, at } = controls;
  // cursors[i] reads page i + 1; the first page has none.
  let query = '', page = 1, cursors = [null], nextCursor = null, total = 0, shown = 0, generation = 0, busy = false, timer = null;

  function draw() {
    const pages = Math.max(1, Math.ceil(total / size), page + (nextCursor ? 1 : 0));
    search.hidden = !query && total <= size;
    empty.hidden = !query || shown > 0;
    pager.hidden = pages <= 1;
    if (pages <= 1 && !query) list.style.minHeight = '';
    at.textContent = t('wb.list.page', { page, pages });
    previous.disabled = busy || page <= 1; next.disabled = busy || !nextCursor;
  }
  // Reads page `target`; `count` also reads the total. A refused cursor reads the first page instead.
  async function load(target, { count = false } = {}) {
    const operation = ++generation;
    busy = true; draw();
    try {
      let value;
      try {
        value = await readPage({ q: query, cursor: cursors[target - 1], limit: size, total: count || target === 1 });
      } catch (error) {
        if (error?.code !== 'invalid_cursor' || target === 1 || operation !== generation) throw error;
        target = 1; cursors = [null];
        value = await readPage({ q: query, cursor: null, limit: size, total: true });
      }
      if (operation !== generation) return;
      // A change can leave a later page empty: show the page before it.
      if (!value.items.length && target > 1) { busy = false; return load(target - 1, { count: true }); }
      page = target; cursors.length = target; nextCursor = value.nextCursor ?? null;
      if (Number.isSafeInteger(value.total)) total = value.total;
      shown = value.items.length;
      render(value.items, value);
    } catch (error) {
      if (operation === generation) onError(error);
    } finally {
      if (operation === generation) { busy = false; draw(); }
    }
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (input.value.trim() === query) return;
      holdHeight(list, shown, size);
      query = input.value.trim(); cursors = [null];
      load(1, { count: true });
    }, SEARCH_DELAY);
  });
  previous.addEventListener('click', () => { if (page > 1 && !busy) { holdHeight(list, shown, size); load(page - 1); } });
  next.addEventListener('click', () => {
    if (!nextCursor || busy) return;
    holdHeight(list, shown, size);
    cursors[page] = nextCursor;
    load(page + 1);
  });
  return {
    search, empty, pager,
    /**
     * Reads the page shown again, with the total (after a change); `first` goes back to the first page. Nothing is
     * read before the first call, so a list the page does not show yet costs no request.
     */
    refresh({ first = false } = {}) { if (first) cursors = [null]; return load(first ? 1 : page, { count: true }); },
    relabel() { controls.relabel(); draw(); },
    setPlaceholder: controls.setPlaceholder,
  };
}
