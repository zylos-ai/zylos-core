import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let checks = 0;
let sleeps = 0;
let runningChecks = 0;
mock.module('child_process', {
  namedExports: {
    execFileSync(file, args, options) {
      assert.equal(file, 'pgrep');
      assert.deepEqual(args, ['-u', String(process.getuid()), '-f', 'claude.*--dangerously-skip-permissions']);
      assert.deepEqual(options, { stdio: 'ignore' });
      checks++;
      if (checks > runningChecks) throw Object.assign(new Error('No matching process'), { status: 1 });
      return Buffer.from('123\n');
    },
    execSync(command) {
      // Only the existing polling delay may use a shell. No installer or control command runs.
      assert.equal(command, 'sleep 2');
      sleeps++;
    },
  },
});
mock.module('../../../activity-monitor/scripts/core-modules.js', {
  namedExports: { loadCoreModule: async () => ({ SINGLE_UPGRADE_CHECK_ACK_DEADLINE_SECONDS: 60 }) },
});
mock.module('../../../comm-bridge/scripts/c4-db.js', {
  namedExports: { getModeTransition: () => null },
});
const { upgradeRuntime } = await import('../upgrade.js');

function singleUpgrade() {
  let installed = 0;
  let cancelled = 0;
  const controls = { checkControlId: 1, exitControlId: 2 };
  return {
    run: () => upgradeRuntime({
      readMode: () => ({ mode: 'single' }), readTransition: () => null,
      enqueue: () => controls,
      install: () => { installed++; },
      cancel: value => { assert.equal(value, controls); cancelled++; },
    }),
    installed: () => installed,
    cancelled: () => cancelled,
  };
}

test('an exited Claude proceeds to installation without a polling delay', async () => {
  checks = sleeps = runningChecks = 0;
  const upgrade = singleUpgrade();
  assert.equal((await upgrade.run()).data.result, 'installed_after_exit');
  assert.equal(checks, 1);
  assert.equal(sleeps, 0);
  assert.equal(upgrade.installed(), 1);
  assert.equal(upgrade.cancelled(), 0);
});

test('a running Claude is polled until it exits before installation', async () => {
  checks = sleeps = 0;
  runningChecks = 1;
  const upgrade = singleUpgrade();
  await upgrade.run();
  assert.equal(checks, 2);
  assert.equal(sleeps, 1);
  assert.equal(upgrade.installed(), 1);
  assert.equal(upgrade.cancelled(), 0);
});

test('a Claude that stays running reaches the unchanged deadline without installation', async () => {
  checks = sleeps = 0;
  runningChecks = Infinity;
  const upgrade = singleUpgrade();
  await assert.rejects(upgrade.run(), { code: 'EXIT_UNCONFIRMED' });
  assert.equal(checks, 90);
  assert.equal(sleeps, 90);
  assert.equal(upgrade.installed(), 0);
  assert.equal(upgrade.cancelled(), 1);
});
