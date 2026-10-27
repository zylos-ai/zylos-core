import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { installCoreCodexHook, codexHooksPath } from '../codex-hooks.js';
import { SessionActivity } from '../../../skills/activity-monitor/scripts/session-activity.js';
import { groupRunDir } from '../session-group-paths.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

// Captured from the official 0.164.0 TUI using a loopback Responses fixture;
// only cwd/transcript paths were sanitized. Tool payloads below follow
// openai/codex rust-v0.164.0 codex-rs/hooks/src/schema.rs.
it('ZYLO-85: installed Codex hooks connect native payloads to group activity; removal fails the contract', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-activity-chain-'));
  try {
    const zylosDir = path.join(fixture, 'zylos');
    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    const scriptsDir = path.join(zylosDir, '.claude', 'skills', 'activity-monitor', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(path.join(root, 'skills/activity-monitor/scripts/hook-activity.js'), path.join(scriptsDir, 'hook-activity.js'));
    fs.copyFileSync(path.join(root, 'skills/activity-monitor/scripts/core-modules.js'), path.join(scriptsDir, 'core-modules.js'));
    fs.copyFileSync(path.join(root, 'skills/activity-monitor/scripts/is-main-module.js'), path.join(scriptsDir, 'is-main-module.js'));
    const bridgeDir = path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts');
    fs.mkdirSync(bridgeDir, { recursive: true });
    fs.copyFileSync(path.join(root, 'skills/comm-bridge/scripts/core-config-loader.js'), path.join(bridgeDir, 'core-config-loader.js'));
    fs.writeFileSync(path.join(zylosDir, 'package.json'), '{"type":"module"}\n');
    installCoreCodexHook({ zylosDir });
    const config = JSON.parse(fs.readFileSync(codexHooksPath(zylosDir), 'utf8'));
    const env = { ...process.env, HOME: fixture, ZYLOS_DIR: zylosDir,
      ZYLOS_SESSION_GROUP: 'a2test:r8x', ZYLOS_RUN_ID: '45395c5d-test',
      ZYLOS_MODEL_CONFIG: JSON.stringify({ runtime: 'codex' }), ZYLOS_PACKAGE_ROOT: root };
    delete env.HOOK_ACTIVITY_DISABLE_MAIN;
    const runDir = groupRunDir(env.ZYLOS_SESSION_GROUP, env);
    const transcript = path.join(fixture, 'rollout.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const native = JSON.parse(fs.readFileSync(new URL('./fixtures/codex-native-0.164.0.json', import.meta.url), 'utf8'))
      .map(payload => ({ ...payload, transcript_path: transcript, cwd: fixture }));
    const sessionId = native[0].session_id;
    const base = { session_id: sessionId, transcript_path: transcript, cwd: fixture,
      permission_mode: 'bypassPermissions' };
    const payloads = [
      native[0],
      native[1],
      { ...base, hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { cmd: 'true' }, tool_use_id: 'call-1' },
      { ...base, hook_event_name: 'PermissionRequest', tool_name: 'exec_command', tool_input: { cmd: 'true' } },
      { ...base, hook_event_name: 'PostToolUse', tool_name: 'exec_command', tool_input: { cmd: 'true' }, tool_use_id: 'call-1', tool_response: 'ok' },
      native[2],
    ];
    function deliver(hooks, payload) {
      for (const group of hooks.hooks[payload.hook_event_name] || []) {
        for (const hook of group.hooks || []) {
          if (!hook.command.endsWith('/hook-activity.js')) continue;
          const result = spawnSync(hook.command, { shell: true, input: JSON.stringify(payload), env, encoding: 'utf8' });
          assert.equal(result.status, 0, result.stderr);
        }
      }
    }
    const startedAt = Date.now() - 1;
    const activity = new SessionActivity({ runDir, runId: env.ZYLOS_RUN_ID, sessionId, runtime: 'codex', startedAt });
    try {
      deliver(config, payloads[0]);
      const initial = activity.read();
      assert.equal(activity.transcriptPath, transcript);
      for (const payload of payloads.slice(1)) deliver(config, payload);
      const state = activity.read();
      assert.ok(state.lastActivityAt > initial.lastActivityAt);
      assert.equal(state.tools.length, 0);
      assert.equal(activity.turn, false);
      const eventsPath = path.join(runDir, 'events.jsonl');
      const rows = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(rows.map(row => row.event), ['session_start', 'prompt', 'pre_tool', 'permission_request', 'post_tool', 'stop']);
      assert.ok(rows.every(row => row.runtime === 'codex' && row.run_id === env.ZYLOS_RUN_ID && row.session_id === sessionId));
      const last = state.lastActivityAt;
      deliver(config, { ...payloads[1], session_id: 'foreign-session' });
      deliver(config, { ...payloads[1], agent_id: 'subagent-1', agent_type: 'worker' });
      assert.equal(activity.read().lastActivityAt, last);
      const withoutActivity = structuredClone(config);
      for (const groups of Object.values(withoutActivity.hooks)) {
        for (const group of groups) group.hooks = group.hooks.filter(h => !h.command.endsWith('/hook-activity.js'));
      }
      const size = fs.statSync(eventsPath).size;
      env.ZYLOS_RUN_ID = 'missing-run';
      for (const payload of payloads) deliver(withoutActivity, payload);
      assert.equal(fs.statSync(eventsPath).size, size);
      const missing = new SessionActivity({ runDir, runId: 'missing-run', sessionId, runtime: 'codex', startedAt });
      try {
        assert.throws(() => {
          missing.read();
          assert.equal(missing.transcriptPath, transcript);
        }, assert.AssertionError);
      } finally { missing.close(); }
    } finally { activity.close(); }
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
