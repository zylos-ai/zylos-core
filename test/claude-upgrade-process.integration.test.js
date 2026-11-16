import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

mock.module('../skills/activity-monitor/scripts/core-modules.js', {
  namedExports: { loadCoreModule: async () => ({ SINGLE_UPGRADE_CHECK_ACK_DEADLINE_SECONDS: 60 }) },
});

mock.module('../skills/comm-bridge/scripts/c4-db.js', {
  namedExports: { getModeTransition: () => null },
});
const { upgradeRuntime } = await import('../skills/upgrade-claude/scripts/upgrade.js');

function readback() {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key]?.startsWith('/tmp/zylos-tests-'), `${key} must be isolated`);
  }
  const socket = path.join(process.env.TMPDIR, 'tmux.sock');
  console.log(JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, socket,
    database: path.join(process.env.ZYLOS_DIR, 'comm-bridge/c4.db'),
    shell: fs.realpathSync('/bin/sh'), uid: process.getuid() }));
  // This suite starts no tmux, PM2, database, control delivery or installer.
}

function hasClaude() {
  try {
    execFileSync('pgrep', ['-u', String(process.getuid()), '-f', 'claude.*--dangerously-skip-permissions'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    assert.equal(error.status, 1);
    return false;
  }
}

// Covers the real pgrep/upgrade polling boundary. Run for process-detection changes;
// skip for unrelated edits or when another Claude of this UID prevents isolation.
test('real process exit lets a single-session upgrade reach its installer', { timeout: 15000 }, async t => {
  readback();
  if (hasClaude()) return t.skip('Another Claude of this UID is running; do not touch it');
  const child = fork(new URL('./fixtures/claude-process.js', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  assert.equal(ready.ready, true);
  assert.equal(hasClaude(), true);
  let installed = 0;
  const started = performance.now();
  const result = await upgradeRuntime({ readMode: () => ({ mode: 'single' }), readTransition: () => null,
    enqueue: () => { child.kill('SIGTERM'); return {}; },
    install: () => { installed++; },
    cancel: () => assert.fail('An exited process must not cancel the upgrade'),
  });
  assert.equal(result.data.result, 'installed_after_exit');
  assert.equal(installed, 1);
  assert.ok(performance.now() - started < 6000);
  assert.equal(hasClaude(), false);
});
