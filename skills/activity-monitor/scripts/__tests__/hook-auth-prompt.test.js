import assert from 'node:assert/strict';
import { describe, it, afterEach, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-prompt-test-'));
const logDir = path.join(tmpDir, 'activity-monitor');
const logFile = path.join(logDir, 'hook-timing.log');
const hookScript = path.resolve(import.meta.dirname, '..', 'hook-auth-prompt.js');
const packageRoot = path.resolve(import.meta.dirname, '../../../..');
fs.mkdirSync(logDir, { recursive: true });

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(logFile, { force: true });
});

function runHook(input, env = { ...process.env, ZYLOS_DIR: tmpDir }) {
  const result = spawnSync(process.execPath, [hookScript], { env, input, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

const sampleInput = {
  tool_name: 'Bash',
  tool_input: { command: 'ls -la' }
};

// ── tests ───────────────────────────────────────────────────────────

describe('hook-auth-prompt', () => {
  describe('logging', () => {
    it('logs PermissionRequest event to hook-timing.log', () => {
      runHook(JSON.stringify(sampleInput));
      const log = fs.readFileSync(logFile, 'utf8');
      assert.match(log, /hook=auth-prompt/);
      assert.match(log, /event=PermissionRequest/);
      assert.match(log, /tool=Bash/);
      assert.match(log, /input_keys=\[command\]/);
    });

    it('handles malformed JSON input gracefully', () => {
      runHook('not-json');
      assert.equal(fs.existsSync(logFile), false);
    });

    it('logs (unknown) when tool_name is missing', () => {
      runHook(JSON.stringify({ tool_input: { file_path: '/tmp/test' } }));
      const log = fs.readFileSync(logFile, 'utf8');
      assert.match(log, /tool=\(unknown\)/);
    });
  });

});

// PermissionRequest → real Core registry → real C4 control CLI and fixture
// database. Run for authorization and runtime binding changes. No native
// runtime or dispatcher: only a private tmux target whose READY is synthesized.
it('enqueues for the observed registered runtime and falls back to the default', { timeout: 25000 }, t => {
  const f = readyTmuxTarget(t, { prefix: 'auth-target-', mode: 'multi', packageRoot });
  const controls = path.join(f.root, '.claude/skills/comm-bridge/scripts');
  fs.mkdirSync(controls, { recursive: true });
  fs.symlinkSync(path.join(packageRoot, 'skills/comm-bridge/scripts/c4-control.js'), path.join(controls, 'c4-control.js'));
  const input = JSON.stringify({ ...sampleInput, hook_event_name: 'PermissionRequest', session_id: 'session-1' });
  const env = { ...f.env, ZYLOS_RUN_ID: 'run-1', ZYLOS_SESSION_GROUP: 'origin' };
  const rows = f.db.prepare('SELECT raw_content, target_binding FROM control_queue ORDER BY id DESC LIMIT 1');
  const size = f.db.prepare('SELECT count(*) AS count FROM control_queue');
  let enqueued = 0;
  for (const [model, expected, policy] of [
    ['{"runtime":"codex"}', 'codex', { auto_approve_permission: true }],
    ['{bad', 'claude', {}],
    ['{"runtime":"unregistered"}', 'claude', {}],
  ]) {
    const configPath = path.join(f.root, '.zylos/config.json');
    fs.writeFileSync(configPath, JSON.stringify({ session_mode: 'multi', ...policy }));
    f.tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_MODEL_CONFIG', JSON.stringify({ runtime: expected, mode: 'default' }));
    runHook(input, { ...env, ZYLOS_MODEL_CONFIG: model });
    assert.equal(size.get().count, ++enqueued);
    const row = rows.get();
    assert.equal(row.raw_content, '[KEYSTROKE]Enter');
    const binding = JSON.parse(row.target_binding);
    assert.equal(binding.expectedRunId, env.ZYLOS_RUN_ID);
    assert.equal(binding.expectedSessionId, 'session-1');
  }
});
