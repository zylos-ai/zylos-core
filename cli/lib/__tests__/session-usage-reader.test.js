import { getRuntime } from '../runtime/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const {usageModelFacts,sampleResult}=await import('../session-usage-reader.js');
const {createSessionReader}=await import('../session-state-reader-async.js');
const identity={present:true,ready:true,runtime:'codex',runId:'run',sessionId:'session',createdAt:123,serverGeneration:'gen',tmuxSessionId:'$1',paneId:'%1'};
const row=(timestamp='2026-10-22T01:02:03.456Z',used=10)=>({timestamp,type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:used},model_context_window:100},rate_limits:{primary:{window_minutes:10080,used_percent:71,resets_at:42},secondary:{window_minutes:300,used_percent:23,resets_at:43}}}});
const line=value=>JSON.stringify(value)+'\n';
test('stale sample retains only identity-validated last value without changing freshness semantics', () => {
 const value={state:'idle',health:'ok'}, sample={value,sampledAt:1000,identity:{runId:'run',sessionId:'session'}};
 assert.deepEqual(sampleResult(sample,identity,identity,5000,6000),{value,sampledAt:1000,valid:true,reason:null,lastValue:null});
 assert.deepEqual(sampleResult(sample,identity,identity,5000,6001),{value:null,sampledAt:1000,valid:false,reason:'stale',lastValue:value});
 for(const [first,last,input,reason] of [
  [identity,{...identity,sessionId:'replacement'},sample,'identity_changed'],
  [identity,identity,{...sample,identity:{runId:'other',sessionId:'session'}},'identity_mismatch'],
  [identity,identity,{...sample,identity:{}},'identity_missing'],
  [{...identity,ready:false},identity,sample,'starting'],
  [{...identity,present:false},identity,sample,'not_running'],
  [identity,identity,{...sample,error:'unparseable'},'unparseable'],
 ]) {
  const result=sampleResult(input,first,last,5000,9000);
  assert.equal(result.reason,reason); assert.equal(result.value,null); assert.equal(result.valid,false);
  assert.equal(result.lastValue,null);
 }
});
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'session-runtime-usage-'));const dir=path.join(root,'activity-monitor/session-groups/lark:x');fs.mkdirSync(dir,{recursive:true});const rollout=path.join(root,'rollout.jsonl');const events=path.join(dir,'events.jsonl');const event={v:1,ts:100,event:'session_start',runtime:'codex',session_group:'lark:x',run_id:'run',session_id:'session',transcript_path:rollout};fs.writeFileSync(events,line(event));fs.writeFileSync(rollout,line(row()));return {root,dir,rollout,events,event,env:{ZYLOS_DIR:root},clean:()=>fs.rmSync(root,{recursive:true,force:true})};}
test('account sample selects eligible rollout by mtime; identity replacement invalidates sample',async()=>{
 const f=fixture();try{
  const otherDir=path.join(f.root,'activity-monitor/session-groups/lark:y');fs.mkdirSync(otherDir,{recursive:true});const otherRollout=path.join(f.root,'other.jsonl');
  fs.writeFileSync(path.join(otherDir,'events.jsonl'),line({...f.event,session_group:'lark:y',transcript_path:otherRollout}));const other=row();other.payload.rate_limits.secondary.used_percent=99;fs.writeFileSync(otherRollout,line(other));
  fs.utimesSync(f.rollout,100,100);fs.utimesSync(otherRollout,200,200);
  const reader=createSessionReader({env:f.env,open:async()=>({close:async()=>{}}),observeAll:async()=>new Map([['lark:x',identity],['lark:y',identity]])});
  assert.equal((await reader.readAccountUsage('codex')).fiveHour.usedPercentage,99);
  fs.utimesSync(f.rollout,300,300);assert.equal((await reader.readAccountUsage('codex')).fiveHour.usedPercentage,23);
 }finally{f.clean();}
});

test('usage model facts prefer actual model and preserve the observed context class', async () => {
 const override={runtime:'claude',mode:'override',model:'sonnet'};
 assert.deepEqual(usageModelFacts({model:{id:'claude-opus-4-6'},context_window:{context_window_size:1000000}},'claude',override,(await getRuntime('claude')).context),{model:'claude-opus-4-6',contextWindow:1000000});
 assert.deepEqual(usageModelFacts(null,'claude',override,(await getRuntime('claude')).context),{model:'sonnet',contextWindow:null});
 assert.deepEqual(usageModelFacts(null,'codex',override,(await getRuntime('codex')).context),{model:null,contextWindow:null});
 assert.deepEqual(usageModelFacts(null,'claude',{mode:'default'},(await getRuntime('claude')).context),{model:null,contextWindow:null});
});


test('last sample value is retained only after identity validation and expiry', () => {
 const value = { state: 'busy', idle_seconds: 7 };
 const sample = { value, sampledAt: 1000, identity: { runId: 'run', sessionId: 'session' } };
 const read = (record = sample, first = identity, last = identity, now = 7000) => sampleResult(record, first, last, 5000, now);
 assert.deepEqual(read(), { value: null, lastValue: value, valid: false, reason: 'stale', sampledAt: 1000 });
 assert.deepEqual(read(sample, identity, identity, 6000), { value, lastValue: null, valid: true, reason: null, sampledAt: 1000 });
 for (const [record, first, last, reason] of [
  [sample, { ...identity, present: false }, identity, 'not_running'],
  [sample, { ...identity, ready: false }, identity, 'starting'],
  [sample, identity, { ...identity, runId: 'new' }, 'identity_changed'],
  [{ ...sample, error: 'unparseable' }, identity, identity, 'unparseable'],
  [{ sampledAt: null }, identity, identity, 'missing'],
  [{ ...sample, identity: {} }, identity, identity, 'identity_missing'],
  [{ ...sample, identity: { ...sample.identity, sessionId: 'previous' } }, identity, identity, 'identity_mismatch'],
 ]) {
  const result = read(record, first, last);
  assert.equal(result.lastValue, null, reason); assert.equal(result.value, null, reason);
  assert.equal(result.reason, reason); assert.equal(result.valid, false); assert.equal(result.sampledAt, record.sampledAt);
 }
});
