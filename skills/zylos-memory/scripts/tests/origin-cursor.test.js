import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture as storeFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { checkpoint, rotate, commit } from '../sync-files.js';
import { renderStateSkeleton } from '../state-format.js';
import { advance } from '../origin-cursor.js';
import { acquire, memoryScope } from '../sync-lock.js';
async function fixture(t, group = 'origin') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p07-progress-'));
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_RUN_ID: 'progress-test' };
  delete env.ZYLOS_SESSION_GROUP; if (group !== null) env.ZYLOS_SESSION_GROUP = group;
  const scope = await memoryScope(env);
  fs.mkdirSync(scope.runDir, { recursive: true });
  const tokens = {};
  for (const kind of group === 'origin' ? ['origin', 'group'] : group === null ? ['global'] : ['group']) tokens[kind] = await acquire({ env, kind }, { currentRunId: async () => env.ZYLOS_RUN_ID });
  const token = tokens[group === null ? 'global' : 'group'];
  const { db, store } = storeFixture(t, {}, path.join(root, 'fixture.db'));
  t.after(() => { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const seed = (id, sessionGroup = 'origin', status = 'delivered') => db.prepare("INSERT INTO conversations(id,direction,channel,content,status,session_group) VALUES(?,'in','system','test',?,?)").run(id, status, sessionGroup);
  const seedGroup = (group, count) => db.transaction(() => {
    const insert = db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('out',?,'test','delivered',?) RETURNING *");
    const rows = Array.from({ length: count }, () => insert.get(group, group));
    db.prepare('INSERT INTO group_heads(session_group,head_id) VALUES(?,?)').run(group, rows.at(-1).id);
    return rows;
  })();
  return { root, ...scope, db, store, seed, seedGroup, tokens, settings: { env, token }, deps: { database: store, currentRunId: async () => env.ZYLOS_RUN_ID } };
}
test('IB51 checkpoint invokes real M7 transaction for group/global and preserves rejection code', async t => {
  for (const group of ['origin', null]) {
    const f = await fixture(t, group); f.seed(1); f.seed(2, 'origin', 'pending'); f.seed(3);
    const initialCount = f.db.prepare('SELECT count(*) AS n FROM checkpoints').get().n;
    const cp = await checkpoint({ ...f.settings, end: 1, summary: 'summary' }, f.deps);
    assert.equal(cp.session_group, group ?? '*');
    await assert.rejects(checkpoint({ ...f.settings, end: 3, summary: 'bad' }, f.deps), { code: 'CHECKPOINT_GAP' });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM checkpoints').get().n, initialCount + 1);
    const empty = await checkpoint({ ...f.settings, end: 1, noContent: true }, f.deps);
    assert.equal(empty.no_content, 1); assert.equal(empty.summary, null);
    await assert.rejects(checkpoint({ ...f.settings, end: 1, summary: '' }, f.deps), { code: 'SUMMARY_INVALID' });
  }
});
test('IB51 Origin cursor advances both real DB columns or neither on invalid input/old token', async t => {
  const f = await fixture(t); f.seed(1, 'telegram:test'); f.seed(20, 'telegram:test');
  const cp = f.store.createCheckpoint('telegram:test', 1, 'summary');
  const settings = { ...f.settings, token: f.tokens.origin, group: 'telegram:test', syncedId: 20, checkpointId: cp.id };
  assert.notEqual(settings.syncedId, settings.checkpointId);
  assert.notEqual(f.tokens.origin, f.tokens.group);
  await assert.rejects(advance({ ...settings, token: f.tokens.group }, f.deps), { code: 'TOKEN_MISMATCH' });
  await assert.rejects(checkpoint({ ...f.settings, token: f.tokens.origin, end: 1, summary: 'wrong marker' }, f.deps), { code: 'TOKEN_MISMATCH' });
  await advance(settings, f.deps);
  const read = () => f.db.prepare('SELECT * FROM origin_sync_cursors').get(), before = read();
  assert.equal(before.synced_id, 20); assert.equal(before.checkpoint_id, cp.id);
  await assert.rejects(advance({ ...settings, syncedId: 0 }, f.deps), { code: 'CURSOR_INVALID' });
  await assert.rejects(advance({ ...settings, checkpointId: cp.id + 1 }, f.deps), { code: 'CURSOR_INVALID' });
  await assert.rejects(advance({ ...settings, token: 'b'.repeat(32) }, f.deps), { code: 'TOKEN_MISMATCH' });
  assert.deepEqual(read(), before);
});

test('P07 real M7 consumer: 18 rows with inbox and 250 rows in two committed batches', async t => {
  for (const total of [18, 250]) {
    const f = await fixture(t, 'telegram:test');
    fs.mkdirSync(f.memoryDir, { recursive: true });
    f.db.transaction(() => { for (let id = 1; id <= total; id++) f.seed(id, 'telegram:test'); })();
    fs.writeFileSync(path.join(f.memoryDir, 'inbox.md'), '### 2026-10-19\n- 05:30 commitment: finish quote\n');
    const processed = [], checkpointEnds = [];
    while (f.store.getUnsummarizedRange('telegram:test').count) {
      const { safeEnd } = f.store.getUnsummarizedRange('telegram:test');
      const rows = f.store.getUnsummarizedConversations('telegram:test', { upToConversationId: safeEnd, limit: 200 });
      processed.push(...rows.map(row => row.id));
      const id = await rotate(f.settings, f.deps);
      const summary = `messages ${rows[0].id}-${rows.at(-1).id}${id ? '; commitment: finish quote' : ''}`;
      const cp = await checkpoint({ ...f.settings, end: rows.at(-1).id, summary }, f.deps);
      checkpointEnds.push(cp.end_conversation_id);
      const text = renderStateSkeleton({ scope: 'telegram:test', syncedAt: '2026-10-19T05:30:02Z' })
        .replace('coverage= ', `coverage=${cp.end_conversation_id} `).replace('inbox_committed= ', `inbox_committed=${id || ''} `);
      fs.writeFileSync(path.join(f.memoryDir, `state.md.${f.settings.token}.tmp`), text);
      await commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps);
      if (id) assert.equal(fs.existsSync(path.join(f.memoryDir, `inbox.${id}.md`)), false);
    }
    assert.deepEqual(processed, Array.from({ length: total }, (_, i) => i + 1));
    assert.deepEqual(checkpointEnds, total === 18 ? [18] : [200, 250]);
    assert.match(f.store.getContentCheckpointsSince('telegram:test', 0)[0].summary, /commitment: finish quote/);
  }
});

test('P07 single consumer: 16 source groups produce one global checkpoint', async t => {
  const f = await fixture(t, null);
  for (let id = 1; id <= 16; id++) f.seed(id, `channel:g${id}`);
  const range = f.store.getGlobalUnsummarizedRange();
  const rows = f.store.getGlobalUnsummarizedConversations({ upToConversationId: range.safeEnd, limit: 200 });
  assert.equal(rows.length, 16);
  const cp = await checkpoint({ ...f.settings, end: range.safeEnd, summary: 'all source groups' }, f.deps);
  assert.equal(cp.session_group, '*');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM checkpoints WHERE end_conversation_id IS NOT NULL').get().n, 1);
  assert.equal(f.store.getGlobalUnsummarizedRange().count, 0);
});

// M5 7.2 consumer protocol, using real P01 reads/checkpoints/cursors. Model
// selection and self-layer edits remain part of real-runtime integration.
test('Origin real P01 late inbox summary remains discoverable without new messages', async t => {
  const f = await fixture(t), group = 'sleeping';
  f.seedGroup(group, 100);
  const candidate = f.store.getOriginSyncBacklog().groups.find(row => row.sessionGroup === group);
  const rows = f.store.getOriginSyncConversations(group, { afterConversationId: 0, rawAfter: 0, upToConversationId: candidate.upTo, limit: 100 });
  assert.equal(rows.length, 100);
  const settings = { ...f.settings, token: f.tokens.origin, group };
  await advance({ ...settings, syncedId: candidate.upTo, checkpointId: 0 }, f.deps);
  assert.equal(f.store.getOriginSyncBacklog().groups.some(row => row.sessionGroup === group), false);
  const cp = f.store.createCheckpoint(group, candidate.upTo, 'late inbox fact absent from raw messages');
  const late = f.store.getOriginSyncBacklog().groups.find(row => row.sessionGroup === group);
  assert.equal(late.count, 0); assert.equal(late.pendingCheckpoints, 1);
  const summaries = f.store.queries.originSummaries(group);
  assert.deepEqual(summaries.rows.map(row => row.summary), ['late inbox fact absent from raw messages']);
  await advance({ ...settings, syncedId: candidate.upTo, checkpointId: summaries.checkpointId }, f.deps);
  assert.equal(f.db.prepare('SELECT checkpoint_id FROM origin_sync_cursors WHERE session_group=?').get(group).checkpoint_id, cp.id);
  assert.equal(f.store.getOriginSyncBacklog().groups.some(row => row.sessionGroup === group), false);
});

test('Origin real P01 fixed summary snapshot preserves raw coverage across later checkpoint', async t => {
  const f = await fixture(t), group = 'coverage';
  const records = f.seedGroup(group, 200);
  const first = f.store.createCheckpoint(group, records[99].id, 'covers 1-100');
  const snapshot = f.store.queries.originSummaries(group);
  const later = f.store.createCheckpoint(group, records[149].id, 'covers 101-150');
  const rows = f.store.getOriginSyncConversations(group, { afterConversationId: 0, rawAfter: snapshot.coverageEnd, upToConversationId: records[199].id, limit: 200 });
  assert.deepEqual(rows.map(row => row.id), records.slice(100).map(row => row.id));
  await advance({ ...f.settings, token: f.tokens.origin, group, syncedId: records[199].id, checkpointId: snapshot.checkpointId }, f.deps);
  assert.equal(snapshot.checkpointId, first.id);
  assert.deepEqual(f.store.queries.originSummaries(group).rows.map(row => row.id), [later.id]);
});

test('Origin real P01 50-row budget keeps unsummarized sleeping groups and advances summary-only groups', async t => {
  const f = await fixture(t), groups = ['a-sleeping', 'b-raw', 'c-summary', 'd-summary', 'e-summary'];
  const records = Object.fromEntries(groups.map(group => [group, f.seedGroup(group, 30)]));
  for (const group of groups.slice(2)) f.store.createCheckpoint(group, records[group][9].id, `summary ${group}`);
  const candidates = f.store.getOriginSyncBacklog().groups;
  assert.deepEqual(candidates.map(row => row.sessionGroup), groups);
  let remaining = 50;
  const rawIds = [];
  for (const candidate of candidates) {
    const group = candidate.sessionGroup;
    const summaries = f.store.queries.originSummaries(group);
    const rows = remaining ? f.store.getOriginSyncConversations(group, { afterConversationId: candidate.cursorFrom,
      rawAfter: summaries.coverageEnd, upToConversationId: candidate.upTo, limit: remaining }) : [];
    remaining -= rows.length; rawIds.push(...rows.map(row => row.id));
    const syncedId = rows.at(-1)?.id ?? Math.max(candidate.cursorFrom, Math.min(summaries.coverageEnd, candidate.upTo));
    if (rows.length || summaries.rows.length) await advance({ ...f.settings, token: f.tokens.origin, group, syncedId, checkpointId: summaries.checkpointId }, f.deps);
  }
  assert.equal(rawIds.length, 50);
  assert.deepEqual(rawIds, [...records[groups[0]], ...records[groups[1]].slice(0, 20)].map(row => row.id));
  for (const group of groups.slice(2)) {
    const cursor = f.db.prepare('SELECT * FROM origin_sync_cursors WHERE session_group=?').get(group);
    assert.equal(cursor.synced_id, records[group][9].id); assert(cursor.checkpoint_id > 0);
  }
  const backlog = f.store.getOriginSyncBacklog().groups;
  assert.equal(backlog.some(row => row.sessionGroup === 'a-sleeping'), false);
  assert.equal(backlog.find(row => row.sessionGroup === 'b-raw').count, 10);
  const next = backlog.find(row => row.sessionGroup === 'b-raw');
  const rows = f.store.getOriginSyncConversations(next.sessionGroup, { afterConversationId: next.cursorFrom, rawAfter: next.rawFrom, upToConversationId: next.upTo, limit: 50 });
  assert.deepEqual(rows.map(row => row.id), records['b-raw'].slice(20).map(row => row.id));
});
