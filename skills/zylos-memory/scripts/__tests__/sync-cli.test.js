import test from 'node:test';
import { acquire, withMemoryLock } from '../sync-lock.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { renderStateSkeleton } from '../state-format.js';
import { createBatchReceipt } from '../../../comm-bridge/scripts/c4-sync-batch.js';
import { createMemoryEditor } from '../memory-mcp-server.js';
const rootPath = fileURLToPath(new URL('../../../../', import.meta.url));
function run(script, args, env, input = '') {
  return spawnSync(process.execPath, [fileURLToPath(new URL(`../${script}.js`, import.meta.url)), ...args], { env, input, encoding: 'utf8', timeout: 15000 });
}

// Integration boundary: real MCP editor, checkpoint/list/commit CLIs, private
// tmux identity and private C4 database. Run for draft preparation, state
// compaction, fragment editing and commit-output changes;
// skip for unrelated changes. readyTmuxTarget reaps its session and removes the
// fixture; each CLI has a timeout. Read back isolation before any Sync operation.
for (const [kind, existing] of [['group', false], ['group', true], ['global', false]]) {
  test(`fixed temporary state name reaches a successful ${kind} commit with ${existing ? 'existing' : 'missing'} state`, async t => {
    const f = readyTmuxTarget(t, { prefix: 'state-alias-', mode: kind === 'group' ? 'multi' : 'single', packageRoot: rootPath });
    const env = { ...f.env, ZYLOS_RUN_ID: f.ready.runId, TZ: 'Asia/Singapore',
      PM2_HOME: path.join(f.root, 'pm2'), TMPDIR: path.join(f.root, 'tmp') };
    if (kind === 'group') env.ZYLOS_SESSION_GROUP = 'origin';
    for (const key of ['PM2_HOME', 'TMPDIR']) fs.mkdirSync(env[key]);
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
      assert.ok(path.resolve(env[key]).startsWith(path.resolve(os.tmpdir()) + path.sep));
      assert.ok(fs.existsSync(env[key]));
    }
    assert.ok(f.socketPath.startsWith(f.root + path.sep));
    console.log(JSON.stringify({ boundary: `${kind} temporary state commit`, HOME: env.HOME,
      ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR,
      TZ: env.TZ, socket: f.socketPath, database: f.db.name }));
    const token = await acquire({ env, kind }, { currentRunId: async () => env.ZYLOS_RUN_ID });
    const editor = createMemoryEditor(env), scope = kind === 'group' ? 'origin' : '*';
    f.db.prepare("INSERT INTO conversations (id,timestamp,direction,channel,endpoint_id,content,status,session_group) VALUES (1,'2026-10-19 05:30:02','in','test','fixture','Private test message','delivered',?)").run(kind === 'group' ? scope : 'origin');
    const rows = f.db.prepare('SELECT * FROM conversations WHERE id=1').all();
    const batch = createBatchReceipt(rows, { scope, after: 0, end: 1 });
    const completed = existing ? Array.from({ length: 20 }, (_, i) => `- Completed task ${i}: ` + 'historic detail '.repeat(400) + '\n') : [];
    const summary = existing ? completed.map((_, i) => `- Completed task ${i}: delivered successfully.`).join('\n') : 'Private test summary.';
    const checkpoint = run('sync-files', ['checkpoint', '1', '--token', token, '--batch', JSON.stringify(batch)], env, summary);
    assert.equal(checkpoint.status, 0, checkpoint.stderr);
    const listing = run('sync-files', ['list'], env);
    assert.equal(listing.status, 0, listing.stderr);
    const inputs = JSON.parse(listing.stdout), memoryDir = path.dirname(inputs.statePath);
    const text = renderStateSkeleton({ scope, syncedAt: '2026-10-19T05:30:02Z' })
      .replace('coverage= |', 'coverage=1 |')
      .replace('## In Progress\n', '## In Progress\n- Active task: keep working.\n' + (existing ? 'Current task details. '.repeat(700) + '\n' : ''))
      .replace('## Pending\n', '## Pending\n- Blocked on upstream approval.\n');
    if (existing) {
      fs.mkdirSync(memoryDir, { recursive: true });
      const old = text.replace('coverage=1 |', 'coverage=0 |').replace('## In Progress\n', '## In Progress\n' + completed.join(''));
      assert.ok(Buffer.byteLength(old) >= 120 * 1024);
      fs.writeFileSync(inputs.statePath, old);
    }
    const prepared = run('sync-files', ['prepare', '--token', token], env);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(JSON.parse(prepared.stdout).prepared, false);
    if (existing) assert.equal(JSON.parse(prepared.stdout).mode, 'rewrite');
    else assert.equal(JSON.parse(prepared.stdout).reason, 'STATE_MISSING');
    assert.equal((await editor({ op: 'create', path: 'state.md.tmp', replacement: text, token })).ok, true);
    if (existing) {
      const recorded = f.db.prepare('SELECT summary FROM checkpoints ORDER BY id DESC LIMIT 1').get().summary;
      for (let i = 0; i < completed.length; i++) assert.ok(recorded.includes(`- Completed task ${i}: delivered successfully.`));
    }
    const temporary = path.join(memoryDir, `state.md.${token}.tmp`);
    assert.equal(fs.readFileSync(temporary, 'utf8'), text);
    const edit = { op: 'edit', path: 'state.md.tmp', expected: '## Pending\n',
      replacement: '## Pending\n- New pending task.\n', token };
    assert.equal((await editor(edit)).ok, true);
    const result = run('sync-files', ['commit', '--token', token], env, JSON.stringify({ followedUpIds: [], inputs, batch }));
    assert.equal(result.status, 0, result.stderr);
    const published = fs.readFileSync(inputs.statePath, 'utf8');
    assert.equal(JSON.parse(result.stdout).stateBytes, Buffer.byteLength(published));
    assert.equal(JSON.parse(result.stdout).stateOverBudget, false);
    assert.ok(Buffer.byteLength(published) <= 20 * 1024);
    assert.match(published, /Active task: keep working/);
    assert.match(published, /Blocked on upstream approval/);
    assert.match(published, /New pending task/);
    assert.doesNotMatch(published, /Completed task/);
    assert.match(published, /coverage=1/);
    assert.doesNotMatch(published, /synced_at=2026-10-19/);
    assert.equal(fs.existsSync(temporary), false);
    assert.equal(fs.existsSync(path.join(memoryDir, 'state.md.tmp')), false);
  });
}

// Integration boundary: real CLI + private tmux identity + temporary memory.
// Run when sync CLI errors, lock handling or published header fields change;
// skip for unrelated changes.
// readyTmuxTarget owns and cleans its private socket, session and fixture root.
test('CLI exits distinguish malformed input, ownership loss, lock timeout and successful commit', async t => {
  const f = readyTmuxTarget(t, { prefix: 'model-workflow-cli-', mode: 'single', packageRoot: rootPath });
  const env = { ...f.env, ZYLOS_RUN_ID: f.ready.runId, TZ: 'Asia/Singapore',
    PM2_HOME: path.join(f.root, 'pm2'), TMPDIR: path.join(f.root, 'tmp') };
  for (const key of ['PM2_HOME', 'TMPDIR']) fs.mkdirSync(env[key]);
  console.log(JSON.stringify({ boundary: 'Sync commit CLI', HOME: env.HOME,
    ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR,
    TZ: env.TZ, socket: f.socketPath, database: path.join(f.root, 'comm-bridge/c4.db') }));
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
  const before = Date.now();
  const okay = run('sync-files', ['commit', '--token', token], env, payload);
  const after = Date.now();
  assert.equal(okay.status, 0, okay.stderr);
  const published = fs.readFileSync(path.join(memoryDir, 'state.md'), 'utf8');
  const stamp = / \| synced_at=([^| ]+)/.exec(published)?.[1];
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(stamp) >= before && Date.parse(stamp) <= after);
  assert.equal(published, text.replace(/synced_at=[^| ]+/, `synced_at=${stamp}`));
  await withMemoryLock(runDir, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../sync-files.js', import.meta.url)), 'commit', '--token', token], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(payload);
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => {
      try { assert.equal(code, 2, stderr); assert.match(stderr, /LOCK_TIMEOUT/); assert.equal(fs.readFileSync(path.join(memoryDir, 'state.md'), 'utf8'), published); resolve(); }
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
