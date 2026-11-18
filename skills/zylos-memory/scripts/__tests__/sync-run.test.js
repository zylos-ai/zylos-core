import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture as storeFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { startRun, summarizeRun, finishRun, closeRun } from '../sync-run.js';
import { memoryScope, markerPath } from '../sync-lock.js';
import { renderStateSkeleton, parseStateHeader } from '../state-format.js';
import { createMemoryEditor } from '../memory-mcp-server.js';

// Real SQLite + guarded files + restricted editor. The repository runner isolates
// HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; this fixture additionally owns its DB and root.
// No tmux/PM2/server is launched (live identity is injected at acquire only).
// Run for group Sync orchestration, receipt persistence or recovery changes;
// skip for unrelated modules. Every root is reclaimed by the test lifecycle.
async function fixture(t, count = 2, coverage = 0) {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(process.env[key], key);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-run-'));
  const { db, store } = storeFixture(t);
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_RUN_ID: 'sync-run-fixture', ZYLOS_SESSION_GROUP: 'telegram:test' };
  const scope = await memoryScope(env);
  assert.ok(scope.memoryDir.startsWith(root + path.sep));
  assert.ok(scope.runDir.startsWith(root + path.sep));
  assert.notEqual(root, process.env.ZYLOS_DIR);
  fs.mkdirSync(scope.memoryDir, { recursive: true });
  const state = path.join(scope.memoryDir, 'state.md'), inbox = path.join(scope.memoryDir, 'inbox.md');
  const original = renderStateSkeleton({ scope: scope.scope, syncedAt: '2026-11-01T00:00:00Z' }).replace('coverage= ', `coverage=${coverage} `);
  fs.writeFileSync(state, original); fs.writeFileSync(inbox, 'fact: keep rotated note\n');
  const insert = db.prepare("INSERT INTO conversations(id,direction,channel,content,status,session_group) VALUES(?,'in','telegram',?,'delivered',?)");
  for (let id = 1; id <= count; id++) insert.run(id, `message ${id}`, scope.scope);
  const database = Object.assign(store, { getDb: () => db, getConversationsByRange: (begin, end) => db.prepare('SELECT * FROM conversations WHERE id BETWEEN ? AND ? ORDER BY id').all(begin, end) });
  const deps = { database, currentRunId: async () => env.ZYLOS_RUN_ID };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { ...scope, coverage, root, env, deps, database, db, state, inbox, original, editor: createMemoryEditor(env) };
}
async function draft(f, run, coverage = run.end) {
  const settings = { env: f.env, token: run.token };
  const prepared = await summarizeRun(settings, 'Every message and rotated note reconciled.', f.deps);
  const result = await f.editor({ op: prepared.prepared ? 'edit' : 'create', path: 'state.md.tmp', token: run.token,
    ...(prepared.prepared ? { expected: `coverage=${f.coverage} `, replacement: `coverage=${coverage} ` } : { replacement: f.original.replace(`coverage=${f.coverage} `, `coverage=${coverage} `) }) });
  assert.equal(result.ok, true);
  return settings;
}

test('no backlog releases without cleaning drafts, rotating inbox or creating exports', async t => {
  const f = await fixture(t, 0);
  fs.mkdirSync(f.runDir, { recursive: true });
  const stale = path.join(f.memoryDir, 'state.md.stale.tmp'); fs.writeFileSync(stale, 'preserve');
  const result = await startRun({ env: f.env }, f.deps);
  assert.equal(result.noInput, true); assert.equal(result.released, true);
  assert.equal(fs.readFileSync(f.inbox, 'utf8'), 'fact: keep rotated note\n');
  assert.equal(fs.readFileSync(stale, 'utf8'), 'preserve');
  assert.equal(fs.existsSync(markerPath(f.runDir, 'group')), false);
  assert.equal(fs.readdirSync(f.runDir).some(name => name.startsWith('group-sync-')), false);
});

test('bounded batch and saved inputs publish through the restricted editor without copied receipts', async t => {
  const f = await fixture(t, 3);
  fs.mkdirSync(path.join(f.root, '.zylos'));
  fs.writeFileSync(path.join(f.root, '.zylos/config.json'), JSON.stringify({ sync_batch_limit: 2 }));
  f.db.prepare("UPDATE conversations SET channel='dashboard', content='[quote c4_id=1]' || char(10) || 'reply' WHERE id=2").run();
  const run = await startRun({ env: f.env }, f.deps);
  assert.equal(run.end, 2); assert.equal(run.batchLimit, 2); assert.equal(run.receipt, undefined);
  assert.match(fs.readFileSync(run.batch.path, 'utf8'), /count=2 upTo=2/);
  assert.match(fs.readFileSync(run.batch.path, 'utf8'), /quoting c4_id=1 .*message 1/);
  assert.doesNotMatch(fs.readFileSync(run.batch.path, 'utf8'), /message 3/);
  for (const item of [run.batch, run.summaries, run.state, ...run.inputs.segments]) {
    const bytes = fs.readFileSync(item.path);
    assert.equal(bytes.length, item.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
  }
  assert.equal(fs.statSync(run.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(run.batch.path).mode & 0o777, 0o600);
  const settings = await draft(f, run);
  const result = await finishRun(settings, { followedUpIds: [] }, f.deps);
  assert.equal(result.committed, true); assert.equal(result.released, true);
  assert.equal(parseStateHeader(fs.readFileSync(f.state, 'utf8'), { scope: f.scope }).coverage, 2);
  assert.equal(fs.existsSync(run.directory), false);
  assert.equal(fs.existsSync(run.inputs.segments[0].path), false);
  assert.equal(f.database.getUnsummarizedRange(f.scope).count, 1);
});

test('expired interrupted runs recover all summaries and rotated notes and remove stale drafts and exports', async t => {
  const f = await fixture(t, 4, 1);
  fs.mkdirSync(path.join(f.root, '.zylos'));
  fs.writeFileSync(path.join(f.root, '.zylos/config.json'), JSON.stringify({ sync_batch_limit: 1 }));
  f.database.createCheckpoint(f.scope, 1, 'already in state');
  let previous;
  for (let end = 2; end <= 3; end++) {
    const run = await startRun({ env: f.env }, f.deps);
    assert.equal(run.end, end);
    if (previous) assert.equal(fs.existsSync(previous.directory), false);
    await summarizeRun({ env: f.env, token: run.token }, `recovered summary ${end}`, f.deps);
    const lock = markerPath(f.runDir, 'group');
    const marker = JSON.parse(fs.readFileSync(lock)); marker.expiresAt = 0;
    fs.writeFileSync(lock, JSON.stringify(marker)); previous = run;
  }
  const run = await startRun({ env: f.env }, f.deps);
  assert.equal(fs.existsSync(previous.directory), false);
  assert.equal(fs.existsSync(`${f.state}.${previous.token}.tmp`), false);
  const summaries = JSON.parse(fs.readFileSync(run.summaries.path));
  assert.equal(summaries.length, 2); assert.equal(summaries[0].summary, 'recovered summary 2'); assert.equal(summaries[1].summary, 'recovered summary 3');
  assert.equal(run.inputs.segments.length, 1);
  assert.equal(fs.readFileSync(run.inputs.segments[0].path, 'utf8'), 'fact: keep rotated note\n');
  const settings = await draft(f, run);
  assert.equal((await finishRun(settings, { followedUpIds: [] }, f.deps)).committed, true);
});

test('saved receipts reject changed rows and segments and token replacement prevents stale publication', async t => {
  for (const change of ['row', 'segment', 'token']) {
    const f = await fixture(t); const run = await startRun({ env: f.env }, f.deps);
    const settings = await draft(f, run);
    if (change === 'row') f.db.prepare("UPDATE conversations SET content='changed' WHERE id=1").run();
    if (change === 'segment') fs.appendFileSync(run.inputs.segments[0].path, 'changed');
    let replacement;
    if (change === 'token') {
      const lock = markerPath(f.runDir, 'group'), marker = JSON.parse(fs.readFileSync(lock));
      replacement = 'a'.repeat(32); marker.token = replacement; fs.writeFileSync(lock, JSON.stringify(marker));
    }
    await assert.rejects(finishRun(settings, { followedUpIds: [] }, f.deps), { code: change === 'token' ? 'TOKEN_MISMATCH' : 'INPUT_CHANGED' });
    assert.equal(fs.readFileSync(f.state, 'utf8'), f.original);
    assert.equal(fs.existsSync(run.inputs.segments[0].path), true);
    await closeRun(settings);
    if (replacement) assert.equal(JSON.parse(fs.readFileSync(markerPath(f.runDir, 'group'))).token, replacement);
  }
});

test('a corrected prepare preserves a completed checkpoint instead of replaying it', async t => {
  const f = await fixture(t), run = await startRun({ env: f.env }, f.deps);
  const settings = { env: f.env, token: run.token };
  fs.writeFileSync(`${f.state}.${run.token}.tmp`, 'existing draft');
  await assert.rejects(summarizeRun(settings, 'summary', f.deps), { code: 'EXISTS' });
  assert.equal(f.database.getContentCheckpointsSince(f.scope, 0).length, 1);
  // Remove only our test-created collision; production editor cannot overwrite it.
  fs.unlinkSync(`${f.state}.${run.token}.tmp`);
  assert.equal((await summarizeRun(settings, 'summary', f.deps)).mode, 'edit');
  assert.equal(f.database.getContentCheckpointsSince(f.scope, 0).length, 1);
  await closeRun(settings);
});

test('aborting before summary preserves unread rotated notes for the next run', async t => {
  const f = await fixture(t);
  const first = await startRun({ env: f.env }, f.deps);
  assert.equal((await closeRun({ env: f.env, token: first.token })).released, true);
  assert.equal(fs.existsSync(first.directory), false);
  assert.equal(fs.readFileSync(f.state, 'utf8'), f.original);
  assert.equal(f.database.getContentCheckpointsSince(f.scope, 0).length, 0);
  fs.writeFileSync(f.inbox, 'fact: new note during the failed run\n');
  const next = await startRun({ env: f.env }, f.deps);
  assert.equal(next.inputs.segments.length, 2);
  assert.equal(fs.readFileSync(next.inputs.segments[0].path, 'utf8'), 'fact: keep rotated note\n');
  assert.equal(fs.readFileSync(next.inputs.segments[1].path, 'utf8'), 'fact: new note during the failed run\n');
  const settings = await draft(f, next);
  assert.equal((await finishRun(settings, { followedUpIds: [] }, f.deps)).committed, true);
});

test('start failure removes private exports and releases without consuming inbox', async t => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.root, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.zylos/config.json'), 'invalid JSON');
  await assert.rejects(startRun({ env: f.env }, f.deps), error => {
    assert.equal(error.cleanup.released, true); return true;
  });
  assert.equal(fs.existsSync(markerPath(f.runDir, 'group')), false);
  assert.equal(fs.readdirSync(f.runDir).some(name => name.startsWith('group-sync-')), false);
  assert.equal(fs.readFileSync(f.inbox, 'utf8'), 'fact: keep rotated note\n');
  assert.equal(f.database.getContentCheckpointsSince(f.scope, 0).length, 0);
});

test('inherited global coverage and no-content checkpoints allow summary and publication', async t => {
  for (const noContent of [false, true]) {
    const f = await fixture(t, 4);
    f.db.prepare("UPDATE conversations SET status='failed' WHERE id=4").run();
    f.database.createCheckpoint('*', 1, 'single-session baseline');
    if (noContent) f.database.createCheckpoint(f.scope, 2, null, { noContent: true });
    const run = await startRun({ env: f.env }, f.deps);
    const saved = JSON.parse(fs.readFileSync(path.join(run.directory, 'run.json')));
    assert.equal(saved.receipt.after, noContent ? 2 : 1);
    assert.equal(run.end, 3, 'Checkpoint stops at last exported row, before the failed frontier row');
    const settings = await draft(f, run);
    assert.equal((await finishRun(settings, { followedUpIds: [] }, f.deps)).committed, true);
    assert.equal(f.database.getUnsummarizedRange(f.scope).count, 0);
    assert.equal(fs.existsSync(run.inputs.segments[0].path), false);
  }
});
