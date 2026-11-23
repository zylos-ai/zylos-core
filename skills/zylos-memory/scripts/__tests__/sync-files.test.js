import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup, rotate, list, commit as guardedCommit, checkpoint, prepare, extractAbsorbedBlock } from '../sync-files.js';
import { createBatchReceipt } from '../../../comm-bridge/scripts/c4-sync-batch.js';
import { renderStateSkeleton } from '../state-format.js';
import { acquire, memoryScope } from '../sync-lock.js';

const segment = '20261019T053002123Z';
async function fixture(t, group = 'telegram:test') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-workflow-files-'));
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_RUN_ID: 'test-run' };
  delete env.ZYLOS_SESSION_GROUP;
  if (group !== null) env.ZYLOS_SESSION_GROUP = group;
  const scope = await memoryScope(env), kind = group === null ? 'global' : 'group';
  fs.mkdirSync(scope.memoryDir, { recursive: true }); fs.mkdirSync(scope.runDir, { recursive: true });
  const token = await acquire({ env, kind }, { currentRunId: async () => env.ZYLOS_RUN_ID });
  const settings = { token, env }, warnings = [], deps = { now: () => Date.parse('2026-10-19T05:30:02.000Z'), warning: value => warnings.push(value), database: {
    getConversationsByRange: () => [],
    getLatestContentCheckpoint: () => ({ end_conversation_id: 0 }),
  } };
  const state = path.join(scope.memoryDir, 'state.md'), temporary = `${state}.${token}.tmp`;
  const skeleton = (ids = [], extra = {}) => renderStateSkeleton({ scope: scope.scope, syncedAt: '2026-10-19T05:30:02.000Z', absorbed: ids.length ? { runId: 'run-1', followUp: 'group', rows: ids.map(id => ({ id, timestamp: '2026-10-19 05:30:02', channel: 'telegram', endpointId: 'x', content: id === 2 ? '汉'.repeat(400) + '\nend' : `text ${id}` })) } : null, ...extra }).replace('coverage= ', 'coverage=0 ');
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

test('commit prevents a worker future timestamp from skipping Singapore session logs', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, '.env'), 'TZ=Asia/Singapore\n');
  const sessions = path.join(f.memoryDir, 'sessions');
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, '2026-11-14.md'), 'session still needing sync\n');
  const settings = { ...f.settings, now: () => Date.parse('2026-11-14T10:06:00Z') };
  const temporary = f.skeleton([], { syncedAt: '2026-11-14T18:10:00Z' });
  // Reproduce the reader consequence: 18:10Z converts to the next Singapore day.
  fs.writeFileSync(f.state, temporary);
  assert.deepEqual((await list(settings)).sessions, []);
  fs.writeFileSync(f.temporary, temporary);
  await commit({ ...settings, input: { followedUpIds: [] } }, { ...f.deps, now: () => Date.parse('2026-11-14T10:05:56.123Z') });
  assert.deepEqual((await list(settings)).sessions.map(item => path.basename(item.path)), ['2026-11-14.md']);
});

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

test('invalid follow-up input does not replace state or remove segments', async t => {
  const f = await fixture(t), original = write(f);
  for (const input of [undefined, '', '{', {}, [], { followedUpIds: null }, { followedUpIds: [0] }, { followedUpIds: [1.2] }, { followedUpIds: ['1'] }, { followedUpIds: [9] }]) {
    await assert.rejects(commit({ ...f.settings, input }, f.deps), { code: 'INVALID_INPUT' });
    assert.equal(fs.readFileSync(f.state, 'utf8'), original);
    assert.equal(fs.readFileSync(path.join(f.memoryDir, `inbox.${segment}.md`), 'utf8'), 'absorbed');
  }
});

test('old token cannot commit, cleanup, rotate, prepare or checkpoint', async t => {
  const f = await fixture(t), original = write(f), settings = { ...f.settings, token: 'b'.repeat(32) };
  for (const operation of [() => prepare(settings), () => cleanup(settings, f.deps), () => rotate(settings, f.deps), () => commit({ ...settings, input: { followedUpIds: [] } }, f.deps), () => checkpoint({ ...settings, end: 0, summary: 'x' }, { ...f.deps, database: { createCheckpoint() { assert.fail('old token wrote checkpoint'); } } })]) {
    await assert.rejects(operation(), { code: 'TOKEN_MISMATCH' });
    assert.equal(fs.readFileSync(f.state, 'utf8'), original);
  }
});

// Exercise the actual commit guard with stale file snapshots;
// rejection must preserve official state, temporary output, and input bytes.
test('commit rejects changed, omitted, or extra inputs before publishing or deleting', async t => {
  for (const mutation of ['segment content', 'segment path', 'new segment', 'omitted segment', 'extra segment']) {
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
      const temporary = fs.readFileSync(f.temporary, 'utf8');
      await assert.rejects(guardedCommit({ ...f.settings, input: { followedUpIds: [], inputs, batch: createBatchReceipt([], { scope: f.scope, after: 0, end: 0 }) } }, f.deps), { code: 'INPUT_CHANGED' });
      assert.equal(fs.readFileSync(f.state, 'utf8'), original);
      assert.equal(fs.readFileSync(f.temporary, 'utf8'), temporary);
      assert.equal(fs.readFileSync(piece, 'utf8'), mutation === 'segment content' ? 'modified' : 'absorbed');
      assert.equal(fs.readFileSync(session, 'utf8'), 'session one');
      if (mutation === 'new segment') assert.equal(fs.readFileSync(path.join(f.memoryDir, `inbox.${segment}-1.md`), 'utf8'), 'arrived later');
    });
  }
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
  for (const [end, receipt, code] of [[1, { ...batch, sha256: '0'.repeat(64) }, 'INPUT_CHANGED'], [2, batch, 'INVALID_INPUT'], [1, { ...batch, after: 1 }, 'INPUT_CHANGED']]) {
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
      let clockCalls = 0;
      await assert.rejects(guardedCommit({ ...f.settings, input: { followedUpIds: [], inputs: await list(f.settings), batch } }, { ...f.deps, database, now: () => { clockCalls++; return f.deps.now(); } }), { code: mutation === 'end' ? 'INVALID_INPUT' : 'INPUT_CHANGED' });
      assert.equal(clockCalls, 0, 'Rejected commit must not sample the publication clock');
      assert.equal(fs.readFileSync(f.state, 'utf8'), original);
      assert.equal(fs.readFileSync(path.join(f.memoryDir, `inbox.${segment}.md`), 'utf8'), 'absorbed');
      assert.equal(fs.existsSync(f.temporary), true);
    });
  }
});
