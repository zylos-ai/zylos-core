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

/**
 * The settings page's long lists all look the same: a search box above the rows once there are more than one page
 * of them, one page of rows, "no matching results" when the search finds nothing, and "Previous / Next · Page x / y"
 * below while there is more than one page. A full page fixes the list's height, so the buttons stay where they are
 * on a shorter last page or result.
 *
 * The rows are the caller's own elements and stay where they are: rows off the page are only hidden, so a row being
 * edited keeps what was typed. `rows()` lists them in order and `text(row)` is what the search looks in; `refresh()`
 * applies the search and page again after the caller re-renders them.
 */
export function mountPagedList({ document, t = key => key, list, rows, text = row => row.dataset.search ?? row.textContent, placeholder = '', size = PAGE_SIZE }) {
  let query = '', page = 1;
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

  // Leaving a full page keeps its height for the rest of the list.
  function holdHeight() {
    const shown = rows().filter(row => !row.hidden).length, height = list.getBoundingClientRect?.().height ?? 0;
    if (shown >= size && height > 0) list.style.minHeight = `${Math.ceil(height)}px`;
  }
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
  input.addEventListener('input', () => { holdHeight(); query = input.value; page = 1; refresh(); });
  previous.addEventListener('click', () => { holdHeight(); page--; refresh(); });
  next.addEventListener('click', () => { holdHeight(); page++; refresh(); });
  return {
    search, empty, pager, refresh,
    relabel() { previousLabel.textContent = t('wb.list.previous'); nextLabel.textContent = t('wb.list.next'); empty.textContent = t('wb.list.noMatch'); refresh(); },
    setPlaceholder(value) { input.placeholder = value; input.setAttribute('aria-label', value); },
  };
}
