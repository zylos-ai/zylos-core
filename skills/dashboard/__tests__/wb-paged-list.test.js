import test from 'node:test';
import assert from 'node:assert/strict';
import { listPage, mountPagedList } from '../public/js/wb/paged-list.js';
import { documentFixture, node } from './fixtures/settings-dom.js';

const t = (key, values) => values ? key + JSON.stringify(values) : key;

function fixture(count) {
  const document = documentFixture(), list = node(document, 'tbody');
  for (let index = 1; index <= count; index++) { const row = node(document, 'tr'); row.dataset.search = 'Machine ' + index; list.append(row); }
  const pages = mountPagedList({ document, t, list, rows: () => list.children, placeholder: 'search' });
  pages.refresh();
  return { document, list, pages, shown: () => list.children.filter(row => !row.hidden).map(row => row.dataset.search) };
}

test('a long list matches the search case-insensitively and shows one page, a page past the end showing the last', () => {
  const items = Array.from({ length: 11 }, (_, index) => 'Host ' + (index + 1));
  assert.deepEqual(listPage(items, { page: 2 }), { matched: 11, pages: 2, page: 2, items: ['Host 9', 'Host 10', 'Host 11'] });
  assert.deepEqual(listPage(items, { page: 9 }).page, 2);
  assert.deepEqual(listPage(items, { query: ' host 1' }).items, ['Host 1', 'Host 10', 'Host 11']);
  assert.deepEqual(listPage([], { query: 'x' }), { matched: 0, pages: 1, page: 1, items: [] });
});

test('eight rows or fewer show no search box and no pager', () => {
  const { pages, shown } = fixture(8);
  assert.equal(pages.search.hidden, true); assert.equal(pages.pager.hidden, true); assert.equal(shown().length, 8);
});

test('eleven rows page 8 then 3, the search finds across pages and an empty search says so', async () => {
  const { pages, shown, list } = fixture(11);
  const [previous, at, next] = pages.pager.children;
  assert.equal(pages.search.hidden, false); assert.equal(pages.pager.hidden, false);
  assert.equal(shown().length, 8); assert.equal(at.textContent, 'wb.list.page{"page":1,"pages":2}'); assert.equal(previous.disabled, true);
  await next.dispatch('click');
  assert.deepEqual(shown(), ['Machine 9', 'Machine 10', 'Machine 11']); assert.equal(next.disabled, true);
  assert.equal(list.children.length, 11, 'rows off the page stay in place, only hidden');
  const input = pages.search.children[0];
  input.value = 'machine 1'; await input.dispatch('input');
  assert.deepEqual(shown(), ['Machine 1', 'Machine 10', 'Machine 11']); assert.equal(pages.pager.hidden, true); assert.equal(pages.empty.hidden, true);
  input.value = 'nothing'; await input.dispatch('input');
  assert.deepEqual(shown(), []); assert.equal(pages.empty.hidden, false); assert.equal(pages.empty.textContent, 'wb.list.noMatch');
});

test('revealing a row opens the page it is on and clears a search that hides it', async () => {
  const { pages, shown, list } = fixture(11);
  const input = pages.search.children[0];
  input.value = 'machine 2'; await input.dispatch('input');
  pages.refresh({ reveal: list.children[9] });
  assert.equal(input.value, ''); assert.deepEqual(shown(), ['Machine 9', 'Machine 10', 'Machine 11']);
});
