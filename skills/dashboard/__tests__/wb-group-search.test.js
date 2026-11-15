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
  return { api, rows, snapshot, reads: () => reads };
}

for (const q of ['', ' ', 'x'.repeat(65)]) test(`invalid search has no source reads: length ${q.length}`, async () => {
  const f = fixture();
  assert.deepEqual(await f.api.search(q), { rows: [], truncated: false });
  assert.equal(f.reads(), 0);
});

for (const q of ['oc_', 'a--b', 'AbC']) test(`key search matches literal case-insensitive IDs: ${q}`, async () => {
  const f = fixture();
  f.rows[0].sessionGroup = 'telegram:' + q.toUpperCase();
  const value = await f.api.search(q);
  assert.equal(f.reads(), 1);
  assert.equal(value.rows.length, 1);
  assert.equal(value.rows[0].id, f.rows[0].sessionGroup);
  assert.equal(value.rows[0].presence, 'running');
  assert.equal(value.rows[0].state.kind, 'idle');
  assert.equal(value.truncated, false);
});

for (const q of ['竞品', '--b']) test(`display-name search includes offline catalog rows: ${q}`, async () => {
  const f = fixture(), value = await f.api.search(q);
  assert.equal(value.rows.length, 1);
  const row = value.rows[0];
  assert.equal(row.sessionGroup, 'tg:older');
  assert.equal(row.displayName, 'Named historical group 竞品 --b');
  assert.equal(row.presence, 'not_running');
  assert.equal(row.state.kind, 'offline');
  assert.equal(row.side, 'offline');
  assert.equal(Object.hasOwn(row, 'mainAgent'), false);
  for (const field of ['queue', 'target', 'desired', 'launchConfig', 'createdAt', 'contextPct']) assert.equal(row[field] ?? null, null);
  assert.equal(row.duration, null);
  assert.equal(row.c4.preview, undefined);
  assert.match(row.preview.text, /REDACTED/);
  assert.equal(JSON.stringify(value).includes('sk-123456789012345678901234'), false);
});

test('search marks truncation only beyond the exact limit and catalog failures are explicit', async () => {
  assert.equal((await fixture({ size: 50 }).api.search('tg:')).truncated, false);
  const more = await fixture({ size: 51 }).api.search('tg:');
  assert.equal(more.rows.length, 50);
  assert.equal(more.truncated, true);
  await assert.rejects(fixture({ failed: true }).api.search('tg:'), { code: 'GROUP_CATALOG_UNREADABLE', statusCode: 502 });
});

test('historical search result remains unknown when current live group list is unreadable', async () => {
  const value = await fixture({ listKnown: false }).api.search('tg:');
  const row = value.rows.find(item => item.sessionGroup === 'tg:older');
  assert.equal(row.presence, 'unknown');
  assert.equal(row.reason, 'group_list_failed');
  assert.equal(row.state.kind, 'unknown');
  assert.ok(row.flags.unreadable.reasons.includes('group_list_failed'));
});

test('shared historical row does not invent sampled observations', async () => {
  const row = (await fixture().api.search('tg:older')).rows[0];
  assert.equal(row.presence, 'not_running');
  assert.equal(row.reason, null);
  assert.equal(row.duration, null);
  assert.equal(Object.hasOwn(row, 'mainAgent'), false);
});

test('display-name-only search returns no rows when no name matches', async () => {
  const f = fixture();
  assert.deepEqual(await f.api.search('不存在'), { rows: [], truncated: false });
  assert.equal(f.reads(), 1);
});

test('an older group whose last message came from the scheduler is found under the task name', async () => {
  const f = fixture();
  f.rows.push({ sessionGroup: 'scheduler:nightly', presence: 'not_running', name: { displayName: 'Nightly sweep' },
    preview: { text: 'Nightly sweep', source: { kind: 'scheduled_task' } } });
  const value = await f.api.search('Nightly');
  assert.equal(value.rows.length, 1);
  assert.equal(value.rows[0].sessionGroup, 'scheduler:nightly');
  assert.equal(value.rows[0].preview.text, 'Nightly sweep');
  assert.deepEqual(value.rows[0].preview.source, { kind: 'scheduled_task' });
  assert.equal(f.reads(), 1, 'search uses the task name already present in the catalog');
});
