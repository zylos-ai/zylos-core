import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupsApi } from '../src/lib/workbench/groups-api.js';
import { Sanitizer } from '../src/lib/sanitizer.js';

// Search now projects the complete cached catalog. It does not query C4 or
// display-name indexes independently; CLI argument tests belonged to the retired search.
function fixture({ size = 3, failed = false, listKnown = true } = {}) {
  let reads = 0;
  const sanitizer = new Sanitizer('/isolated');
  const rows = Array.from({ length: size }, (_, i) => ({
    sessionGroup: i === 0 ? 'tg:live' : i === 1 ? 'tg:older' : `tg:old${i}`,
    presence: i === 0 ? 'running' : listKnown ? 'not_running' : 'unknown',
    reason: listKnown ? null : 'group_list_failed',
    live: i === 0 ? { status: { valid: true, state: 'idle' } } : null,
    name: i === 1 ? { displayName: 'Named historical group 竞品 --b' } : null,
    c4: { componentName: 'telegram', lastActivityAt: 1 },
    preview: { text: sanitizer.safeSummary('sk-123456789012345678901234'), timestamp: 1 },
  }));
  const snapshot = { readAt: 1000, rows, listKnown, sources: { c4: { ok: !failed } } };
  const api = createGroupsApi({ workbench: { getSnapshot: async () => { reads++; return snapshot; } } });
  return { api, rows, snapshot, reads: () => reads, search: q => api.list(new URLSearchParams({ q, include: 'total' })) };
}

test('invalid search has no source reads and a blank query is unfiltered', async () => {
  const f = fixture();
  await assert.rejects(f.search('x'.repeat(65)), { code: 'invalid_parameter', param: 'q' });
  assert.equal(f.reads(), 0);
  assert.equal((await f.search(' ')).items.length, 3);
  assert.equal(f.reads(), 1);
});

for (const q of ['oc_', 'a--b', 'AbC']) test(`key search matches literal case-insensitive IDs: ${q}`, async () => {
  const f = fixture();
  f.rows[0].sessionGroup = 'telegram:' + q.toUpperCase();
  const value = await f.search(q);
  assert.equal(f.reads(), 1);
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0].id, f.rows[0].sessionGroup);
  assert.equal(value.items[0].state.kind, 'idle');
  assert.equal(value.nextCursor, null);
});

for (const q of ['竞品', '--b']) test(`display-name search includes offline catalog rows: ${q}`, async () => {
  const f = fixture(), value = await f.search(q);
  assert.equal(value.items.length, 1);
  const row = value.items[0];
  assert.equal(row.id, 'tg:older');
  assert.equal(row.displayName, 'Named historical group 竞品 --b');
  assert.equal(Object.hasOwn(row, 'presence'), false);
  assert.equal(Object.hasOwn(row, 'state'), false);
  assert.equal(Object.hasOwn(row, 'mainAgent'), false);
  for (const field of ['queue', 'target', 'desired', 'launchConfig', 'createdAt', 'contextPct']) assert.equal(row[field] ?? null, null);
  assert.equal(Object.hasOwn(row, 'duration'), false);
  assert.equal(Object.hasOwn(row, 'c4'), false);
  assert.equal(Object.hasOwn(row, 'preview'), false);
  const detail = await f.api.detail(row.id, new URLSearchParams(row.id === 'origin' ? 'include=' : ''));
  assert.equal(detail.presence, 'not_running');
  assert.equal(detail.state.kind, 'offline');
  assert.equal(detail.c4.preview, undefined);
  assert.match(detail.preview.text, /REDACTED/);
  assert.equal(JSON.stringify(value).includes('sk-123456789012345678901234'), false);
});

test('search returns a continuation only beyond the exact limit and catalog failures are explicit', async () => {
  assert.equal((await fixture({ size: 50 }).search('tg:')).nextCursor, null);
  const more = await fixture({ size: 51 }).search('tg:');
  assert.equal(more.items.length, 50);
  assert.ok(more.nextCursor);
  await assert.rejects(fixture({ failed: true }).search('tg:'), { code: 'unavailable', statusCode: 503 });
});

test('historical search result remains unknown when current live group list is unreadable', async () => {
  const value = await fixture({ listKnown: false }).search('tg:');
  const row = value.items.find(item => item.id === 'tg:older');
  assert.equal(Object.hasOwn(row, 'presence'), false);
  assert.equal(Object.hasOwn(row, 'reason'), false);
  assert.equal(row.state.kind, 'unknown');
  assert.ok(row.flags.unreadable.reasons.includes('group_list_failed'));
});

test('shared historical row does not invent sampled observations', async () => {
  const row = (await fixture().search('tg:older')).items[0];
  for (const field of ['presence', 'reason', 'duration']) assert.equal(Object.hasOwn(row, field), false);
  assert.equal(Object.hasOwn(row, 'mainAgent'), false);
});

test('display-name-only search returns no rows when no name matches', async () => {
  const f = fixture();
  assert.equal((await f.search('不存在')).total, 0);
  assert.equal(f.reads(), 1);
});

test('an older group whose last message came from the scheduler is found under the task name', async () => {
  const f = fixture();
  f.rows.push({ sessionGroup: 'scheduler:nightly', presence: 'not_running', name: { displayName: 'Nightly sweep' },
    preview: { text: 'Nightly sweep', source: { kind: 'scheduled_task' } } });
  const value = await f.search('Nightly');
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0].id, 'scheduler:nightly');
  assert.equal(value.items[0].displayName, 'Nightly sweep');
  const detail = await f.api.detail(value.items[0].id, new URLSearchParams(value.items[0].id === 'origin' ? 'include=' : ''));
  assert.equal(detail.preview.text, 'Nightly sweep');
  assert.deepEqual(detail.preview.source, { kind: 'scheduled_task' });
  assert.equal(f.reads(), 2, 'search and detail each use the existing catalog');
});
