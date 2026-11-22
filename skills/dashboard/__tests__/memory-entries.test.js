import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryBrowser } from '../src/lib/memory-browser.js';
import { parseEntriesQuery, readEntriesPage } from '../src/lib/memory-entries.js';

// The memory entries list (GET /api/memory/entries) over a private memory directory: one directory level or one
// search per page, with counted file-system reads and an injected group order and badge reader.
function memoryDir(t) {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbe-'));
  t.after(() => fs.rmSync(zylosDir, { recursive: true, force: true }));
  const memory = path.join(zylosDir, 'memory');
  fs.mkdirSync(memory);
  const write = (rel, text = 'x', seconds = null) => {
    fs.mkdirSync(path.dirname(path.join(memory, rel)), { recursive: true });
    fs.writeFileSync(path.join(memory, rel), text);
    if (seconds !== null) fs.utimesSync(path.join(memory, rel), seconds, seconds);
  };
  return { zylosDir, memory, write, browser: new MemoryBrowser({ zylosDir }) };
}

function counted() {
  const reads = { readdir: 0, lstat: 0 };
  return { reads, readdir: (...args) => { reads.readdir++; return fsp.readdir(...args); }, lstat: (...args) => { reads.lstat++; return fsp.lstat(...args); } };
}

async function page(f, search, deps = {}) {
  return readEntriesPage(parseEntriesQuery(new URLSearchParams(search)), { browser: f.browser, ...deps });
}

async function failure(f, search) {
  try { await page(f, search); } catch (error) { return { status: error.statusCode, code: error.code, param: error.param ?? null }; }
  return null;
}

async function every(f, search, deps) {
  const pages = [];
  let cursor = null;
  do {
    const value = await page(f, cursor ? `${search}&cursor=${encodeURIComponent(cursor)}` : search, deps);
    pages.push(value.items.map(row => row.path));
    cursor = value.nextCursor;
  } while (cursor);
  return pages;
}

test('entries hide Git, links and Core in-flight write files but keep other .tmp files, without hashes', async t => {
  const f = memoryDir(t);
  const hidden = ['session-groups/s8test:a/state.md.c0ce700b83f43466a5523a73fad66cbb.tmp', 'state.md.sync-token.tmp',
    '.identity.md.0123456789abcdef01234567.tmp', 'reference/.projects.md.fedcba9876543210fedcba98.tmp',
    'reference/.projects.md.0123456789abcdef0123456789abcdef.tmp'];
  const kept = ['notes.tmp', '.identity.md.0123.tmp', 'reference/.projects.md.0123456789ABCDEF01234567.tmp',
    'reference/projects.md.0123456789abcdef01234567.tmp', 'identity.md.c0ce700b83f43466a5523a73fad66cbb.tmp', 'state.md.a.b.tmp'];
  for (const rel of ['identity.md', 'reference/projects.md', '.git/HEAD', ...hidden, ...kept]) f.write(rel);
  fs.symlinkSync(os.tmpdir(), path.join(f.memory, 'escape-link'));
  const listed = [];
  for (const dir of ['', 'reference', 'session-groups/s8test:a']) listed.push(...(await page(f, dir ? `dir=${encodeURIComponent(dir)}` : '')).items);
  const paths = listed.map(row => row.path);
  for (const rel of hidden) assert.equal(paths.includes(rel), false, rel);
  for (const rel of kept) assert.equal(paths.includes(rel), true, rel);
  assert.equal(paths.some(rel => rel.includes('.git') || rel.includes('escape-link')), false);
  assert.equal(JSON.stringify(listed).includes('sha256'), false);
  const identity = listed.find(row => row.path === 'identity.md');
  assert.deepEqual(Object.keys(identity).sort(), ['mtime', 'name', 'path', 'renderable', 'size_bytes', 'type']);
  assert.equal(identity.renderable, true);
  // A search finds the same files and none of the hidden ones.
  const found = (await page(f, 'q=tmp&limit=100')).items.map(row => row.path);
  assert.deepEqual(found.filter(rel => hidden.includes(rel)), []);
  assert.ok(kept.every(rel => found.includes(rel) || found.some(dir => rel.startsWith(`${dir}/`))));
});

test('opening the page reads the root and the first page of groups at the same cost with 500 or 5000 files', async t => {
  const measure = async (files, groups) => {
    const f = memoryDir(t);
    for (const name of ['identity.md', 'references.md', 'state.md']) f.write(name);
    for (let index = 0; index < groups; index++) f.write(`session-groups/telegram:g${String(index).padStart(3, '0')}/state.md`);
    const perGroup = Math.floor(files / groups);
    for (let index = 0; index < groups; index++) for (let day = 0; day < perGroup; day++) {
      f.write(`session-groups/telegram:g${String(index).padStart(3, '0')}/sessions/d${day}.md`);
    }
    const reads = counted(), badges = [];
    const deps = { ...reads, sortMessage: () => null, badges: async keys => { badges.push(keys.length); return keys.map(() => null); } };
    const rootPage = await page(f, '', deps), groupsPage = await page(f, 'dir=session-groups', deps);
    return { reads: reads.reads, badges, size: JSON.stringify([rootPage, groupsPage]).replace(/"nextCursor":"[^"]+"/g, '').length,
      rows: [rootPage.items.length, groupsPage.items.length] };
  };
  const small = await measure(500, 300), large = await measure(5000, 300);
  assert.deepEqual(large.reads, small.reads, 'the same reads: two directory listings and the root files');
  assert.deepEqual(large.reads, { readdir: 2, lstat: 3 });
  assert.deepEqual(large.rows, [4, 50]);
  assert.equal(large.size, small.size);
  assert.deepEqual(large.badges, [0, 50], 'badges only for the fifty groups on the page');
});

test('a sessions directory of 120 logs lists the newest 50 first, then the rest once each', async t => {
  const f = memoryDir(t);
  const days = Array.from({ length: 120 }, (_, index) => `session-groups/telegram:a/sessions/2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}.md`);
  days.forEach((rel, index) => f.write(rel, 'x', 1_700_000_000 + index * 86400));
  f.write('session-groups/telegram:a/sessions/archive/old.md');
  const pages = await every(f, 'dir=session-groups%2Ftelegram%3Aa%2Fsessions');
  assert.deepEqual(pages.map(rows => rows.length), [50, 50, 21]);
  assert.equal(pages[0][0], 'session-groups/telegram:a/sessions/archive', 'directories first');
  assert.deepEqual(pages.flat().slice(1), [...days].reverse(), 'files newest first, none twice or missed');
});

test('session groups are ordered by their latest received message, badges are read for the page only', async t => {
  const f = memoryDir(t);
  for (const key of ['telegram:old', 'telegram:new', 'telegram:quiet', 'lark:middle', 'Bad Name']) f.write(`session-groups/${key}/state.md`);
  f.write('session-groups/notes.md');
  const times = { 'telegram:old': '2026-11-01 08:00:00', 'telegram:new': '2026-11-03 08:00:00', 'lark:middle': '2026-11-02T08:00:00.000Z' };
  const asked = [];
  const deps = { sortMessage: key => times[key] ? { id: 1, timestamp: times[key] } : null, displayName: key => key === 'lark:middle' ? 'Lark Team' : null,
    badges: async keys => { asked.push(keys); return keys.map(key => ({ count: key.length, syncing: false })); } };
  const first = await page(f, 'dir=session-groups&limit=3', deps);
  assert.deepEqual(first.items.map(row => row.path.slice('session-groups/'.length)), ['telegram:new', 'lark:middle', 'telegram:old']);
  assert.deepEqual(asked, [['telegram:new', 'lark:middle', 'telegram:old']]);
  assert.deepEqual(first.items[1], { path: 'session-groups/lark:middle', name: 'lark:middle', type: 'group', sessionGroup: 'lark:middle',
    displayName: 'Lark Team', backlog: { count: 11, syncing: false } });
  const rest = await page(f, `dir=session-groups&limit=3&cursor=${encodeURIComponent(first.nextCursor)}`, deps);
  assert.deepEqual(rest.items.map(row => [row.name, row.type, row.diagnostic ?? null]),
    [['telegram:quiet', 'group', null], ['Bad Name', 'directory', 'invalid_session_group'], ['notes.md', 'file', null]],
    'groups without a received message after, then invalid group directories, then files');
  assert.deepEqual(asked[1], ['telegram:quiet']);
  // Without C4 the groups have no order and the level is unavailable; a failed badge read leaves the badges empty.
  await assert.rejects(page(f, 'dir=session-groups', { sortMessage: () => { throw new Error('no c4'); } }), { statusCode: 503, code: 'unavailable' });
  const unread = await page(f, 'dir=session-groups&limit=1', { ...deps, badges: async () => { throw new Error('down'); } });
  assert.deepEqual(unread.items.map(row => [row.name, row.backlog]), [['telegram:new', null]]);
});

test('a search returns the shallowest matches page by page and stops reading once a page is full', async t => {
  const f = memoryDir(t);
  f.write('state.md');
  for (let index = 0; index < 40; index++) {
    const key = `telegram:g${String(index).padStart(2, '0')}`;
    f.write(`session-groups/${key}/state.md`);
    f.write(`session-groups/${key}/sessions/2026-11-01.md`);
  }
  f.write('session-groups/lark:team/state.md');
  // Part of a file name: the files in every group, in path order, paged without repeats.
  const pages = await every(f, 'q=STATE&limit=15');
  assert.deepEqual(pages.map(rows => rows.length), [15, 15, 12]);
  assert.equal(new Set(pages.flat()).size, 42);
  assert.deepEqual(pages.flat().slice(0, 2), ['session-groups/lark:team/state.md', 'session-groups/telegram:g00/state.md']);
  assert.equal(pages.flat().at(-1), 'state.md');
  // A directory that matches stands for what it holds: "tel" returns the groups, not their files.
  const groups = await page(f, 'dir=session-groups&q=tel&limit=100');
  assert.equal(groups.items.length, 40);
  assert.ok(groups.items.every(row => row.type === 'group'));
  // A group's display name finds it too.
  assert.deepEqual((await page(f, 'q=sales%20team', { displayName: key => key === 'lark:team' ? 'Sales Team' : null })).items.map(row => row.path),
    ['session-groups/lark:team']);
  // The first page of 15 reads the root, session-groups and only the groups it reaches (each group and its
  // sessions directory), not all 41; the whole tree would take 84 directory reads.
  const reads = counted();
  await page(f, 'q=state&limit=15', reads);
  assert.ok(reads.reads.readdir <= 2 + 2 * 16, `readdir ${reads.reads.readdir}`);
  assert.ok(reads.reads.lstat <= 16, `lstat only for matches: ${reads.reads.lstat}`);
  // The views: shared leaves out session-groups, groups searches only there.
  assert.deepEqual((await page(f, 'q=state&view=shared')).items.map(row => row.path), ['state.md']);
  assert.ok((await page(f, 'q=state&view=groups&limit=100')).items.every(row => row.path.startsWith('session-groups/')));
});

test('entries reject unknown, repeated and invalid parameters, paths outside memory and refused cursors', async t => {
  const f = memoryDir(t);
  f.write('state.md');
  f.write('archive/a.md');
  fs.mkdirSync(path.join(f.memory, '.git'));
  fs.symlinkSync(os.tmpdir(), path.join(f.memory, 'escape-link'));
  const cases = {
    'foo=1': [400, 'invalid_parameter', 'foo'], 'dir=archive&dir=archive': [400, 'invalid_parameter', 'dir'],
    'limit=0': [400, 'invalid_parameter', 'limit'], 'limit=101': [400, 'invalid_parameter', 'limit'],
    'dir=..': [400, 'invalid_parameter', 'dir'], 'dir=%2Ftmp': [400, 'invalid_parameter', 'dir'], 'dir=archive%2F..%2F..': [400, 'invalid_parameter', 'dir'],
    'dir=.git': [400, 'invalid_parameter', 'dir'], 'dir=escape-link': [400, 'invalid_parameter', 'dir'], 'dir=state.md': [400, 'invalid_parameter', 'dir'],
    'view=mine': [400, 'invalid_parameter', 'view'], 'view=shared&dir=session-groups': [400, 'invalid_parameter', 'view'],
    'view=groups&dir=archive': [400, 'invalid_parameter', 'view'], [`q=${'x'.repeat(65)}`]: [400, 'invalid_parameter', 'q'],
    'cursor=forged': [400, 'invalid_cursor', null], 'dir=missing': [404, 'not_found', null],
  };
  for (const [search, expected] of Object.entries(cases)) {
    assert.deepEqual(await failure(f, search), { status: expected[0], code: expected[1], param: expected[2] }, search);
  }
  // A cursor belongs to its directory, view and search.
  for (let index = 0; index < 3; index++) f.write(`archive/b${index}.md`);
  const first = await page(f, 'dir=archive&limit=1');
  assert.deepEqual(await failure(f, `dir=archive&q=a&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`), { status: 400, code: 'invalid_cursor', param: null });
  assert.deepEqual(await failure(f, `limit=1&cursor=${encodeURIComponent(first.nextCursor)}`), { status: 400, code: 'invalid_cursor', param: null });
});
