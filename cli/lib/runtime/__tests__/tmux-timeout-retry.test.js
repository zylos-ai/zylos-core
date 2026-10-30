import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openTmuxConnection } from '../tmux-connection.js';
import { resolveSessionTarget, revalidateSessionTarget } from '../session-target.js';

test('bound command timeout preserves executor for the original guarded retry', async t => {
  let connection;
  const { binary, socketPath, tmux } = isolatedTmux(t, {
    prefix: 'session-runtime-timeout-retry-', beforeCleanup: () => connection?.close(),
  });
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'fixture',
    '-e', 'ZYLOS_RUN_ID=timeout-run', '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude"}', 'sleep', '30');
  connection = await openTmuxConnection({ binary, socketPath, timeoutMs: 1000 });
  const target = await resolveSessionTarget({ connection, tmuxName: 'fixture', readReady: async () => null });
  await assert.rejects(connection.command(['wait-for', 'never-released'], { timeoutMs: 100 }),
    { code: 'TMUX_UNAVAILABLE', cause: 'timeout' });
  assert.equal(connection.closed, false, 'a command timeout must not close the executor');
  assert.equal(connection.binding.serverGeneration, target.serverGeneration);
  await revalidateSessionTarget({ connection, target });
  assert.equal(await connection.command(['display-message', '-p', '-t', target.paneId, 'retry-on-original-object']),
    'retry-on-original-object');
  tmux('set-environment', '-t', target.tmuxSessionId, 'ZYLOS_RUN_ID', 'replacement-run');
  await assert.rejects(revalidateSessionTarget({ connection, target }), { code: 'RUNID_MISMATCH' });
  tmux('split-window', '-d', '-t', 'fixture', 'sleep', '30');
  tmux('kill-pane', '-t', target.paneId);
  await assert.rejects(connection.command(['display-message', '-p', 'must-not-run']), { code: 'TARGET_GONE' });
});
