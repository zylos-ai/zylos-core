import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture as storeFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { checkpoint, rotate, commit, list } from '../sync-files.js';
import { createBatchReceipt, createOriginRawReceipt, createOriginSummaryReceipt } from '../../../comm-bridge/scripts/c4-sync-batch.js';
import { projectConversation } from '../../../comm-bridge/scripts/c4-query-format.js';
import { renderStateSkeleton } from '../state-format.js';
import { advance } from '../origin-cursor.js';
import { acquire, memoryScope } from '../sync-lock.js';
import { loadTimezoneFromEnv, dateInTimeZone } from '../shared.js';
async function fixture(t, group = 'origin') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-workflow-progress-'));
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
  const database = { ...store, getConversationsByRange: (begin, end) => db.prepare('SELECT * FROM conversations WHERE id BETWEEN ? AND ? ORDER BY id').all(begin, end) };
  const batch = end => {
    const after = scope.scope === '*' ? store.getGlobalCoverageEnd() : store.getCoverageEnd(scope.scope);
    const rows = database.getConversationsByRange(after + 1, end)
      .filter(row => row.status === 'delivered' && (scope.scope === '*' || row.session_group === scope.scope));
    return createBatchReceipt(rows.map(projectConversation), { scope: scope.scope, after, end });
  };
  return { root, ...scope, db, store, seed, seedGroup, batch, tokens, settings: { env, token }, deps: { database } };
}
// The same reads and receipt functions as `c4-fetch.js --origin-sync ... --out`,
// plus the script's own session-log list, as an Origin worker submits them.
async function originRead(f, group, { limit, raw = true } = {}) {
  const summaries = f.store.queries.originSummaries(group);
  const summary = createOriginSummaryReceipt(summaries.rows, { scope: group, after: summaries.afterCheckpointId, end: summaries.checkpointId, coverageEnd: summaries.coverageEnd });
  const read = raw ? f.store.queries.originRaw(group, { after: summaries.coverageEnd, limit }) : null;
  const rawReceipt = read && createOriginRawReceipt(read.rows.map(projectConversation), { scope: group, after: read.after, end: read.end });
  return { summaries, rows: read?.rows ?? [], payload: { summary, raw: rawReceipt, inputs: await list({ env: f.settings.env, group }, f.deps) } };
}
const cursorRow = (f, group) => f.db.prepare('SELECT synced_id,checkpoint_id FROM origin_sync_cursors WHERE session_group=?').get(group) ?? null;
test('checkpoint invokes real transaction for group/global and preserves rejection code', async t => {
  for (const group of ['origin', null]) {
    const f = await fixture(t, group); f.seed(1); f.seed(2, 'origin', 'pending'); f.seed(3);
    const initialCount = f.db.prepare('SELECT count(*) AS n FROM checkpoints').get().n;
    const cp = await checkpoint({ ...f.settings, end: 1, summary: 'summary', batch: f.batch(1) }, f.deps);
    assert.equal(cp.session_group, group ?? '*');
    await assert.rejects(checkpoint({ ...f.settings, end: 3, summary: 'bad', batch: f.batch(3) }, f.deps), { code: 'CHECKPOINT_GAP' });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM checkpoints').get().n, initialCount + 1);
    const empty = await checkpoint({ ...f.settings, end: 1, noContent: true, batch: f.batch(1) }, f.deps);
    assert.equal(empty.no_content, 1); assert.equal(empty.summary, null);
    await assert.rejects(checkpoint({ ...f.settings, end: 1, summary: '', batch: f.batch(1) }, f.deps), { code: 'SUMMARY_INVALID' });
  }
});
test('Origin cursor advances both real DB columns or neither on invalid input/old token', async t => {
  const f = await fixture(t); f.seed(1, 'telegram:test'); f.seed(20, 'telegram:test');
  const cp = f.store.createCheckpoint('telegram:test', 1, 'summary');
  const { payload } = await originRead(f, 'telegram:test');
  const settings = { ...f.settings, token: f.tokens.origin, group: 'telegram:test', input: payload };
  assert.notEqual(f.tokens.origin, f.tokens.group);
  await assert.rejects(advance({ ...settings, token: f.tokens.group }, f.deps), { code: 'TOKEN_MISMATCH' });
  await assert.rejects(checkpoint({ ...f.settings, token: f.tokens.origin, end: 1, summary: 'wrong marker' }, f.deps), { code: 'TOKEN_MISMATCH' });
  assert.equal(cursorRow(f, 'telegram:test'), null);
  assert.deepEqual(await advance(settings, f.deps), { advanced: true, syncedId: 20, checkpointId: cp.id });
  const before = cursorRow(f, 'telegram:test');
  assert.deepEqual(before, { synced_id: 20, checkpoint_id: cp.id });
  await assert.rejects(advance(settings, f.deps), { code: 'INPUT_CHANGED' });
  await assert.rejects(advance({ ...settings, token: 'b'.repeat(32) }, f.deps), { code: 'TOKEN_MISMATCH' });
  assert.deepEqual(cursorRow(f, 'telegram:test'), before);
});

test('real consumer: 18 rows with inbox and 250 rows in two committed batches', async t => {
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
      const batch = f.batch(rows.at(-1).id);
      const inputs = await list(f.settings);
      const cp = await checkpoint({ ...f.settings, end: rows.at(-1).id, summary, batch }, f.deps);
      checkpointEnds.push(cp.end_conversation_id);
      const text = renderStateSkeleton({ scope: 'telegram:test', syncedAt: '2026-10-19T05:30:02Z' })
        .replace('coverage= ', `coverage=${cp.end_conversation_id} `).replace('inbox_committed= ', `inbox_committed=${id || ''} `);
      fs.writeFileSync(path.join(f.memoryDir, `state.md.${f.settings.token}.tmp`), text);
      await commit({ ...f.settings, input: { followedUpIds: [], inputs, batch } }, f.deps);
      if (id) assert.equal(fs.existsSync(path.join(f.memoryDir, `inbox.${id}.md`)), false);
    }
    assert.deepEqual(processed, Array.from({ length: total }, (_, i) => i + 1));
    assert.deepEqual(checkpointEnds, total === 18 ? [18] : [200, 250]);
    assert.match(f.store.getContentCheckpointsSince('telegram:test', 0)[0].summary, /commitment: finish quote/);
  }
});

test('single consumer: 16 source groups produce one global checkpoint', async t => {
  const f = await fixture(t, null);
  for (let id = 1; id <= 16; id++) f.seed(id, `channel:g${id}`);
  const range = f.store.getGlobalUnsummarizedRange();
  const rows = f.store.getGlobalUnsummarizedConversations({ upToConversationId: range.safeEnd, limit: 200 });
  assert.equal(rows.length, 16);
  const cp = await checkpoint({ ...f.settings, end: range.safeEnd, summary: 'all source groups', batch: f.batch(range.safeEnd) }, f.deps);
  assert.equal(cp.session_group, '*');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM checkpoints WHERE end_conversation_id IS NOT NULL').get().n, 1);
  assert.equal(f.store.getGlobalUnsummarizedRange().count, 0);
});

// consumer protocol, using real reads/checkpoints/cursors. Model
// selection and self-layer edits remain part of real-runtime integration.
test('Origin real late inbox summary remains discoverable without new messages', async t => {
  const f = await fixture(t), group = 'sleeping';
  f.seedGroup(group, 100);
  const candidate = f.store.getOriginSyncBacklog().groups.find(row => row.sessionGroup === group);
  const first = await originRead(f, group, { limit: 100 });
  assert.equal(first.rows.length, 100);
  const settings = { ...f.settings, token: f.tokens.origin, group };
  assert.deepEqual(await advance({ ...settings, input: first.payload }, f.deps), { advanced: true, syncedId: candidate.upTo, checkpointId: 0 });
  assert.equal(f.store.getOriginSyncBacklog().groups.some(row => row.sessionGroup === group), false);
  const cp = f.store.createCheckpoint(group, candidate.upTo, 'late inbox fact absent from raw messages');
  const late = f.store.getOriginSyncBacklog().groups.find(row => row.sessionGroup === group);
  assert.equal(late.count, 0); assert.equal(late.pendingCheckpoints, 1);
  const second = await originRead(f, group, { limit: 100 });
  assert.deepEqual(second.summaries.rows.map(row => row.summary), ['late inbox fact absent from raw messages']);
  assert.equal(second.rows.length, 0);
  await advance({ ...settings, input: second.payload }, f.deps);
  assert.equal(f.db.prepare('SELECT checkpoint_id FROM origin_sync_cursors WHERE session_group=?').get(group).checkpoint_id, cp.id);
  assert.equal(f.store.getOriginSyncBacklog().groups.some(row => row.sessionGroup === group), false);
});

test('Origin real fixed summary snapshot preserves raw coverage across later checkpoint', async t => {
  const f = await fixture(t), group = 'coverage';
  const records = f.seedGroup(group, 200);
  const first = f.store.createCheckpoint(group, records[99].id, 'covers 1-100');
  const summaries = f.store.queries.originSummaries(group);
  const summary = createOriginSummaryReceipt(summaries.rows, { scope: group, after: summaries.afterCheckpointId, end: summaries.checkpointId, coverageEnd: summaries.coverageEnd });
  const later = f.store.createCheckpoint(group, records[149].id, 'covers 101-150');
  const read = f.store.queries.originRaw(group, { after: summaries.coverageEnd, limit: 200 });
  assert.deepEqual(read.rows.map(row => row.id), records.slice(100).map(row => row.id));
  const raw = createOriginRawReceipt(read.rows.map(projectConversation), { scope: group, after: read.after, end: read.end });
  // A checkpoint created after the read does not invalidate the read's coverage.
  const result = await advance({ ...f.settings, token: f.tokens.origin, group, input: { summary, raw, inputs: await list({ env: f.settings.env, group }, f.deps) } }, f.deps);
  assert.deepEqual(result, { advanced: true, syncedId: records[199].id, checkpointId: first.id });
  assert.equal(summaries.checkpointId, first.id);
  assert.deepEqual(f.store.queries.originSummaries(group).rows.map(row => row.id), [later.id]);
});

test('Origin real 50-row budget keeps unsummarized sleeping groups and advances summary-only groups', async t => {
  const f = await fixture(t), groups = ['a-sleeping', 'b-raw', 'c-summary', 'd-summary', 'e-summary'];
  const records = Object.fromEntries(groups.map(group => [group, f.seedGroup(group, 30)]));
  for (const group of groups.slice(2)) f.store.createCheckpoint(group, records[group][9].id, `summary ${group}`);
  const candidates = f.store.getOriginSyncBacklog().groups;
  assert.deepEqual(candidates.map(row => row.sessionGroup), groups);
  let remaining = 50;
  const rawIds = [];
  for (const candidate of candidates) {
    const group = candidate.sessionGroup;
    const { rows, payload } = await originRead(f, group, { limit: remaining || undefined, raw: remaining > 0 });
    remaining -= rows.length; rawIds.push(...rows.map(row => row.id));
    const result = await advance({ ...f.settings, token: f.tokens.origin, group, input: payload }, f.deps);
    assert.equal(result.advanced, !!(rows.length || payload.summary.count));
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

test('Origin cursors are derived from verified receipts in each read shape', async t => {
  const f = await fixture(t);
  const settings = { ...f.settings, token: f.tokens.origin };
  // both: summaries and raw rows after their coverage
  const both = f.seedGroup('both', 6); const bothCp = f.store.createCheckpoint('both', both[2].id, 'first half');
  let read = await originRead(f, 'both');
  assert.deepEqual(read.rows.map(row => row.id), both.slice(3).map(row => row.id));
  assert.deepEqual(await advance({ ...settings, group: 'both', input: read.payload }, f.deps), { advanced: true, syncedId: both[5].id, checkpointId: bothCp.id });
  // raw only: no checkpoint, a limit stops the read and the cursor at its end
  const raw = f.seedGroup('raw', 5);
  read = await originRead(f, 'raw', { limit: 2 });
  assert.equal(read.payload.summary.count, 0); assert.equal(read.payload.raw.end, raw[1].id);
  await advance({ ...settings, group: 'raw', input: read.payload }, f.deps);
  assert.deepEqual(cursorRow(f, 'raw'), { synced_id: raw[1].id, checkpoint_id: 0 });
  // next run: the procedure reads from C (0 here, below the raw cursor); the
  // read starts at the cursor, returns only the unread rows, and advances again
  read = await originRead(f, 'raw');
  assert.equal(read.summaries.coverageEnd, 0); assert.equal(read.payload.raw.after, raw[1].id);
  assert.deepEqual(read.rows.map(row => row.id), raw.slice(2).map(row => row.id));
  assert.deepEqual(await advance({ ...settings, group: 'raw', input: read.payload }, f.deps), { advanced: true, syncedId: raw[4].id, checkpointId: 0 });
  assert.deepEqual(cursorRow(f, 'raw'), { synced_id: raw[4].id, checkpoint_id: 0 });
  // summary only: every raw row is already covered
  const covered = f.seedGroup('covered', 3); const coveredCp = f.store.createCheckpoint('covered', covered[2].id, 'all');
  read = await originRead(f, 'covered');
  assert.equal(read.payload.raw.count, 0);
  await advance({ ...settings, group: 'covered', input: read.payload }, f.deps);
  assert.deepEqual(cursorRow(f, 'covered'), { synced_id: covered[2].id, checkpoint_id: coveredCp.id });
  // budget exhausted: summary moves raw only to max(S, min(C, upTo))
  const budget = f.seedGroup('budget', 4); const budgetCp = f.store.createCheckpoint('budget', budget[1].id, 'two');
  read = await originRead(f, 'budget', { raw: false });
  assert.equal(read.payload.raw, null);
  await advance({ ...settings, group: 'budget', input: read.payload }, f.deps);
  assert.deepEqual(cursorRow(f, 'budget'), { synced_id: budget[1].id, checkpoint_id: budgetCp.id });
  // neither a new summary nor a raw read: nothing advances
  read = await originRead(f, 'budget', { raw: false });
  assert.deepEqual(await advance({ ...settings, group: 'budget', input: read.payload }, f.deps), { advanced: false });
  assert.deepEqual(cursorRow(f, 'budget'), { synced_id: budget[1].id, checkpoint_id: budgetCp.id });
});

test('Origin receipts include a non-delivered outbound row exactly as the read does', async t => {
  const f = await fixture(t), group = 'outbound';
  const rows = f.seedGroup(group, 2);
  f.db.prepare("UPDATE conversations SET status='pending' WHERE id=?").run(rows[1].id);
  const read = await originRead(f, group);
  assert.deepEqual(read.rows.map(row => [row.id, row.status]), [[rows[0].id, 'delivered'], [rows[1].id, 'pending']]);
  await advance({ ...f.settings, token: f.tokens.origin, group, input: read.payload }, f.deps);
  assert.deepEqual(cursorRow(f, group), { synced_id: rows[1].id, checkpoint_id: 0 });
});

// Real guarded Origin advance + private SQLite and session log. Run when receipt
// validation changes; unrelated changes may skip. No services are started.
test('Origin advance rejects altered, stale or mismatched receipts and leaves both cursors', async t => {
  const f = await fixture(t), group = 'telegram:neg';
  const records = f.seedGroup(group, 8); f.seedGroup('telegram:other', 2);
  f.store.createCheckpoint(group, records[1].id, 'start');
  const settings = { ...f.settings, token: f.tokens.origin, group };
  const scoped = await memoryScope({ ...f.settings.env, ZYLOS_SESSION_GROUP: group });
  fs.mkdirSync(path.join(scoped.memoryDir, 'sessions'), { recursive: true });
  const today = dateInTimeZone(new Date(), loadTimezoneFromEnv(scoped.root, { ...f.settings.env }));
  const log = path.join(scoped.memoryDir, 'sessions', `${today}.md`);
  fs.writeFileSync(log, '# log\n');
  assert.deepEqual((await list({ env: f.settings.env, group }, f.deps)).sessions.map(item => item.path), [path.resolve(log)]);
  const partial = await originRead(f, group, { limit: 3 });
  assert.equal(partial.payload.raw.end, records[4].id);
  const before = cursorRow(f, group);
  const rejects = async (input, code) => {
    await assert.rejects(advance({ ...settings, input }, f.deps), { code });
    assert.deepEqual(cursorRow(f, group), before);
  };
  const p = partial.payload, with_ = (part, change) => ({ ...p, [part]: { ...p[part], ...change } });
  await rejects(with_('raw', { sha256: 'f'.repeat(64) }), 'INPUT_CHANGED');
  await rejects(with_('raw', { end: records[7].id }), 'INPUT_CHANGED');
  await rejects(with_('raw', { count: 5 }), 'INPUT_CHANGED');
  await rejects(with_('raw', { count: -1 }), 'INVALID_INPUT');
  await rejects(with_('raw', { sha256: 'bad' }), 'INVALID_INPUT');
  await rejects(with_('summary', { sha256: 'f'.repeat(64) }), 'INPUT_CHANGED');
  await rejects(with_('summary', { end: p.summary.end + 1 }), 'INPUT_CHANGED');
  await rejects(with_('summary', { count: 0 }), 'INPUT_CHANGED');
  await rejects(with_('summary', { coverageEnd: records[3].id }), 'INPUT_CHANGED');
  // budget exhausted (no raw receipt): an enlarged coverage must not move the
  // raw cursor past rows that were never read
  await assert.rejects(advance({ ...settings, input: { ...with_('summary', { coverageEnd: records[6].id }), raw: null } }, f.deps),
    { code: 'INPUT_CHANGED', message: /coverage is not the coverage of its read/ });
  assert.deepEqual(cursorRow(f, group), before);
  await rejects(with_('raw', { after: p.raw.after + 1 }), 'INPUT_CHANGED');
  await rejects({ ...with_('summary', { scope: 'telegram:other' }) }, 'INVALID_INPUT');
  await rejects({ ...p, extra: true }, 'INVALID_INPUT');
  await rejects({ ...p, raw: { ...p.raw, coverageEnd: 1 } }, 'INVALID_INPUT');
  // session-log set: one more, one fewer, or another group's list
  await rejects({ ...p, inputs: { ...p.inputs, sessions: [...p.inputs.sessions, { path: `${log}.extra` }] } }, 'INPUT_CHANGED');
  await rejects({ ...p, inputs: { ...p.inputs, sessions: [] } }, 'INPUT_CHANGED');
  await rejects({ ...p, inputs: await list({ env: f.settings.env, group: 'telegram:other' }, f.deps) }, 'INPUT_CHANGED');
  // content changed after the read
  const original = f.db.prepare('SELECT content FROM conversations WHERE id=?').get(records[3].id).content;
  f.db.prepare('UPDATE conversations SET content=? WHERE id=?').run('edited', records[3].id);
  await rejects(p, 'INPUT_CHANGED');
  f.db.prepare('UPDATE conversations SET content=? WHERE id=?').run(original, records[3].id);
  f.db.prepare('UPDATE checkpoints SET summary=? WHERE session_group=?').run('edited', group);
  await rejects(p, 'INPUT_CHANGED');
  f.db.prepare('UPDATE checkpoints SET summary=? WHERE session_group=?').run('start', group);
  // an appended session log is not a changed input; the cursor stops at the read end
  fs.appendFileSync(log, '- later line\n');
  assert.deepEqual(await advance({ ...settings, input: p }, f.deps), { advanced: true, syncedId: records[4].id, checkpointId: p.summary.end });
  // after another advance, the old receipt no longer starts at the cursor
  const moved = cursorRow(f, group);
  await assert.rejects(advance({ ...settings, input: p }, f.deps), { code: 'INPUT_CHANGED' });
  // a summary-only replay is rejected by the summary cursor alone
  await assert.rejects(advance({ ...settings, input: { ...p, raw: null } }, f.deps), { code: 'INPUT_CHANGED', message: /summary cursor/ });
  assert.deepEqual(cursorRow(f, group), moved);
});

// Real guarded checkpoint + private SQLite store; run for receipt validation
// changes, skip for unrelated changes. No tmux or PM2 process is started.
test('checkpoint rejects conversation edits after export without writing group or global progress', async t => {
  for (const group of ['origin', null]) {
    const f = await fixture(t, group);
    f.seed(1);
    const batch = f.batch(1);
    const before = f.db.prepare('SELECT count(*) AS n FROM checkpoints').get().n;
    f.db.prepare('UPDATE conversations SET content=? WHERE id=1').run('edited after export');
    await assert.rejects(checkpoint({ ...f.settings, end: 1, summary: 'stale', batch }, f.deps), { code: 'INPUT_CHANGED' });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM checkpoints').get().n, before);
    assert.equal(group === null ? f.store.getGlobalCoverageEnd() : f.store.getCoverageEnd(group), 0);
    await assert.rejects(checkpoint({ ...f.settings, end: 1, summary: 'invalid', batch: { ...batch, sha256: 'bad' } }, f.deps), { code: 'INVALID_INPUT' });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM checkpoints').get().n, before);
  }
});
