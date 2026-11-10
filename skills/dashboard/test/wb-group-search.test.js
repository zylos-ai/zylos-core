import test from 'node:test';
import assert from 'node:assert/strict';
import { searchGroups, searchTerm } from '../src/lib/workbench/group-search.js';
import { Sanitizer } from '../src/lib/sanitizer.js';
import { olderRow } from '../public/js/wb/older-row.js';

function fixture({ size = 3, failed = false, listKnown = true } = {}) {
  const calls = [], names = new Map([['tg:older', 'Named historical group']]);
  const live = { sessionGroup: 'tg:live', state: { kind: 'busy' }, marker: 'snapshot-row' };
  const rows = Array.from({ length: size }, (_, i) => ({ sessionGroup: i === 0 ? 'tg:live' : i === 1 ? 'tg:older' : `tg:old${i}`,
    componentName: 'telegram', sessionGroupName: 'older', lastActivityAt: 1, preview: { text: 'sk-123456789012345678901234', timestamp: 1 } }));
  const deps = { sanitizer: new Sanitizer('/isolated'), runC4Db: async args => {
    calls.push(args); return failed ? { ok: false, reason: 'c4_groups_failed' } : { ok: true, data: rows };
  }, getSnapshot: async () => { calls.push(['snapshot']); return { rows: [live], listKnown }; },
  displayNames: { listAll: () => names, search: term => { calls.push(['names', term]); return term === '竞品' || term === '--b' ? [{ sessionGroup: 'tg:older' }] : []; } } };
  return { deps, calls, live };
}

for (const q of ['', ' ', 'x'.repeat(65)]) test(`invalid search has no source reads: length ${q.length}`, async () => {
  const f = fixture(), value = await searchGroups(q, f.deps);
  assert.deepEqual(value, { rows: [], truncated: false }); assert.equal(f.calls.length, 0);
});

for (const q of ['oc_', 'a--b', 'AbC']) test(`keyable search passes one bounded key match argument: ${q}`, async () => {
  const f = fixture(), value = await searchGroups(q, f.deps);
  assert.deepEqual(f.calls[0], ['groups', '--key-match', q, '--limit', '50', '--json']);
  assert.equal(value.rows[0], f.live); assert.equal(value.rows[1].name, 'Named historical group');
  const row = value.rows[1];
  assert.equal(row.presence, 'not_running'); assert.equal(row.state.kind, 'not_running');
  for (const field of ['queue', 'target', 'desired', 'launchConfig', 'createdAt', 'contextPct', 'duration']) assert.equal(row[field], null);
  assert.equal(row.c4.preview, undefined); assert.match(row.preview.text, /REDACTED/);
  assert.equal(JSON.stringify(value).includes('sk-123456789012345678901234'), false);
  assert.equal(value.truncated, false);
});

for (const q of ['竞品', '--b']) test(`non-keyable term searches display names only: ${q}`, async () => {
  const f = fixture(), value = await searchGroups(q, f.deps);
  assert.equal(f.calls.some(args => args.includes('--key-match')), false);
  assert.equal(value.rows.length, 1); assert.equal(value.rows[0].sessionGroup, 'tg:older');
});

test('exact source limit marks truncated and failed key source gives a gateway error', async () => {
  const f = fixture({ size: 50 }); assert.equal((await searchGroups('tg:', f.deps)).truncated, true);
  await assert.rejects(searchGroups('tg:', fixture({ failed: true }).deps), { code: 'group_search_failed', reason: 'c4_groups_failed', statusCode: 502 });
});

test('historical search result remains unknown when current live group list is unreadable', async () => {
  const f = fixture({ listKnown: false }), value = await searchGroups('tg:', f.deps);
  const row = value.rows.find(item => item.sessionGroup === 'tg:older');
  assert.equal(row.presence, 'unknown'); assert.equal(row.reason, 'group_list_failed');
  assert.equal(row.state.kind, 'unknown'); assert.equal(row.state.reason, 'group_list_failed');
});

test('shared historical row does not invent sampled observations', () => {
  const row = olderRow('tg:x', { listKnown: true });
  assert.equal(row.presence, 'not_running'); assert.equal(row.reason, null); assert.deepEqual(row.tools, []);
  assert.deepEqual(searchTerm(' --b '), { term: '--b', keyable: false });
});


test('display-name-only search returns no rows when no name matches', async () => {
  const f = fixture(), value = await searchGroups('不存在', f.deps);
  assert.deepEqual(value, { rows: [], truncated: false });
  assert.equal(f.calls.some(args => args.includes('--key-match')), false);
  assert.ok(f.calls.some(args => args[0] === 'names' && args[1] === '不存在'));
});

test('an older group whose last message came from the scheduler is found under the task name', async () => {
  const f = fixture(), asked = [];
  const scheduled = { sessionGroup: 'scheduler:nightly', componentName: 'scheduler', sessionGroupName: 'nightly', lastActivityAt: 1,
    preview: { timestamp: 1, channel: 'scheduler', text: '[Scheduled Task: task-ab12cd34 #3]\nsweep the queue', message: 'sweep the queue',
      messageSource: { kind: 'scheduled_task', taskId: 'task-ab12cd34' } } };
  const deps = { ...f.deps, runC4Db: async () => ({ ok: true, data: [{ sessionGroup: 'tg:live', preview: scheduled.preview }, scheduled] }),
    namesOfTasks: async items => { asked.push(...items.map(item => item.sessionGroup)); return new Map([['task-ab12cd34', 'Nightly sweep']]); } };
  const value = await searchGroups('scheduler', deps);
  const row = value.rows.find(item => item.sessionGroup === 'scheduler:nightly');
  assert.equal(row.preview.text, 'Nightly sweep');
  assert.deepEqual(row.preview.source, { kind: 'scheduled_task' });
  assert.deepEqual(asked, ['scheduler:nightly'], 'a group already in the snapshot is not looked up again');
});
