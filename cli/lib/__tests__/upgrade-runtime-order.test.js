import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upgradeRuntime } from '../../../skills/upgrade-claude/scripts/upgrade.js';

test('T07 runtime upgrade multi/transition installs before one supervisor request, without global exit polling',async()=>{
  for(const [mode,transition] of [['multi',null],['single',{phase:'gating'}]]) {
    const calls=[];const result=await upgradeRuntime({readMode:()=>({mode}),readTransition:()=>transition,
      install:()=>calls.push('install'),requestRestart:()=>{calls.push('restart');return {ok:false,error:{code:'restart_result_unknown'}};},
      enqueue:()=>{throw new Error('must not enqueue');},waitForExit:()=>{throw new Error('must not poll');}});
    assert.deepEqual(calls,['install','restart']);assert.equal(result.error.code,'restart_result_unknown');
  }
});
test('T07 runtime upgrade does not restart after install failure; steady single preserves exit-before-install',async()=>{
  let restarts=0;await assert.rejects(upgradeRuntime({readMode:()=>({mode:'multi'}),readTransition:()=>null,install:()=>{throw new Error('install failed');},requestRestart:()=>restarts++}),/install failed/);assert.equal(restarts,0);
  const calls=[];await upgradeRuntime({readMode:()=>({mode:'single'}),readTransition:()=>null,enqueue:()=>{calls.push('enqueue');return 1;},waitForExit:()=>{calls.push('wait');return true;},install:()=>calls.push('install')});
  assert.deepEqual(calls,['enqueue','wait','install']);
});
