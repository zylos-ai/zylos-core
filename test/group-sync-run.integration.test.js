import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from './helpers/ready-tmux-target.js';
import { renderStateSkeleton } from '../skills/zylos-memory/scripts/state-format.js';
import { createMemoryEditor } from '../skills/zylos-memory/scripts/memory-mcp-server.js';
const rootPath = fileURLToPath(new URL('../', import.meta.url));
function run(script, args, env, input = '') {
  return spawnSync(process.execPath, [path.join(rootPath, 'skills/zylos-memory/scripts', `${script}.js`), ...args], { env, input, encoding: 'utf8', timeout: 15000 });
}

// Integration boundary: new group orchestration CLI, private tmux identity,
// SQLite and the real restricted editor. Run for sync-run command changes;
// skip unrelated changes. The fixture and runner isolate all host paths, and
// each CLI has a timeout; the owned tmux server is reaped by test teardown.
test('group run CLI saves receipts and publishes a missing state with one call per phase', async t => {
  const f = readyTmuxTarget(t, { prefix: 'group-run-cli-', mode: 'multi', packageRoot: rootPath });
  const env = { ...f.env, ZYLOS_RUN_ID: f.ready.runId, ZYLOS_SESSION_GROUP: 'origin', TZ: 'UTC',
    PM2_HOME: path.join(f.root, 'pm2'), TMPDIR: path.join(f.root, 'tmp') };
  fs.mkdirSync(env.PM2_HOME); fs.mkdirSync(env.TMPDIR);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(path.resolve(env[key]).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(fs.existsSync(env[key]));
  }
  assert.ok(f.socketPath.startsWith(f.root + path.sep));
  assert.ok(f.db.name.startsWith(f.root + path.sep));
  console.log(JSON.stringify({ boundary: 'group orchestration CLI', HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR,
    PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, socket: f.socketPath, database: f.db.name }));
  f.db.prepare("INSERT INTO conversations(id,direction,channel,content,status,session_group) VALUES(1,'in','test','Retain the open task','delivered','origin')").run();
  const started = run('sync-run', ['start'], env);
  assert.equal(started.status, 0, started.stderr);
  const manifest = JSON.parse(started.stdout);
  assert.equal(manifest.state, null); assert.equal(manifest.end, 1);
  assert.match(fs.readFileSync(manifest.batch.path, 'utf8'), /Retain the open task/);
  const fetched = spawnSync(process.execPath, [path.join(rootPath, 'skills/comm-bridge/scripts/c4-fetch.js'),
    '--unsummarized', '--group', 'origin', '--up-to', '1', '--limit', String(manifest.batchLimit)],
    { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(fetched.status, 0, fetched.stderr);
  assert.equal(fs.readFileSync(manifest.batch.path, 'utf8'), fetched.stdout);
  const summarized = run('sync-run', ['summarize', '--token', manifest.token], env, 'Task remains open.');
  assert.equal(summarized.status, 0, summarized.stderr);
  assert.equal(JSON.parse(summarized.stdout).reason, 'STATE_MISSING');
  const editor = createMemoryEditor(env);
  const written = await editor({ op: 'create', path: 'state.md.tmp', token: manifest.token,
    replacement: renderStateSkeleton({ scope: 'origin', syncedAt: '1970-01-01T00:00:00Z' }).replace('coverage= ', 'coverage=1 ') });
  assert.equal(written.ok, true, JSON.stringify(written));
  const finished = run('sync-run', ['finish', '--token', manifest.token], env, '{"followedUpIds":[]}');
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(JSON.parse(finished.stdout).committed, true);
  assert.equal(JSON.parse(finished.stdout).released, true);
  assert.equal(fs.existsSync(manifest.directory), false);
  const idle = run('sync-run', ['start'], env);
  assert.equal(idle.status, 0, idle.stderr); assert.equal(JSON.parse(idle.stdout).noInput, true);
});
