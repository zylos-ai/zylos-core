import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cleanup, rotate, list, commit as guardedCommit, checkpoint, extractAbsorbedBlock } from '../sync-files.js';
import { createBatchReceipt } from '../../../comm-bridge/scripts/c4-sync-batch.js';
import { renderStateSkeleton } from '../state-format.js';
import { acquire, memoryScope } from '../sync-lock.js';
import { fixture as storeFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';

const segment = '20261019T053002123Z';
const digest = content => createHash('sha256').update(content).digest('hex');
const entryDigest = entries => digest(entries.map(entry => entry.raw).join(''));
async function fixture(t, group = 'telegram:test') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-workflow-files-'));
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_RUN_ID: 'test-run' };
  delete env.ZYLOS_SESSION_GROUP;
  if (group !== null) env.ZYLOS_SESSION_GROUP = group;
  const scope = await memoryScope(env), kind = group === null ? 'global' : 'group';
  fs.mkdirSync(scope.memoryDir, { recursive: true }); fs.mkdirSync(scope.runDir, { recursive: true });
  const token = await acquire({ env, kind }, { currentRunId: async () => env.ZYLOS_RUN_ID });
  const settings = { token, env }, warnings = [], deps = { warning: value => warnings.push(value), database: {
    getConversationsByRange: () => [],
    getLatestContentCheckpoint: () => ({ end_conversation_id: 0 }),
  } };
  const state = path.join(scope.memoryDir, 'state.md'), temporary = `${state}.${token}.tmp`;
  const skeleton = (ids = [], extra = {}) => renderStateSkeleton({ scope: scope.scope, syncedAt: '2026-10-19T05:30:02Z', absorbed: ids.length ? { runId: 'run-1', followUp: 'group', rows: ids.map(id => ({ id, timestamp: '2026-10-19 05:30:02', channel: 'telegram', endpointId: 'x', content: id === 2 ? '汉'.repeat(400) + '\nend' : `text ${id}` })) } : null, ...extra }).replace('coverage= ', 'coverage=0 ');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { ...scope, root, settings, deps, state, temporary, skeleton, warnings };
}
const write = (f, ids = [1, 2, 3]) => {
  const official = f.skeleton(ids);
  fs.writeFileSync(f.state, official);
  fs.writeFileSync(f.temporary, f.skeleton().replace('inbox_committed= ', `inbox_committed=${segment} `).replace('## Headline\n', '## Headline\nUpdated\n'));
  fs.writeFileSync(path.join(f.memoryDir, `inbox.${segment}.md`), 'absorbed');
  return official;
};
async function commit(settings, deps) {
  if (settings.input && typeof settings.input === 'object' && !Array.isArray(settings.input)) {
    const inputs = await list(settings);
    const { scope } = await memoryScope(settings.env);
    const batch = createBatchReceipt([], { scope, after: 0, end: 0 });
    settings = { ...settings, input: { ...settings.input, inputs, batch } };
  }
  return guardedCommit(settings, deps);
}

test('commit preserves original bytes/title and removes only supplied IDs, including duplicates', async t => {
  const f = await fixture(t), original = write(f), block = extractAbsorbedBlock(original);
  await commit({ ...f.settings, input: { followedUpIds: [1, 1] } }, f.deps);
  const actual = fs.readFileSync(f.state, 'utf8'), after = extractAbsorbedBlock(actual);
  assert.equal(after.title, block.title); assert.deepEqual(after.entries, block.entries.slice(1));
  assert.match(actual, /Updated/); assert.equal(fs.existsSync(path.join(f.memoryDir, `inbox.${segment}.md`)), false);
  fs.writeFileSync(f.temporary, f.skeleton());
  await commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps);
  assert.deepEqual(extractAbsorbedBlock(fs.readFileSync(f.state, 'utf8')), after);
  fs.writeFileSync(f.temporary, f.skeleton());
  await commit({ ...f.settings, input: { followedUpIds: [2, 3] } }, f.deps);
  assert.doesNotMatch(fs.readFileSync(f.state, 'utf8'), /Mode-switch messages/);
});

// Real guarded commit in a private working-memory directory. Run for absorbed
// heading compatibility/commit changes; unrelated changes may skip. The outer
// runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and the fixture reclaims its root.
test('commit preserves legacy Chinese absorbed summaries until all entries are followed up', async t => {
  const f = await fixture(t), current = write(f);
  const legacy = '- [切换来信] run=run-1 共 3 条（#1–#3）；回复：c4-send.js --absorbed-reply run-1 <id>；全文：c4-fetch.js --absorbed --run-id run-1 --id <id>';
  const official = current.replace(/^- \[Mode-switch messages\].*$/m, legacy);
  fs.writeFileSync(f.state, official);
  const before = extractAbsorbedBlock(official);
  assert.equal(before.entries.length, 3); assert.equal(before.title.trimEnd(), legacy);
  await commit({ ...f.settings, input: { followedUpIds: [1] } }, f.deps);
  const partial = extractAbsorbedBlock(fs.readFileSync(f.state, 'utf8'));
  assert.equal(partial.title, before.title); assert.deepEqual(partial.entries.map(item => item.id), [2, 3]);
  fs.writeFileSync(f.temporary, f.skeleton());
  await commit({ ...f.settings, input: { followedUpIds: [2, 3] } }, f.deps);
  const complete = fs.readFileSync(f.state, 'utf8');
  assert.equal(extractAbsorbedBlock(complete).entries.length, 0); assert.equal(complete.includes('[切换来信]'), false);
});

test('commit uses body despite corrupt official header and strips temporary copies with warning', async t => {
  const f = await fixture(t), original = write(f);
  fs.writeFileSync(f.state, original.replace('zylos-state v1', 'broken'));
  fs.writeFileSync(f.temporary, f.skeleton([9, 10]).replace('inbox_committed= ', `inbox_committed=${segment} `).replace('## Headline\n', '## Headline\nModel text\n'));
  await commit({ ...f.settings, input: { followedUpIds: [1] } }, f.deps);
  const actual = fs.readFileSync(f.state, 'utf8');
  assert.deepEqual(extractAbsorbedBlock(actual).entries, extractAbsorbedBlock(original).entries.slice(1));
  assert.match(actual, /Model text/); assert.equal(f.warnings.length, 1); assert.doesNotMatch(actual, /#9 |#10 /);
});

test('extraction is only at Pending start, stops at non-entry, preserves CRLF bytes', async t => {
  const f = await fixture(t), original = write(f).replaceAll('\n', '\r\n');
  const block = extractAbsorbedBlock(original);
  const interrupted = original.replace(block.entries[1].raw, 'ordinary task\r\n' + block.entries[1].raw);
  fs.writeFileSync(f.state, interrupted);
  await commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps);
  assert.deepEqual(extractAbsorbedBlock(fs.readFileSync(f.state, 'utf8')).entries, block.entries.slice(0, 1));
  fs.writeFileSync(f.state, original.replace('## Pending\r\n', '## Pending\r\nordinary task\r\n'));
  fs.writeFileSync(f.temporary, f.skeleton());
  await commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps);
  assert.equal(extractAbsorbedBlock(fs.readFileSync(f.state, 'utf8')).entries.length, 0);
});

test('invalid follow-up input does not replace state or remove segments', async t => {
  const f = await fixture(t), original = write(f);
  for (const input of [undefined, '', '{', {}, [], { followedUpIds: null }, { followedUpIds: [0] }, { followedUpIds: [1.2] }, { followedUpIds: ['1'] }, { followedUpIds: [9] }]) {
    await assert.rejects(commit({ ...f.settings, input }, f.deps), { code: 'INVALID_INPUT' });
    assert.equal(fs.readFileSync(f.state, 'utf8'), original);
    assert.equal(fs.readFileSync(path.join(f.memoryDir, `inbox.${segment}.md`), 'utf8'), 'absorbed');
  }
});

test('missing/invalid temporary state rejects before publication and deletion', async t => {
  const f = await fixture(t), original = write(f);
  for (const content of [null, 'broken', f.skeleton().replace('## Commitments', 'wrong'), f.skeleton().replace('scope=telegram:test', 'scope=origin')]) {
    if (content === null) fs.unlinkSync(f.temporary); else fs.writeFileSync(f.temporary, content);
    await assert.rejects(commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps), { code: 'STATE_DOCUMENT_INVALID' });
    assert.equal(fs.readFileSync(f.state, 'utf8'), original);
    assert.equal(fs.existsSync(path.join(f.memoryDir, `inbox.${segment}.md`)), true);
  }
});

test('absent official file accepts empty follow-ups, unknown ID remains invalid', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.temporary, f.skeleton());
  await assert.rejects(commit({ ...f.settings, input: { followedUpIds: [1] } }, f.deps), { code: 'INVALID_INPUT' });
  await commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps);
  assert.equal(fs.readFileSync(f.state, 'utf8'), f.skeleton());
});

test('unreadable segment rejects before state replacement', async t => {
  const f = await fixture(t); write(f);
  const target = path.join(f.memoryDir, `inbox.${segment}.md`);
  fs.unlinkSync(target); fs.mkdirSync(target);
  await assert.rejects(commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps));
  assert.doesNotMatch(fs.readFileSync(f.state, 'utf8'), /Updated/);
});

test('post-publication segment deletion warns and later cleanup retries', async t => {
  const f = await fixture(t); write(f);
  const target = path.join(f.memoryDir, `inbox.${segment}.md`), unlink = fs.unlinkSync;
  const failure = t.mock.method(fs, 'unlinkSync', file => {
    if (file === target) throw Object.assign(new Error('delete denied'), { code: 'EACCES' });
    return unlink(file);
  });
  const result = await commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps);
  assert.equal(result.committed, true);
  assert.match(fs.readFileSync(f.state, 'utf8'), /Updated/);
  assert.equal(fs.existsSync(target), true);
  assert.match(f.warnings[0], /Could not remove committed segment/);
  failure.mock.restore();
  await cleanup(f.settings, f.deps);
  assert.equal(fs.existsSync(target), false);
});

test('cleanup trusts only valid headers and retains own temporary file', async t => {
  const f = await fixture(t); write(f);
  fs.writeFileSync(f.state, 'broken');
  fs.writeFileSync(path.join(f.memoryDir, 'state.md.old.tmp'), 'old');
  await cleanup(f.settings, f.deps);
  assert.equal(fs.existsSync(path.join(f.memoryDir, `inbox.${segment}.md`)), true);
  assert.equal(fs.existsSync(f.temporary), true);
  assert.equal(fs.existsSync(path.join(f.memoryDir, 'state.md.old.tmp')), false);
  assert.equal(f.warnings.length, 1);
});

test('rotate skips missing/empty input; list returns sorted uncommitted segments', async t => {
  const f = await fixture(t), inbox = path.join(f.memoryDir, 'inbox.md');
  assert.equal(await rotate(f.settings, f.deps), null);
  fs.writeFileSync(inbox, ''); assert.equal(await rotate(f.settings, f.deps), null);
  fs.writeFileSync(inbox, 'entry'); const id = await rotate(f.settings, f.deps);
  assert.match(id, /^\d{8}T\d{9}Z/); assert.equal(fs.readFileSync(path.join(f.memoryDir, `inbox.${id}.md`), 'utf8'), 'entry');
  fs.writeFileSync(path.join(f.memoryDir, `inbox.${segment}.md`), 'old');
  fs.writeFileSync(f.state, f.skeleton().replace('inbox_committed= ', `inbox_committed=${segment} `));
  const listed = await list(f.settings);
  assert.deepEqual(listed.segments.map(item => item.id), [id]);
  assert.equal(listed.segments[0].path, path.join(f.memoryDir, `inbox.${id}.md`));
  assert.equal(listed.segments[0].bytes, 5);
  fs.writeFileSync(f.state, 'broken'); assert.deepEqual((await list(f.settings)).segments.map(item => item.id), [id, segment].sort());
});

test('old token cannot commit, cleanup, rotate or checkpoint', async t => {
  const f = await fixture(t), original = write(f), settings = { ...f.settings, token: 'b'.repeat(32) };
  for (const operation of [() => cleanup(settings, f.deps), () => rotate(settings, f.deps), () => commit({ ...settings, input: { followedUpIds: [] } }, f.deps), () => checkpoint({ ...settings, end: 0, summary: 'x' }, { ...f.deps, database: { createCheckpoint() { assert.fail('old token wrote checkpoint'); } } })]) {
    await assert.rejects(operation(), { code: 'TOKEN_MISMATCH' });
    assert.equal(fs.readFileSync(f.state, 'utf8'), original);
  }
});

test('entries retain 990 original lines through a second empty-follow-up cycle', async t => {
  for (const group of ['telegram:test', 'origin', null]) {
    const f = await fixture(t, group), original = write(f, Array.from({ length: 1000 }, (_, i) => i + 1));
    const block = extractAbsorbedBlock(original);
    await commit({ ...f.settings, input: { followedUpIds: Array.from({ length: 10 }, (_, i) => i + 1) } }, f.deps);
    const after = extractAbsorbedBlock(fs.readFileSync(f.state, 'utf8'));
    assert.equal(after.title, block.title); assert.equal(after.entries.length, 990);
    assert.equal(entryDigest(after.entries), entryDigest(block.entries.slice(10)));
    fs.writeFileSync(f.temporary, f.skeleton());
    await commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps);
    const retained = extractAbsorbedBlock(fs.readFileSync(f.state, 'utf8'));
    assert.equal(retained.title, after.title); assert.equal(retained.entries.length, 990);
    assert.equal(entryDigest(retained.entries), entryDigest(after.entries));
  }
});

test('cleanup deletion failure is a failed step, not a successful cleanup', async t => {
  const f = await fixture(t); write(f);
  fs.writeFileSync(f.state, fs.readFileSync(f.temporary, 'utf8'));
  const target = path.join(f.memoryDir, `inbox.${segment}.md`);
  fs.unlinkSync(target); fs.mkdirSync(target);
  await assert.rejects(cleanup(f.settings, f.deps));
  assert.equal(fs.existsSync(target), true);
});

// renderer and extractor share line syntax; retained block is first.
test('round trip and model Pending text preserve the exact retained document', async t => {
  const f = await fixture(t), original = write(f, [1, 2, 3]);
  const block = extractAbsorbedBlock(original);
  assert.equal(block.entries.length, 3);
  assert.equal(block.title + block.entries.map(entry => entry.raw).join(''), original.split('## Pending\n\n')[1].split('\n## Commitments')[0]);
  const temporary = f.skeleton().replace('inbox_committed= ', `inbox_committed=${segment} `).replace('## Pending\n', '## Pending\n\n- model task\n');
  fs.writeFileSync(f.temporary, temporary);
  await commit({ ...f.settings, input: { followedUpIds: [1] } }, f.deps);
  const expected = temporary.replace('- model task', block.title + block.entries.slice(1).map(entry => entry.raw).join('') + '- model task');
  assert.equal(fs.readFileSync(f.state, 'utf8'), expected);
});

// Integration boundary: imported list/commit use real private files and lock;
// only the checkpoint database is injected. Run under the isolation launcher.
test('list describes exact segment and daily session bytes with absolute paths', async t => {
  const f = await fixture(t); write(f);
  const sessions = path.join(f.memoryDir, 'sessions'); fs.mkdirSync(sessions);
  const session = path.join(sessions, '2026-10-19.md');
  fs.writeFileSync(session, 'session\r\n'); fs.writeFileSync(path.join(sessions, 'notes.md'), 'ignored');
  const inputs = await list(f.settings);
  assert.equal(inputs.scope, f.scope); assert.equal(inputs.segments.length, 1); assert.equal(inputs.sessions.length, 1);
  assert.equal(inputs.statePath, f.state);
  assert.deepEqual(inputs.segments[0], { id: segment, path: path.join(f.memoryDir, `inbox.${segment}.md`), bytes: 8, sha256: digest('absorbed') });
  assert.deepEqual(inputs.sessions[0], { path: session, bytes: 9, sha256: digest('session\r\n') });
  await guardedCommit({ ...f.settings, input: { followedUpIds: [], inputs, batch: createBatchReceipt([], { scope: f.scope, after: 0, end: 0 }) } }, f.deps);
  assert.match(fs.readFileSync(f.state, 'utf8'), /Updated/);
  assert.equal(fs.existsSync(session), true);
});

// Exercise the actual commit guard with stale file snapshots and changed headers;
// rejection must preserve official state, temporary output, and input bytes.
test('commit rejects changed, omitted, or extra inputs before publishing or deleting', async t => {
  for (const mutation of ['segment content', 'segment path', 'new segment', 'omitted segment', 'extra segment', 'state omitted segment', 'state extra segment']) {
    await t.test(mutation, async t => {
      const f = await fixture(t), original = write(f);
      const piece = path.join(f.memoryDir, `inbox.${segment}.md`);
      const sessions = path.join(f.memoryDir, 'sessions'); fs.mkdirSync(sessions);
      const session = path.join(sessions, '2026-10-19.md'); fs.writeFileSync(session, 'session one');
      const inputs = await list(f.settings);
      if (mutation === 'segment content') fs.writeFileSync(piece, 'modified');
      if (mutation === 'segment path') inputs.segments[0].path = path.join(f.memoryDir, 'other.md');
      if (mutation === 'new segment') fs.writeFileSync(path.join(f.memoryDir, `inbox.${segment}-1.md`), 'arrived later');
      if (mutation === 'omitted segment') inputs.segments = [];
      if (mutation === 'extra segment') inputs.segments.push({ ...inputs.segments[0], id: `${segment}-1` });
      if (mutation === 'state omitted segment') fs.writeFileSync(f.temporary, f.skeleton());
      if (mutation === 'state extra segment') fs.writeFileSync(f.temporary, fs.readFileSync(f.temporary, 'utf8').replace(`inbox_committed=${segment} `, `inbox_committed=${segment},${segment}-1 `));
      const temporary = fs.readFileSync(f.temporary, 'utf8');
      await assert.rejects(guardedCommit({ ...f.settings, input: { followedUpIds: [], inputs, batch: createBatchReceipt([], { scope: f.scope, after: 0, end: 0 }) } }, f.deps), { code: 'INPUT_CHANGED' });
      assert.equal(fs.readFileSync(f.state, 'utf8'), original);
      assert.equal(fs.readFileSync(f.temporary, 'utf8'), temporary);
      assert.equal(fs.readFileSync(piece, 'utf8'), mutation === 'segment content' ? 'modified' : 'absorbed');
      assert.equal(fs.readFileSync(session, 'utf8'), 'session one');
    });
  }
});

test('commit ignores session appends and metadata while matching segment identity', async t => {
  const f = await fixture(t); write(f);
  const sessions = path.join(f.memoryDir, 'sessions'); fs.mkdirSync(sessions);
  const session = path.join(sessions, '2026-10-19.md'); fs.writeFileSync(session, 'first\n');
  const inputs = await list(f.settings);
  fs.appendFileSync(session, 'later\n');
  fs.writeFileSync(path.join(sessions, '2026-10-20.md'), 'new day\n');
  inputs.segments[0].bytes = -1;
  inputs.statePath = 'metadata only';
  const result = await guardedCommit({ ...f.settings, input: { followedUpIds: [], inputs, batch: createBatchReceipt([], { scope: f.scope, after: 0, end: 0 }) } }, f.deps);
  assert.equal(result.committed, true);
  assert.equal(fs.readFileSync(session, 'utf8'), 'first\nlater\n');
});

test('list hashes non-ASCII bytes rather than JavaScript character counts', async t => {
  const f = await fixture(t); write(f);
  const content = '\u6c49\u5b57\ud83d\ude00\r\n';
  fs.writeFileSync(path.join(f.memoryDir, `inbox.${segment}.md`), content);
  const item = (await list(f.settings)).segments[0];
  assert.equal(item.bytes, Buffer.byteLength(content));
  assert.notEqual(item.bytes, content.length);
  assert.equal(item.sha256, digest(Buffer.from(content)));
});

test('list uses the synced date in configured timezone and a seven-calendar-day fallback', async t => {
  const f = await fixture(t); write(f);
  fs.writeFileSync(path.join(f.root, '.env'), 'TZ=America/Los_Angeles\n');
  const sessions = path.join(f.memoryDir, 'sessions'); fs.mkdirSync(sessions);
  for (const day of ['2026-03-03', '2026-03-04', '2026-03-09', '2026-03-10', '2026-03-11']) fs.writeFileSync(path.join(sessions, `${day}.md`), day);
  const settings = { ...f.settings, now: () => Date.parse('2026-03-11T01:00:00Z') };
  const dates = value => value.sessions.map(item => path.basename(item.path));
  fs.writeFileSync(f.state, f.skeleton([], { syncedAt: '2026-03-10T01:00:00Z' }));
  assert.deepEqual(dates(await list(settings)), ['2026-03-09.md', '2026-03-10.md']);
  fs.writeFileSync(f.state, f.skeleton([], { syncedAt: '2026-03-03T12:00:00Z' })
    .replace(' | synced_at=2026-03-03T12:00:00Z', '').replace(' -->', ' | synced_at=2026-03-03T12:00:00Z -->'));
  assert.deepEqual(dates(await list(settings)), ['2026-03-03.md', '2026-03-04.md', '2026-03-09.md', '2026-03-10.md']);
  for (const official of [null, 'broken', f.skeleton().replace('scope=telegram:test', 'scope=origin')]) {
    if (official === null) fs.unlinkSync(f.state); else fs.writeFileSync(f.state, official);
    assert.deepEqual(dates(await list(settings)), ['2026-03-04.md', '2026-03-09.md', '2026-03-10.md']);
  }
});

test('Origin group listing reads only candidate sessions since the cursor date', async t => {
  const f = await fixture(t, 'origin');
  const target = await memoryScope({ ...f.settings.env, ZYLOS_SESSION_GROUP: 'telegram:candidate' });
  fs.mkdirSync(path.join(target.memoryDir, 'sessions'), { recursive: true });
  // Directories at file paths prove candidate state and inbox are never read.
  fs.mkdirSync(path.join(target.memoryDir, 'state.md'));
  fs.mkdirSync(path.join(target.memoryDir, `inbox.${segment}.md`));
  const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-18', '2026-10-19', '2026-10-20'];
  for (const day of days) fs.writeFileSync(path.join(target.memoryDir, 'sessions', `${day}.md`), day);
  const { db, store } = storeFixture(t);
  const settings = { ...f.settings, group: 'telegram:candidate', now: () => Date.parse('2026-10-20T12:00:00Z') };
  const names = result => result.sessions.map(item => path.basename(item.path));
  // No Origin cursor yet: the latest seven calendar days, including today.
  const fresh = await list(settings, { database: store });
  assert.deepEqual(Object.keys(fresh).sort(), ['scope', 'sessions']);
  assert.equal(fresh.scope, settings.group);
  assert.deepEqual(names(fresh), days.slice(2).map(day => `${day}.md`));
  db.prepare('INSERT INTO group_heads(session_group,head_id) VALUES(?,1)').run(settings.group);
  db.prepare("INSERT INTO conversations(id,direction,channel,content,status,session_group) VALUES(1,'in','system','new','delivered',?)").run(settings.group);
  store.advanceOriginSyncCursor(settings.group, { syncedId: 0, checkpointId: 0 });
  db.prepare('UPDATE origin_sync_cursors SET updated_at=? WHERE session_group=?').run(Date.parse('2026-10-19T05:30:02Z') / 1000, settings.group);
  // With a cursor: from the date of its last update; the worker supplies no boundary.
  assert.deepEqual(names(await list(settings, { database: store })), ['2026-10-19.md', '2026-10-20.md']);
  assert.deepEqual(names(await list({ ...settings, since: '2026-10-12' }, { database: store })), ['2026-10-19.md', '2026-10-20.md']);
  await assert.rejects(list({ ...settings, group: '../escape' }, { database: store }), { code: 'SESSION_GROUP_INVALID' });
  const worker = await fixture(t);
  await assert.rejects(list({ ...worker.settings, group: settings.group }, { database: store }), { code: 'SCOPE_UNBOUND' });
  await assert.rejects(guardedCommit({ ...settings, input: { followedUpIds: [] } }, f.deps), { code: 'INVALID_INPUT' });
});

// Real lock + receipt verifier, with database reads/writes injected to observe
// whether rejected receipts reach the checkpoint publication boundary.
test('checkpoint accepts a verified batch and rejects hash, end, and coverage mismatches', async t => {
  const f = await fixture(t), calls = [];
  const row = { id: 1, timestamp: '2026-10-19 05:30:02', direction: 'in', channel: 'telegram', endpoint_id: 'test', content: 'message', session_group: f.scope, status: 'delivered' };
  const batch = createBatchReceipt([row], { scope: f.scope, after: 0, end: 1 });
  const database = { getCoverageEnd: scope => { assert.equal(scope, f.scope); return 0; }, getConversationsByRange: (begin, end) => { assert.equal(begin, 1); assert.equal(end, 1); return [row]; }, createCheckpoint: (...args) => { calls.push(args); return 42; } };
  assert.equal(await checkpoint({ ...f.settings, end: 1, summary: 'summary', batch }, { database }), 42);
  assert.deepEqual(calls, [[f.scope, 1, 'summary', { noContent: false }]]);
  for (const [end, receipt, code] of [[1, { ...batch, sha256: '0'.repeat(64) }, 'INVALID_INPUT'], [2, batch, 'INVALID_INPUT'], [1, { ...batch, after: 1 }, 'INPUT_CHANGED']]) {
    await assert.rejects(checkpoint({ ...f.settings, end, summary: 'rejected', batch: receipt }, { database }), { code });
    assert.equal(calls.length, 1);
  }
});

// Real commit + receipt verifier must reject before filesystem publication when
// the injected checkpoint history or the supplied receipt disagrees.
test('commit rejects a changed batch, wrong end, or missing completed checkpoint without deleting input', async t => {
  for (const mutation of ['hash', 'end', 'checkpoint']) {
    await t.test(mutation, async t => {
      const f = await fixture(t), original = write(f);
      const batch = createBatchReceipt([], { scope: f.scope, after: 0, end: 0 });
      if (mutation === 'hash') batch.sha256 = '0'.repeat(64);
      if (mutation === 'end') batch.end = 1;
      const database = { ...f.deps.database, getLatestContentCheckpoint: () => mutation === 'checkpoint' ? null : { end_conversation_id: 0 } };
      await assert.rejects(guardedCommit({ ...f.settings, input: { followedUpIds: [], inputs: await list(f.settings), batch } }, { ...f.deps, database }), { code: mutation === 'checkpoint' ? 'INPUT_CHANGED' : 'INVALID_INPUT' });
      assert.equal(fs.readFileSync(f.state, 'utf8'), original);
      assert.equal(fs.readFileSync(path.join(f.memoryDir, `inbox.${segment}.md`), 'utf8'), 'absorbed');
      assert.equal(fs.existsSync(f.temporary), true);
    });
  }
});
