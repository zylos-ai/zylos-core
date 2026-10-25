import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,LEGACY_TMUX_NAMES} from './stop-tmux-fixture.js';

for(const name of LEGACY_TMUX_NAMES){
 test(`real historical ${name}: absent/null succeeds without process lookup`,async t=>{
  const f=await fixture(t);await f.adapter.stop({tmuxName:name,expectedRunId:null});assert.equal(f.snapshot('origin'),f.origin);
 });
 test(`real historical ${name}: present/null closes the original object`,async t=>{
  const f=await fixture(t);f.command('new-session','-d','-s',name,'sleep 60');
  f.command('set-environment','-r','-t',`=${name}`,'ZYLOS_RUN_ID');
  const original=f.snapshot(name);
  await f.adapter.stop({tmuxName:name,expectedRunId:null});
  assert.equal(f.command('list-sessions','-F','#{session_name}'),'origin');assert.equal(f.snapshot('origin'),f.origin);
  t.diagnostic(JSON.stringify({name,original,historicalNull:true,targetAbsent:true,originUnchanged:true}));
 });
 test(`real historical ${name}: mismatched keyed/null values leave target and origin unchanged`,async t=>{
  const f=await fixture(t);f.command('new-session','-d','-s',name,'sleep 60');
  for(const [actual,expected] of [[null,'wrong'],['actual',null],['actual','wrong']]){
   if(actual)f.command('set-environment','-t',`=${name}`,'ZYLOS_RUN_ID',actual);
   else f.command('set-environment','-r','-t',`=${name}`,'ZYLOS_RUN_ID');
   const before=f.snapshot(name);
   await assert.rejects(f.adapter.stop({tmuxName:name,expectedRunId:expected}),{code:'RUNID_MISMATCH'});
   assert.equal(f.snapshot(name),before);assert.equal(f.snapshot('origin'),f.origin);
  }
 });
}
