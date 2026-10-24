import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import * as schema from '../c4-schema.js';
import { guardDatabase } from '../sqlite-schema.js';

const cliPath = fileURLToPath(new URL('../c4-control.js', import.meta.url));
const packageRoot = fileURLToPath(new URL('../../../../', import.meta.url));

// IF-16 process fallback integration: real consumer/resolver, tmux and process
// tree, but a named sleeping executable, NOT a real Claude runtime launch.
function fixture(t, mode, recognized) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-fallback-'));
  const env = { PATH: process.env.PATH, HOME: root, ZYLOS_DIR: root,
    ZYLOS_PACKAGE_ROOT: packageRoot, TMUX_TMPDIR: root, LANG: 'en_US.UTF-8' };
  const tmux = (...args) => execFileSync('tmux', args, {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
  }).trim();
  let db;
  t.after(() => {
    try { tmux('kill-server'); } catch {}
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.zylos'));
  // Deliberately different from the named fixture: fallback must use observed
  // process identity rather than the configured default runtime.
  fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'codex', session_mode: mode }));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  db = new Database(path.join(root, 'comm-bridge/c4.db'));
  guardDatabase(db, schema);
  db.pragma('journal_mode=WAL');
  const readyPath = path.join(root, 'activity-monitor/session-groups/origin/current-session.json');
  fs.mkdirSync(path.dirname(readyPath), { recursive: true });
  fs.writeFileSync(readyPath, JSON.stringify({ runId: 'fixture-run', sessionId: 'fixture-session', ts: 1, startupControlIds: [] }));
  let executable = '/bin/sleep';
  if (recognized) {
    executable = path.join(root, 'claude');
    fs.writeFileSync(path.join(root, 'fixture.c'), '#include <unistd.h>\nint main(void) { sleep(120); return 0; }\n');
    execFileSync('cc', [path.join(root, 'fixture.c'), '-o', executable], { env, timeout: 20000 });
  }
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'zylos-group-origin',
    '-e', 'ZYLOS_RUN_ID=fixture-run', '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"codex","mode":"default"}',
    ...(mode === 'multi' ? ['-e', 'ZYLOS_SESSION_GROUP=origin'] : []), executable, '120');
  tmux('set-environment', '-u', '-t', '=zylos-group-origin', 'ZYLOS_MODEL_CONFIG');
  assert.doesNotMatch(tmux('show-environment', '-t', '=zylos-group-origin'), /^ZYLOS_MODEL_CONFIG=/m);
  const rows = () => db.prepare('SELECT * FROM control_queue ORDER BY id').all();
  const run = expectedRuntime => {
    const result = spawnSync(process.execPath, [cliPath, 'enqueue', '--content', 'IF-16 fixture', '--no-ack-suffix',
      '--target-run', 'fixture-run', '--expected-session', 'fixture-session', '--expected-runtime', expectedRuntime,
      '--json', ...(mode === 'multi' ? ['--group', 'origin'] : [])], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.error, undefined);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim().split('\n').length, 1);
    return { status: result.status, response: JSON.parse(result.stdout) };
  };
  return { tmux, rows, run };
}

for (const mode of ['single', 'multi']) {
  test(`IF-16 no F2 named process: matching runtime binds, mismatch preserves rows (${mode})`, t => {
    const { tmux, rows, run } = fixture(t, mode, true);
    assert.deepEqual(rows(), []);
    const success = run('claude');
    assert.equal(success.status, 0, JSON.stringify(success.response));
    const binding = {
      expectedRunId: 'fixture-run',
      tmuxTarget: {
        serverGeneration: tmux('display-message', '-p', '#{pid}:#{start_time}'),
        sessionId: tmux('display-message', '-p', '-t', '=zylos-group-origin:', '#{session_id}'),
        paneId: tmux('display-message', '-p', '-t', '=zylos-group-origin:', '#{pane_id}'),
      },
      expectedSessionId: 'fixture-session',
    };
    const before = rows();
    assert.equal(before.length, 1);
    assert.equal(before[0].session_group, mode === 'multi' ? 'origin' : null);
    assert.equal(before[0].status, 'pending');
    assert.equal(before[0].target_binding, JSON.stringify(binding));
    assert.deepEqual(success.response, { ok: true, data: { id: before[0].id, supersededCount: 0, targetBinding: binding } });
    const mismatch = run('codex');
    assert.equal(mismatch.status, 1);
    assert.equal(mismatch.response.ok, false);
    assert.equal(mismatch.response.error.code, 'TARGET_RUNTIME_MISMATCH');
    assert.deepEqual(mismatch.response.error.persisted, []);
    assert.deepEqual(rows(), before);
    assert.equal(tmux('list-clients', '-F', '#{client_pid}'), '');
  });

  test(`IF-16 no F2 unrecognized process refuses without insert (${mode})`, t => {
    const { tmux, rows, run } = fixture(t, mode, false);
    const before = rows();
    const unknown = run('claude');
    assert.equal(unknown.status, 1);
    assert.equal(unknown.response.ok, false);
    assert.equal(unknown.response.error.code, 'TARGET_SNAPSHOT_UNKNOWN');
    assert.deepEqual(unknown.response.error.persisted, []);
    assert.deepEqual(rows(), before);
    assert.equal(tmux('list-clients', '-F', '#{client_pid}'), '');
  });
}
