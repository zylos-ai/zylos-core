import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseFinalizeTimeout,readFinalizeState,resumeFinalizeBudget} from '../upgrade-budget.js';

test('finalize timeout validates integer seconds before work',()=>{
  assert.equal(parseFinalizeTimeout(),600000);
  assert.equal(parseFinalizeTimeout('900'),900000);
  for(const value of [59,3601,'abc','60.1',null,'',Infinity]) assert.throws(()=>parseFinalizeTimeout(value),{code:'INVALID_ARGS'});
});
test('parent budget uses original state mtime and legacy timeout, never entry time',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-budget-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.json'),anchor=Math.floor(Date.now()/1000)*1000-20000;
  const write=value=>{fs.writeFileSync(file,JSON.stringify(value));fs.utimesSync(file,anchor/1000,anchor/1000);};
  write({schemaVersion:1});
  assert.equal(readFinalizeState(file).budget.deadlineAt,anchor+179000);
  write({finalizeTimeoutMs:900000});
  assert.equal(readFinalizeState(file).budget.deadlineAt,anchor+899000);
  for(const value of [null,'600000',0,59999,3600001,60000.5]) {write({finalizeTimeoutMs:value});assert.throws(()=>readFinalizeState(file),{code:'FINALIZE_BUDGET_INVALID'});}
  write({});assert.throws(()=>readFinalizeState(file,{now:anchor-1000}),{code:'FINALIZE_BUDGET_INVALID'});
});
test('expired parent budget stops new operations',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-expired-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.json');fs.writeFileSync(file,'{}');
  const old=Date.now()-200000;fs.utimesSync(file,old/1000,old/1000);
  assert.throws(()=>readFinalizeState(file).budget.check(),{code:'deadline_exceeded'});
});
test('resume budget subtracts elapsed entry time from remaining time',()=>{
  const entry=Date.now()-30000;
  const b=resumeFinalizeBudget(undefined,entry);
  assert.equal(b.deadlineAt,entry+599000);
  assert.ok(b.remaining()<=569000,'entry delay must consume the default budget');
  assert.ok(b.remaining()>564000,'conversion must retain the unspent budget');
  assert.doesNotThrow(()=>b.check());
});
test('already expired resume entry prevents new operations',()=>{
  const entry=Date.now()-61000;
  const b=resumeFinalizeBudget(60,entry);
  assert.equal(b.deadlineAt,entry+59000);
  assert.equal(b.remaining(),0);
  assert.throws(()=>b.check(),{code:'deadline_exceeded'});
});
