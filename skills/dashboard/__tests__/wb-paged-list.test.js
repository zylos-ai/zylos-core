import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { documentFixture, node } from './fixtures/settings-dom.js';

const browserDescriptors = new URL('../public/runtime-descriptors.js', import.meta.url).pathname;
const sourceDescriptors = new URL('../../../cli/lib/runtime/descriptors.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserDescriptors) return next(sourceDescriptors, context);
    return next(specifier, context);
  },
});
const { listPage, mountPagedList, SEARCH_DELAY } = await import('../public/js/wb/paged-list.js');

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

// A server holding `rows`, paged under the list standard with opaque cursors; `restart()` makes old cursors invalid.
function server(rows) {
  let epoch = 1;
  const calls = [];
  return {
    calls, rows,
    restart() { epoch++; },
    async readPage({ q, cursor, limit, total }) {
      calls.push({ q, cursor, limit, total });
      const matched = rows.filter(row => !q || row.toLowerCase().includes(q.toLowerCase()));
      let start = 0;
      if (cursor) {
        const [at, name] = cursor.split(':');
        if (Number(at) !== epoch) throw Object.assign(new Error('refused'), { code: 'invalid_cursor' });
        start = matched.findIndex(row => row === name) + 1;
        if (start === 0) start = matched.findIndex(row => rows.indexOf(row) > rows.indexOf(name));
        if (start < 0) start = matched.length;
      }
      const items = matched.slice(start, start + limit);
      const more = start + limit < matched.length;
      return { items, nextCursor: more ? `${epoch}:${items.at(-1)}` : null, ...(total ? { total: matched.length } : {}) };
    },
  };
}

function serverFixture(rows) {
  const document = documentFixture(), list = node(document, 'tbody'), source = server(rows), errors = [];
  let shown = [];
  const pages = mountPagedList({ document, t, list, placeholder: 'search', server: {
    readPage: query => source.readPage(query), render: items => { shown = items; }, onError: error => errors.push(error),
  } });
  const [previous, at, next] = pages.pager.children;
  return { pages, source, errors, previous, at, next, shown: () => shown, input: pages.search.children[0] };
}
const keys = count => Array.from({ length: count }, (_, index) => 'key-' + String(index + 1).padStart(2, '0'));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const typed = () => new Promise(resolve => setTimeout(resolve, SEARCH_DELAY + 50));

test('a server list reads nothing until refreshed, then pages 70 rows by 8 both ways without repeats or gaps', async () => {
  const f = serverFixture(keys(70));
  assert.equal(f.source.calls.length, 0, 'mounting reads nothing');
  await f.pages.refresh({ first: true });
  assert.equal(f.at.textContent, 'wb.list.page{"page":1,"pages":9}'); assert.equal(f.previous.disabled, true);
  assert.equal(f.pages.search.hidden, false);
  const forward = [f.shown()];
  for (let page = 2; page <= 9; page++) { await f.next.dispatch('click'); await settle(); forward.push(f.shown()); }
  assert.deepEqual(forward.flat(), keys(70), 'every row once, in order');
  assert.equal(f.next.disabled, true); assert.equal(f.at.textContent, 'wb.list.page{"page":9,"pages":9}');
  const backward = [];
  for (let page = 8; page >= 1; page--) { await f.previous.dispatch('click'); await settle(); backward.unshift(f.shown()); }
  assert.deepEqual(backward, forward.slice(0, 8), 'going back shows the same pages');
  assert.deepEqual(f.source.calls.map(call => call.total), [true, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, true],
    'the total is read with the first page only');
  assert.ok(f.source.calls.every(call => call.limit === 8));
});

test('the search goes to the server once typing pauses, with the total, and an empty result says so', async () => {
  const f = serverFixture(keys(20));
  await f.pages.refresh({ first: true });
  await f.next.dispatch('click'); await settle();
  f.input.value = 'key-1'; await f.input.dispatch('input');
  f.input.value = 'key-1 '; await f.input.dispatch('input');
  await typed();
  assert.deepEqual(f.source.calls.at(-1), { q: 'key-1', cursor: null, limit: 8, total: true });
  assert.equal(f.source.calls.filter(call => call.q).length, 1, 'one request once typing pauses');
  assert.equal(f.shown().length, 8); assert.equal(f.at.textContent, 'wb.list.page{"page":1,"pages":2}');
  f.input.value = 'nothing'; await f.input.dispatch('input'); await typed();
  assert.deepEqual(f.shown(), []); assert.equal(f.pages.empty.hidden, false); assert.equal(f.pages.pager.hidden, true);
});

test('a refused cursor goes back to the first page without an error', async () => {
  const f = serverFixture(keys(30));
  await f.pages.refresh({ first: true });
  await f.next.dispatch('click'); await settle();
  f.source.restart();
  await f.next.dispatch('click'); await settle();
  assert.deepEqual(f.shown(), keys(8)); assert.equal(f.at.textContent, 'wb.list.page{"page":1,"pages":4}');
  assert.deepEqual(f.errors, []);
  await f.next.dispatch('click'); await settle();
  assert.deepEqual(f.shown(), keys(16).slice(8), 'paging goes on from the first page');
});

test('refreshing after a change reads the page shown again, or the one before when it is now empty', async () => {
  const f = serverFixture(keys(9));
  await f.pages.refresh({ first: true });
  await f.next.dispatch('click'); await settle();
  assert.deepEqual(f.shown(), ['key-09']);
  f.source.rows.splice(4, 1);
  await f.pages.refresh();
  assert.deepEqual(f.shown(), ['key-09'], 'the page after the remembered cursor');
  assert.equal(f.source.calls.at(-1).total, true);
  f.source.rows.pop();
  await f.pages.refresh();
  assert.deepEqual(f.shown(), ['key-01', 'key-02', 'key-03', 'key-04', 'key-06', 'key-07', 'key-08'], 'the emptied page falls back to the one before');
  assert.equal(f.at.textContent, 'wb.list.page{"page":1,"pages":1}'); assert.equal(f.pages.pager.hidden, true);
  const failing = serverFixture(keys(3));
  failing.source.readPage = async () => { throw Object.assign(new Error('down'), { code: 'unavailable' }); };
  await failing.pages.refresh({ first: true });
  assert.deepEqual(failing.errors.map(error => error.code), ['unavailable']);
});
