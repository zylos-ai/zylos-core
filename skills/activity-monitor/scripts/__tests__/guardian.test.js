import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeRuntimeProcess } from '../guardian.js';

test('T01 observation uses the explicit target and never starts or resets an absent runtime',async()=>{
  const calls=[];const adapter={sessionName:'wrong-global',isRunning:async args=>{calls.push(args);return {tmux:false,process:false};},
    launch:()=>{throw new Error('M4 must not launch');},stop:()=>{throw new Error('observation must not stop');},clearStaleState:()=>{throw new Error('must not clear state');}};
  for(let i=0;i<35;i++)assert.equal((await observeRuntimeProcess(adapter,{tmuxName:'zylos-group-origin'})).state,'offline');
  assert.equal(calls.length,35);assert.ok(calls.every(call=>call.tmuxName==='zylos-group-origin'));
});
test('T01 observation distinguishes stopped/running and propagates unavailable instead of absence',async()=>{
  for(const process of [true,false])assert.equal((await observeRuntimeProcess({isRunning:async()=>({tmux:true,process})},{tmuxName:'group'})).state,process?'running':'stopped');
  const unavailable=Object.assign(new Error('timeout'),{code:'TMUX_UNAVAILABLE',cause:'timeout'});
  await assert.rejects(observeRuntimeProcess({isRunning:async()=>{throw unavailable;}},{tmuxName:'group'}),error=>error===unavailable);
  await assert.rejects(observeRuntimeProcess({isRunning:async()=>true},{tmuxName:'group'}),{code:'TMUX_UNAVAILABLE'});
});
