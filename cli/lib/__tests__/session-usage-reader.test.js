import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const {createSessionReader}=await import('../session-state-reader-async.js');
const identity={present:true,ready:true,runtime:'codex',runId:'run',sessionId:'session',createdAt:123,serverGeneration:'gen',tmuxSessionId:'$1',paneId:'%1'};
const row=(timestamp='2026-10-22T01:02:03.456Z',used=10)=>({timestamp,type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:used},model_context_window:100},rate_limits:{primary:{window_minutes:10080,used_percent:71,resets_at:42},secondary:{window_minutes:300,used_percent:23,resets_at:43}}}});
const line=value=>JSON.stringify(value)+'\n';
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
