import {readyTmuxTarget} from '../../../../test/helpers/ready-tmux-target.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = fileURLToPath(new URL('../../../../', import.meta.url));

for (const json of [false, true]) for (const mode of ['single', 'multi']) test(`production control CLI and builder use real isolated tmux (${mode}, json=${json})`, t => {
  const {env,tmux,db,readyPath,ready}=readyTmuxTarget(t,{prefix:'c4-binding-live-',mode,packageRoot});
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_SESSION_GROUP', 'origin');
  const args = ['enqueue', '--content', 'fixture control', '--no-ack-suffix', '--target-run', 'run-1', '--expected-runtime', 'claude', '--expected-session', 'session-1', '--group', 'origin'];
  const cli = (extra = [], expected) => {
    const out = spawnSync(process.execPath, [fileURLToPath(new URL('../c4-control.js', import.meta.url)), ...args, ...(json ? ['--json'] : []), ...extra], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(out.status, expected ? 1 : 0, `${out.stdout}\n${out.stderr}\n${out.error ?? ''}`);
    if (json) {
      assert.equal(out.stderr, '');
      assert.equal(out.stdout.trim().split('\n').length, 1);
      const response = JSON.parse(out.stdout);
      assert.equal(response.ok, !expected);
      if (expected) {
        assert.equal(response.error.code, expected);
        assert.deepEqual(response.error.persisted, []);
      }
    } else if (expected) assert.match(out.stderr, new RegExp(`\\[${expected}\\]`));
    return out;
  };
  const success = cli();
  const row = db.prepare('SELECT * FROM control_queue').get();
  assert.equal(row.session_group, 'origin');
  const binding = JSON.parse(row.target_binding);
  if (json) assert.deepEqual(JSON.parse(success.stdout), { ok: true, data: { id: row.id, supersededCount: 0, targetBinding: binding } });
  assert.equal(binding.expectedRunId, 'run-1'); assert.equal(binding.expectedSessionId, 'session-1');
  assert.equal(binding.tmuxTarget.serverGeneration, tmux('display-message', '-p', '#{pid}:#{start_time}'));
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_MODEL_CONFIG', '{');
  cli([], 'TARGET_SNAPSHOT_UNKNOWN');
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_MODEL_CONFIG', '{"runtime":"codex","mode":"default"}');
  cli([], 'TARGET_RUNTIME_MISMATCH');
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_MODEL_CONFIG', '{"runtime":"claude","mode":"default"}');
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_RUN_ID', 'run-2');
  const mismatch = cli([], 'TARGET_MISMATCH');
  if (json) assert.equal(JSON.parse(mismatch.stdout).error.runId, 'run-2');
  else assert.match(mismatch.stderr, /run-2/);
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_RUN_ID', 'run-1');
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_SESSION_GROUP', 'other');
  cli([], 'TARGET_SCOPE_MISMATCH');
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_SESSION_GROUP', 'origin');
  fs.writeFileSync(readyPath, JSON.stringify({ ...ready, runId: 'old-run' })); cli([], 'TARGET_NOT_READY');
  fs.writeFileSync(readyPath, JSON.stringify({ ...ready, sessionId: 'new-session' })); cli([], 'STALE_TARGET');
  tmux('kill-server'); cli([], 'TARGET_NOT_RUNNING');
  assert.deepEqual(db.prepare('SELECT * FROM control_queue').all(), [row]);
});
