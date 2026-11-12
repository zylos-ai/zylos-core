import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { upgradeRuntime, cancelExit } from '../../../skills/upgrade-claude/scripts/upgrade.js';
import { enqueueSingleUpgradeExit } from '../request-runtime-restart.js';

test('runtime upgrade multi/transition installs before one supervisor request, without global exit polling',async()=>{
  for(const [mode,transition] of [['multi',null],['single',{phase:'gating'}]]) {
    const calls=[];const result=await upgradeRuntime({readMode:()=>({mode}),readTransition:()=>transition,
      install:()=>calls.push('install'),requestRestart:()=>{calls.push('restart');return {ok:false,error:{code:'restart_result_unknown'}};},
      enqueue:()=>{throw new Error('must not enqueue');},waitForExit:()=>{throw new Error('must not poll');}});
    assert.deepEqual(calls,['install','restart']);assert.equal(result.error.code,'restart_result_unknown');
  }
});
test('runtime upgrade does not restart after install failure; steady single preserves exit-before-install',async()=>{
  let restarts=0;await assert.rejects(upgradeRuntime({readMode:()=>({mode:'multi'}),readTransition:()=>null,install:()=>{throw new Error('install failed');},requestRestart:()=>restarts++}),/install failed/);assert.equal(restarts,0);
  const calls=[];await upgradeRuntime({readMode:()=>({mode:'single'}),readTransition:()=>null,enqueue:()=>{calls.push('enqueue');return 1;},waitForExit:()=>{calls.push('wait');return true;},install:()=>calls.push('install')});
  assert.deepEqual(calls,['enqueue','wait','install']);
});
test('steady single upgrade cancels both its queued check and /exit when the runtime does not exit',async()=>{
  const controls={checkControlId:7,exitControlId:8};let cancelled,installs=0;
  await assert.rejects(upgradeRuntime({readMode:()=>({mode:'single'}),readTransition:()=>null,enqueue:async()=>controls,
    waitForExit:()=>false,cancel:received=>{cancelled=received;},install:()=>installs++}),{code:'EXIT_UNCONFIRMED'});
  assert.deepEqual(cancelled,controls);assert.equal(installs,0);
});

// Boundary: the real queueing helper and the real cancellation, each running the installed c4-control script
// against the C4 database in the runner's isolated ZYLOS_DIR (the repository's skills are linked in as installed).
// No session, tmux or service is involved.
test('steady single upgrade giving up acknowledges both its queued check and /exit, and nothing else', async t => {
  const zylosDir = fs.realpathSync(process.env.ZYLOS_DIR ?? '/nonexistent');
  const realHome = fs.realpathSync(os.userInfo().homedir);
  assert.ok(!zylosDir.startsWith(realHome + path.sep), 'ZYLOS_DIR must be isolated from the real home');
  const skills = path.join(zylosDir, '.claude/skills'), repository = fileURLToPath(new URL('../../../', import.meta.url));
  fs.mkdirSync(skills, { recursive: true });
  const linked = [];
  t.after(() => { for (const link of linked) fs.unlinkSync(link); });
  for (const skill of ['comm-bridge', 'activity-monitor', 'scheduler']) {
    const link = path.join(skills, skill);
    assert.equal(fs.existsSync(link), false, `${link} must not exist yet`);
    fs.symlinkSync(path.join(repository, 'skills', skill), link); linked.push(link);
  }
  const control = args => execFileSync(process.execPath, [path.join(skills, 'comm-bridge/scripts/c4-control.js'), ...args],
    { encoding: 'utf8', timeout: 30000 }).trim();
  const controls = await enqueueSingleUpgradeExit();
  const other = JSON.parse(control(['enqueue', '--content', 'unrelated control', '--json'])).data.id;
  const status = id => control(['get', '--id', String(id)]);
  assert.deepEqual([controls.checkControlId, controls.exitControlId, other].map(status), ['status=pending', 'status=pending', 'status=pending']);
  cancelExit(controls);
  assert.deepEqual([controls.checkControlId, controls.exitControlId, other].map(status), ['status=done', 'status=done', 'status=pending']);
});
