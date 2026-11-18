import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isolatedTmux } from './helpers/isolated-tmux.js';
import { SessionAdapter } from '../cli/lib/runtime/session-adapter.js';
import { openTmuxConnection } from '../cli/lib/runtime/tmux-connection.js';
import { observeSessionTargets } from '../cli/lib/runtime/session-batch-observation.js';
import { observeSessionTarget } from '../cli/lib/runtime/session-target.js';
import { parseTmuxEnvironment } from '../cli/lib/runtime/tmux-protocol.js';
import { runBeforeSendHook } from '../skills/comm-bridge/scripts/c4-channel-hooks.js';
import { handleHookActivity } from '../skills/activity-monitor/scripts/hook-activity.js';

const keys = ['ZYLOS_RUN_ID', 'ZYLOS_MODEL_CONFIG', 'ZYLOS_SESSION_GROUP'];
const config = { runtime: 'claude', mode: 'default' };
const caller = { ZYLOS_RUN_ID: 'same-run', ZYLOS_MODEL_CONFIG: JSON.stringify(config), ZYLOS_SESSION_GROUP: 'same' };

function fixture(t) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ZYLOS_')));
  assert.equal(Object.keys(env).some(key => key.startsWith('ZYLOS_')), false);
  const f = isolatedTmux(t, { prefix: 'client-env-', env, tmuxArgs: ['-f', '/dev/null'] });
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    const value = process.env[key];
    assert(value && path.isAbsolute(value));
    assert(!value.startsWith(os.userInfo().homedir + path.sep));
  }
  assert(f.socketPath.startsWith(process.env.TMPDIR + path.sep));
  assert(Buffer.byteLength(f.socketPath) < 100);
  t.diagnostic(JSON.stringify({ binary: f.binary, socketPath: f.socketPath,
    HOME: env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR,
    database: 'none; direct runtime observation does not open a database', startupEnv: 'all ZYLOS_* removed' }));
  const tmux = { socketPath: f.socketPath, binary: f.binary, configFile: '/dev/null' };
  class Adapter extends SessionAdapter { get runtimeId() { return 'claude'; } }
  const adapter = new Adapter({ root: f.dir, env, tmux,
    runtimeExecutable: () => fileURLToPath(new URL('./helpers/tmux-runtime-recorder.js', import.meta.url)),
    paths: { tmuxNameForGroup: group => `zylos-group-${group}` },
  });
  const launch = (group, runId) => adapter.launch({ sessionGroup: group, sessionMode: 'multi', runId, launchConfig: config });
  const global = () => parseTmuxEnvironment(f.tmux('show-environment', '-gs'));
  async function observe() {
    const connection = await openTmuxConnection(tmux);
    let fallbacks = 0;
    const command = connection.command.bind(connection);
    connection.command = (argv, options) => {
      if (argv.includes('show-environment') && argv.includes('-t')) fallbacks++;
      return command(argv, options);
    };
    try {
      const rows = await observeSessionTargets({ connection, readReady: async () => null });
      for (const [group, row] of rows) {
        const single = await openTmuxConnection(tmux);
        try {
          const individual = await observeSessionTarget({ connection: single, tmuxName: `zylos-group-${group}`, readReady: async () => null });
          assert.equal(row.runId, individual.runId);
          assert.equal(row.runtime, individual.runtime);
          for (const key of keys) assert.equal(row.rawF2[key] || '', individual.rawF2[key] || '');
        } finally { single.close(); }
      }
      return { rows, fallbacks };
    } finally { connection.close(); }
  }
  return { ...f, env, launch, global, observe };
}

async function withCaller(action) {
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, caller);
  try { return await action(); }
  finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

// Boundary: real launch -> tmux server/global environment -> batch identity and
// the runtime process environment consumed by hooks/bridge. Run for tmux client
// environment or launch changes; skip for UI-only changes. Private runner paths
// and socket only; lifecycle cleanup kills the server and all recorder processes.
test('managed launch keeps identity session-local and avoids collision rereads', { timeout: 20000 }, async t => {
  const f = fixture(t);
  assert.throws(() => f.tmux('-N', 'list-sessions'));
  await withCaller(async () => {
    t.diagnostic('Only the tested managed launch caller deliberately carries the three identity variables');
    await f.launch('same', 'same-run');
    const global = f.global();
    for (const key of keys) assert.equal(Object.hasOwn(global, key), false, key);
    t.diagnostic('new server global readback: all three identity variables absent');
    await f.launch('own', 'own-run');
    const { rows, fallbacks } = await f.observe();
    assert.equal(fallbacks, 0);
    assert.equal(rows.size, 2);
    for (const [group, runId] of [['same', 'same-run'], ['own', 'own-run']]) {
      const row = rows.get(group);
      assert.equal(row.runId, runId);
      assert.equal(row.runtime, 'claude');
      assert.equal(row.rawF2.ZYLOS_SESSION_GROUP, group);
      const identity = JSON.parse(fs.readFileSync(path.join(f.dir, `identity-${runId}.json`)));
      assert.deepEqual(identity, { ZYLOS_RUN_ID: runId, ZYLOS_MODEL_CONFIG: JSON.stringify(config), ZYLOS_SESSION_GROUP: group });
      const hookEnv = { ...f.env, ...identity, ZYLOS_DIR: f.dir };
      const record = handleHookActivity({ hook_event_name: 'SessionStart', session_id: `native-${group}` }, { env: hookEnv });
      assert.equal(record.runtime, 'claude');
      assert.equal(record.run_id, runId);
      const skillsDir = path.join(f.dir, `skills-${group}`);
      const channelDir = path.join(skillsDir, 'local');
      fs.mkdirSync(channelDir, { recursive: true });
      fs.writeFileSync(path.join(channelDir, 'SKILL.md'), '---\nc4:\n  before_send:\n    hook_id: local\n    entry: hook.js\n    timeout_ms: 1000\n---\n');
      fs.writeFileSync(path.join(channelDir, 'hook.js'), '');
      await runBeforeSendHook({ channel: 'local', endpoint: 'fixture' }, 'local-only', {
        skillsDir, env: hookEnv, run: async ({ input }) => {
          const { context } = JSON.parse(input);
          assert.equal(context.runtime, 'claude');
          assert.equal(context.run_id, runId);
          assert.equal(context.session_group, group);
          return { exitCode: 0, stdout: '{"version":1,"decision":"continue"}' };
        },
      });
    }
    for (const key of keys) assert.equal(process.env[key], caller[key]);
    t.diagnostic('batch fallbacks=0; both session identities and runtime process environments confirmed');
  });
});

// Boundary: external tmux startup can still contaminate globals; unchanged
// collision fallback must distinguish equal, absent and independently set local
// values. Run for client environment or batch identity changes; skip UI-only work.
test('external server identity collisions retain individual-read semantics', { timeout: 20000 }, async t => {
  const f = fixture(t);
  t.diagnostic('Only this direct external tmux startup deliberately carries the three identity variables');
  execFileSync(f.binary, ['-S', f.socketPath, '-f', '/dev/null', 'new-session', '-d', '-s', 'keeper', 'sleep 120'],
    { env: { ...f.env, ...caller }, stdio: 'pipe', timeout: 3000 });
  const global = f.global();
  for (const key of keys) assert.equal(global[key], caller[key]);
  await withCaller(async () => {
    await f.launch('same', 'same-run');
    await f.launch('own', 'own-run');
  });
  // This intentionally contaminated server bypasses the clean fixture starter.
  execFileSync(f.binary, ['-S', f.socketPath, '-N', 'new-session', '-d', '-s', 'zylos-group-absent', 'sleep 120'],
    { env: f.env, stdio: 'pipe', timeout: 3000 });
  for (const key of keys) f.tmux('set-environment', '-u', '-t', 'zylos-group-absent', key);
  const { rows, fallbacks } = await f.observe();
  assert.equal(fallbacks, 1);
  assert.equal(rows.size, 3);
  assert.equal(rows.get('same').runId, 'same-run');
  assert.equal(rows.get('own').runId, 'own-run');
  assert.equal(rows.get('absent').runId, null);
  assert.equal(rows.get('absent').runtime, 'unknown');
  for (const key of keys) assert.equal(rows.get('absent').rawF2[key], '');
  t.diagnostic('batch fallbacks=1; equal/own/absent values match individual reads');
});
