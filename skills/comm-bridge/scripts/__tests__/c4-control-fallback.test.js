import {readyTmuxTarget} from '../../../../test/helpers/ready-tmux-target.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cliPath = fileURLToPath(new URL('../c4-control.js', import.meta.url));
const packageRoot = fileURLToPath(new URL('../../../../', import.meta.url));

// IF-16 process fallback integration: real consumer/resolver, tmux and process
// tree, but a named sleeping executable, NOT a real Claude runtime launch.
function fixture(t, mode, recognized) {
  // F1 intentionally differs from the observed named process.
  const {tmux,db,env}=readyTmuxTarget(t,{prefix:'c4-fallback-',mode,runtime:'codex',
    runId:'fixture-run',sessionId:'fixture-session',runtimeProcess:recognized,packageRoot});
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
