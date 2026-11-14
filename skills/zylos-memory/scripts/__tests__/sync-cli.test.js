import test from 'node:test';
import { acquire, withMemoryLock } from '../sync-lock.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { nonnegativeInteger } from '../sync-cli.js';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { renderStateSkeleton } from '../state-format.js';
import { createBatchReceipt } from '../../../comm-bridge/scripts/c4-sync-batch.js';
const rootPath = fileURLToPath(new URL('../../../../', import.meta.url));
function run(script, args, env, input = '') {
  return spawnSync(process.execPath, [fileURLToPath(new URL(`../${script}.js`, import.meta.url)), ...args], { env, input, encoding: 'utf8', timeout: 15000 });
}

// Real CLI boundary: listing ignores supplied token values, while every write
// command still requires one before reading stdin or touching a lock/database.
// Run for sync-files argument changes; skip otherwise. No tmux server is needed;
// all runtime paths are private and the fixture is removed with the test.
test('list ignores optional tokens while write commands still require a token', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-cli-list-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(dir, 'home'), ZYLOS_DIR: path.join(dir, 'zylos'),
    PM2_HOME: path.join(dir, 'pm2'), TMPDIR: path.join(dir, 'tmp'),
    TMUX_TMPDIR: process.env.TMUX_TMPDIR, ZYLOS_PACKAGE_ROOT: rootPath,
    ZYLOS_RUN_ID: 'list-only', ZYLOS_SESSION_GROUP: 'origin' };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) fs.mkdirSync(env[key], { recursive: true });
  const memoryDir = path.join(env.ZYLOS_DIR, 'memory/session-groups/origin');
  fs.mkdirSync(memoryDir, { recursive: true });
  const segments = ['20261113T010203000Z', '20261113T010204000Z'];
  for (const segment of segments) fs.writeFileSync(path.join(memoryDir, `inbox.${segment}.md`), segment);
  fs.writeFileSync(path.join(memoryDir, 'inbox.md'), 'active inbox');
  const baseline = run('sync-files', ['list'], env);
  assert.equal(baseline.error, undefined);
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(baseline.stderr, '');
  const listed = JSON.parse(baseline.stdout);
  assert.equal(listed.scope, 'origin');
  assert.equal(listed.statePath, path.join(memoryDir, 'state.md'));
  assert.deepEqual(listed.segments.map(entry => entry.id), segments);
  assert.deepEqual(listed.sessions, []);
  for (const entry of listed.segments) {
    assert.equal(entry.path, path.join(memoryDir, `inbox.${entry.id}.md`));
    assert.equal(entry.bytes, Buffer.byteLength(entry.id));
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  }
  for (const token of ['not-a-token', 'b'.repeat(32), '', '-h']) {
    const result = run('sync-files', ['list', '--token', token], env);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, baseline.stdout);
  }
  for (const args of [['cleanup'], ['rotate'], ['checkpoint', '1', '--no-content'], ['commit']]) {
    const result = run('sync-files', args, env, 'not valid JSON');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, 'Error [INVALID_INPUT]: token is required: pass the T printed by sync-lock.js acquire\n');
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(fs.readdirSync(env.ZYLOS_DIR), ['memory']);
  assert.deepEqual(fs.readdirSync(memoryDir).sort(), ['inbox.md', ...segments.map(id => `inbox.${id}.md`)].sort());
  for (const segment of segments) assert.equal(fs.readFileSync(path.join(memoryDir, `inbox.${segment}.md`), 'utf8'), segment);
  assert.equal(fs.readFileSync(path.join(memoryDir, 'inbox.md'), 'utf8'), 'active inbox');
});
// Integration boundary: real CLI + private tmux identity + temporary memory.
// Run when sync CLI errors/lock handling change; skip for unrelated changes.
// readyTmuxTarget owns and cleans its private socket, session and fixture root.
test('CLI exits distinguish malformed input, ownership loss, lock timeout and successful commit', async t => {
  const f = readyTmuxTarget(t, { prefix: 'model-workflow-cli-', mode: 'single', packageRoot: rootPath });
  const env = { ...f.env, ZYLOS_RUN_ID: f.ready.runId };
  const runDir = path.join(f.root, 'activity-monitor/session-groups/origin');
  const memoryDir = path.join(f.root, 'memory'); fs.mkdirSync(memoryDir);
  const token = await acquire({ env, kind: 'global' }, { currentRunId: async () => env.ZYLOS_RUN_ID });
  const batch = createBatchReceipt([], { scope: '*', after: 0, end: 0 });
  const checkpoint = run('sync-files', ['checkpoint', '0', '--token', token, '--batch', JSON.stringify(batch)], env, 'No new conversations.');
  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  const listing = run('sync-files', ['list'], env);
  assert.equal(listing.status, 0, listing.stderr);
  const payload = JSON.stringify({ followedUpIds: [], inputs: JSON.parse(listing.stdout), batch });
  const text = renderStateSkeleton({ scope: '*', syncedAt: '2026-10-19T05:30:02Z' }).replace('coverage= |', 'coverage=0 |');
  fs.writeFileSync(path.join(memoryDir, `state.md.${token}.tmp`), text);
  for (const args of [['commit'], ['commit', '--token', token.toUpperCase()]]) {
    const missing = run('sync-files', args, env, '{"followedUpIds":[]}');
    assert.equal(missing.status, 1, missing.stderr);
    assert.equal(missing.stderr, 'Error [INVALID_INPUT]: token is required: pass the T printed by sync-lock.js acquire\n');
    assert.equal(fs.existsSync(path.join(memoryDir, 'state.md')), false);
  }
  const invalid = run('sync-files', ['commit', '--token', token], env, '{}');
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /^Error \[INVALID_INPUT\]:/);
  const stale = run('sync-files', ['commit', '--token', 'b'.repeat(32)], env, payload);
  assert.equal(stale.status, 3); assert.match(stale.stderr, /^Error \[TOKEN_MISMATCH\]:/);
  const okay = run('sync-files', ['commit', '--token', token], env, payload);
  assert.equal(okay.status, 0, okay.stderr); assert.equal(fs.readFileSync(path.join(memoryDir, 'state.md'), 'utf8'), text);
  await withMemoryLock(runDir, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../sync-files.js', import.meta.url)), 'commit', '--token', token], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(payload);
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => {
      try { assert.equal(code, 2, stderr); assert.match(stderr, /LOCK_TIMEOUT/); assert.equal(fs.readFileSync(path.join(memoryDir, 'state.md'), 'utf8'), text); resolve(); }
      catch (error) { reject(error); }
    });
  }));
  const args = ['list', '--group', 'telegram:example'];
  const since = run('sync-files', [...args, '--since', '2026-10-19'], { ...env, ZYLOS_SESSION_GROUP: 'origin' });
  assert.equal(since.status, 1); assert.match(since.stderr, /^Error \[INVALID_INPUT\]: Invalid option --since/);
  const denied = run('sync-files', args, env);
  assert.equal(denied.status, 1); assert.match(denied.stderr, /^Error \[SCOPE_UNBOUND\]:/);
  const logs = run('sync-files', args, { ...env, ZYLOS_SESSION_GROUP: 'origin' });
  assert.equal(logs.status, 0, logs.stderr);
  assert.deepEqual(JSON.parse(logs.stdout), { scope: 'telegram:example', sessions: [] });
  const forbidden = run('sync-files', ['commit', '--group', 'origin', '--token', token], env, '{}');
  assert.equal(forbidden.status, 1); assert.match(forbidden.stderr, /^Error \[INVALID_INPUT\]:/);
});

test('nonnegative integer parsing accepts decimal IDs and rejects coercible non-IDs', () => {
  for (const value of ['0', '1', '42', String(Number.MAX_SAFE_INTEGER)]) {
    assert.equal(nonnegativeInteger(value, 'id'), Number(value));
  }
  for (const value of ['', ' ', '-1', '1.5', 'abc', '1e3', '0x10', '+1', ' 1', '1 ', '9007199254740992']) {
    assert.throws(() => nonnegativeInteger(value, 'id'), { code: 'INVALID_INPUT', exitCode: 1 });
  }
});

// Integration boundary: real CLI argument parsing rejects bad IDs before any
// lock/database access, while valid IDs proceed to the normal guard path.
// Run for sync numeric-argument changes; skip for unrelated changes. Each case
// uses private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and t.after removes the fixture.
// No tmux server or database is needed because no valid Sync marker exists.
test('numeric CLI arguments reject invalid IDs before touching memory or databases', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-cli-input-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(dir, 'home'), ZYLOS_DIR: path.join(dir, 'zylos'),
    PM2_HOME: path.join(dir, 'pm2'), TMPDIR: path.join(dir, 'tmp'),
    ZYLOS_RUN_ID: 'input-test', ZYLOS_SESSION_GROUP: 'origin' };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) fs.mkdirSync(env[key], { recursive: true });
  const token = 'b'.repeat(32);
  for (const value of ['', ' ', '-1', '1.5', 'abc', '1e3', '0x10', '+1', ' 1', '1 ', '9007199254740992']) {
    const calls = [
      ['sync-files', ['checkpoint', value, '--token', token, '--batch', '{}']],
    ];
    for (const [script, args] of calls) {
      const result = run(script, args, env);
      assert.equal(result.status, 1, `${script} ${JSON.stringify(value)}: ${result.stderr}`);
      assert.match(result.stderr, /^Error \[INVALID_INPUT\]:/);
    }
  }
  // Cursor numbers are derived by the script; the former arguments are rejected.
  for (const args of [['--synced', '1', '--checkpoint', '1'], ['--synced', '1'], ['--checkpoint', '1']]) {
    const result = run('origin-cursor', ['advance', '--group', 'telegram:test', ...args, '--token', token], env, '{}');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /^Error \[INVALID_INPUT\]: Invalid option --(synced|checkpoint)/);
  }
  assert.deepEqual(fs.readdirSync(env.ZYLOS_DIR), []);
  for (const [script, args] of [
    ['sync-files', ['checkpoint', '0', '--token', token, '--batch', JSON.stringify(createBatchReceipt([], { scope: 'origin', after: 0, end: 0 }))]],
    ['sync-files', ['checkpoint', '1', '--token', token, '--batch', JSON.stringify(createBatchReceipt([], { scope: 'origin', after: 0, end: 1 }))]],
    ['origin-cursor', ['advance', '--group', 'telegram:test', '--token', token]],
  ]) {
    const result = run(script, args, env);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /^Error \[TOKEN_MISMATCH\]:/);
  }
});

// Integration boundary: real CLI argument parsing reports a missing or malformed
// --token as INVALID_INPUT (exit 1) before any memory, lock or database access;
// a well-formed token that owns nothing stays TOKEN_MISMATCH (exit 3, above).
// Run for Sync token parsing/guard changes; skip for unrelated changes. Each
// case uses private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and t.after removes the
// fixture. No tmux server or database is needed: no Sync marker exists.
test('Sync scripts report a missing or malformed --token as input before touching memory', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-cli-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(dir, 'home'), ZYLOS_DIR: path.join(dir, 'zylos'),
    PM2_HOME: path.join(dir, 'pm2'), TMPDIR: path.join(dir, 'tmp'),
    ZYLOS_RUN_ID: 'token-test', ZYLOS_SESSION_GROUP: 'origin' };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) fs.mkdirSync(env[key], { recursive: true });
  const commands = [['sync-files', ['cleanup']], ['sync-files', ['rotate']], ['sync-files', ['checkpoint', '1']],
    ['sync-files', ['commit']], ['origin-cursor', ['advance', '--group', 'telegram:test']]];
  for (const [script, args] of commands) {
    for (const token of [null, '', 'B'.repeat(32), 'b'.repeat(31), 'g'.repeat(32)]) {
      const result = run(script, token === null ? args : [...args, '--token', token], env, '{"followedUpIds":[]}');
      assert.equal(result.status, 1, `${script} ${args[0]} ${JSON.stringify(token)}: ${result.stderr}`);
      assert.equal(result.stderr, 'Error [INVALID_INPUT]: token is required: pass the T printed by sync-lock.js acquire\n');
    }
  }
  assert.deepEqual(fs.readdirSync(env.ZYLOS_DIR), []);
});

// Integration boundary: real CLI chain c4-fetch --origin-sync --out ->
// sync-files list --group -> origin-cursor advance (receipts on stdin) against a
// temporary SQLite database. Run when Origin reads, receipts, list or cursor CLI
// change; skip otherwise. readyTmuxTarget owns the private tmux socket,
// database and root; HOME/ZYLOS_DIR/PM2_HOME/TMPDIR remain isolated.
test('Origin cursor CLI advances only to what exported receipts prove was read', async t => {
  const f = readyTmuxTarget(t, { prefix: 'origin-cursor-cli-', mode: 'multi', packageRoot: rootPath });
  const env = { ...process.env, ...f.env, ZYLOS_RUN_ID: f.ready.runId, ZYLOS_SESSION_GROUP: 'origin',
    PM2_HOME: path.join(f.root, 'pm2'), TMPDIR: path.join(f.root, 'tmp') };
  for (const key of ['PM2_HOME', 'TMPDIR']) fs.mkdirSync(env[key]);
  console.log(JSON.stringify({ boundary: 'Origin receipt CLI chain', HOME: env.HOME,
    ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR,
    socket: f.socketPath, database: path.join(f.root, 'comm-bridge/c4.db') }));
  const group = 'telegram:raw-only';
  const insert = f.db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('in','system',?,'delivered',?)");
  const ids = ['first', 'second', 'third'].map(text => Number(insert.run(text, group).lastInsertRowid));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM checkpoints WHERE session_group=?').get(group).n, 0);
  const token = await acquire({ env, kind: 'origin' }, { currentRunId: async () => env.ZYLOS_RUN_ID });
  const exports = fs.mkdtempSync(path.join(env.TMPDIR, 'origin-'));
  const fetch = args => {
    const result = spawnSync(process.execPath, [path.join(rootPath, 'skills/comm-bridge/scripts/c4-fetch.js'), '--origin-sync', '--group', group, ...args, '--json'], { env, encoding: 'utf8', timeout: 15000, cwd: exports });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).data;
  };
  const summary = fetch(['--summaries-only', '--out', 'summaries.json']);
  assert.equal(summary.path, path.join(exports, 'summaries.json'));
  assert.deepEqual(summary.receipt.count, 0);
  const raw = fetch(['--raw-only', '--after', String(summary.receipt.coverageEnd), '--limit', '2', '--out', 'raw.json']);
  assert.deepEqual([raw.count, raw.firstId, raw.lastId, raw.receipt.end], [2, ids[0], ids[1], ids[1]]);
  const listed = run('sync-files', ['list', '--group', group], env);
  assert.equal(listed.status, 0, listed.stderr);
  const cursor = () => f.db.prepare('SELECT synced_id,checkpoint_id FROM origin_sync_cursors WHERE session_group=?').get(group) ?? null;
  const input = JSON.stringify({ summary: summary.receipt, raw: raw.receipt, inputs: JSON.parse(listed.stdout) });
  const forged = run('origin-cursor', ['advance', '--group', group, '--token', token], env, JSON.stringify({ summary: summary.receipt, raw: { ...raw.receipt, end: ids[2] }, inputs: JSON.parse(listed.stdout) }));
  assert.equal(forged.status, 1, forged.stderr); assert.match(forged.stderr, /^Error \[INPUT_CHANGED\]:/);
  assert.equal(cursor(), null);
  const result = run('origin-cursor', ['advance', '--group', group, '--token', token], env, input);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { advanced: true, syncedId: ids[1], checkpointId: 0 });
  assert.deepEqual(cursor(), { synced_id: ids[1], checkpoint_id: 0 });
  const replay = run('origin-cursor', ['advance', '--group', group, '--token', token], env, input);
  assert.equal(replay.status, 1, replay.stderr); assert.match(replay.stderr, /^Error \[INPUT_CHANGED\]:/);
  assert.deepEqual(cursor(), { synced_id: ids[1], checkpoint_id: 0 });
  fs.rmSync(exports, { recursive: true, force: true });
});
