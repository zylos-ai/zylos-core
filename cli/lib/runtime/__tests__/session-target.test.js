import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';
import { startCodexWrapper } from '../../../../test/helpers/codex-wrapper-ready.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const { openTmuxConnection, serverGeneration } = await import('../tmux-connection.js');
const { observeSessionTarget, resolveSessionTarget, revalidateSessionTarget } = await import('../session-target.js');
const binary = process.env.TEST_TMUX_BIN || 'tmux';
const ready = async () => ({ runId: 'r1', sessionId: 's1', ts: 1, startupControlIds: [] });
async function fixture(t) {
  let connection;
  const {dir,socketPath,tmux}=isolatedTmux(t,{prefix:'session-runtime-target-',socketName:'tmux.sock',beforeCleanup:()=>connection?.close()});
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-e', 'ZYLOS_RUN_ID=r1', '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', 'sleep', '120');
  connection = await openTmuxConnection({ binary, socketPath, sessionName: 'fixture' });
  return { connection, tmux, socketPath, dir, options: { connection, tmuxName: 'fixture', readReady: ready } };
}
test('fixed pane survives active pane change; run mutation rejected', async t => {
  const {connection, tmux, options} = await fixture(t);
  const target = await resolveSessionTarget(options);
  assert.equal(target.runtime, 'claude'); assert.equal(target.runtimeSessionId, 's1'); assert.match(target.sessionId, /^\$/);
  const second = tmux('split-window','-d','-P','-F','#{pane_id}','-t','fixture','sleep','120');
  tmux('select-pane','-t',second);
  assert.equal(await revalidateSessionTarget({connection,target}), true); assert.notEqual(second, target.paneId);
  tmux('set-environment','-t','fixture','ZYLOS_RUN_ID','r2');
  await assert.rejects(revalidateSessionTarget({connection,target}), {code:'RUNID_MISMATCH'});
});
test('single target accepts READY published by the native child of a Codex launcher pane', async t => {
  let connection;
  const { dir, socketPath, tmux } = isolatedTmux(t, {
    prefix: 'codex-ready-', socketName: 'tmux.sock', tmuxArgs: ['-f', '/dev/null'],
    beforeCleanup: () => connection?.close(),
  });
  const tmuxName = 'codex-wrapper';
  const readyFile = path.join(dir, 'current-session.json');
  const ready = await startCodexWrapper({ tmux, tmuxName, runId: 'single-wrapper-run', readyFile });
  connection = await openTmuxConnection({ binary, socketPath, sessionName: tmuxName });
  const target = await observeSessionTarget({
    sessionGroup: 'single-wrapper', tmuxName, connection,
    readReady: async () => JSON.parse(await fs.readFile(readyFile, 'utf8')),
  });
  assert.equal(target.runtime, 'codex');
  assert.equal(target.ready, true);
  assert.equal(target.runtimeSessionId, ready.sessionId);
});
test('same socket restart invalidates its read identity without replay', async t => {
  const {connection,tmux,socketPath,options} = await fixture(t);
  const target = await resolveSessionTarget(options); tmux('kill-server');
  await new Promise(resolve=>setTimeout(resolve,100));
  tmux('-f','/dev/null','new-session','-d','-s','fixture','sleep','120');
  await assert.rejects(revalidateSessionTarget({connection,target}),{code:'GENERATION_CHANGED'});
  const replacement = await openTmuxConnection({binary,socketPath}); assert.notEqual(await serverGeneration(replacement),target.serverGeneration); replacement.close();
});

test('command timeout leaves executor available for a guarded retry', async t => {
  const {socketPath}=await fixture(t);
  const connection=await openTmuxConnection({binary,socketPath,timeoutMs:40});
  t.after(()=>connection.close());
  await assert.rejects(connection.command(['wait-for','unreleased-test-channel']),{code:'TMUX_UNAVAILABLE',cause:'timeout'});
  assert.equal(connection.closed,false);
  assert.equal(await connection.command(['display-message','-p','retry available']), 'retry available');
});
