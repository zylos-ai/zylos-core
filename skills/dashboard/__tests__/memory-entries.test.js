import assert from 'node:assert/strict';
import fs from 'node:fs';
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

async function page(f, search, deps = {}) {
  return readEntriesPage(parseEntriesQuery(new URLSearchParams(search)), { browser: f.browser, ...deps });
}

async function failure(f, search) {
  try { await page(f, search); } catch (error) { return { status: error.statusCode, code: error.code, param: error.param ?? null }; }
  return null;
}

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
