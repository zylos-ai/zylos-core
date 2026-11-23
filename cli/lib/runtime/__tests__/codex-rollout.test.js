import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexSampleForIdentity } from '../codex/rollout.js';

const identity={present:true,ready:true,runtime:'codex',runId:'run',sessionId:'session',createdAt:123,serverGeneration:'gen',tmuxSessionId:'$1',paneId:'%1'};
const row=(timestamp='2026-10-22T01:02:03.456Z',used=10)=>({timestamp,type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:used},model_context_window:100},rate_limits:{primary:{window_minutes:10080,used_percent:71,resets_at:42},secondary:{window_minutes:300,used_percent:23,resets_at:43}}}});
const line=value=>JSON.stringify(value)+'\n';
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'session-runtime-usage-'));const dir=path.join(root,'activity-monitor/session-groups/lark:x');fs.mkdirSync(dir,{recursive:true});const rollout=path.join(root,'rollout.jsonl');const events=path.join(dir,'events.jsonl');const event={v:1,ts:100,event:'session_start',runtime:'codex',session_group:'lark:x',run_id:'run',session_id:'session',transcript_path:rollout};fs.writeFileSync(events,line(event));fs.writeFileSync(rollout,line(row()));return {root,dir,rollout,events,event,env:{ZYLOS_DIR:root},clean:()=>fs.rmSync(root,{recursive:true,force:true})};}

test('Codex uses exact F6 scope/run/session and last complete token_count with its own timestamp',()=>{
 const f=fixture();const read=()=>readCodexSampleForIdentity({sessionGroup:'lark:x',identity,env:f.env});
 try{
  const sampled=read();assert.deepEqual(sampled.sample.contextUsage,{used:10,ceiling:100});assert.equal(sampled.sample.capturedAt,Date.parse('2026-10-22T01:02:03.456Z'));
  assert.deepEqual(sampled.sample.rateLimits,{sevenDay:{usedPercentage:71,resetsAt:42},fiveHour:{usedPercentage:23,resetsAt:43}});
  fs.appendFileSync(f.rollout,JSON.stringify(row('2026-10-22T01:02:04.789Z',20)));assert.equal(read().sample.contextUsage.used,10);
  fs.appendFileSync(f.rollout,'\n');assert.equal(read().sample.contextUsage.used,20);
  fs.appendFileSync(f.events,line({...f.event,run_id:'other',transcript_path:'/not-used'})+line({...f.event,session_id:'other',transcript_path:'/not-used'})+line({...f.event,session_group:'lark:y',transcript_path:'/not-used'}));assert.equal(read().sample.contextUsage.used,20);
  for(const field of ['run_id','session_id','session_group','runtime']){fs.writeFileSync(f.events,line({...f.event,[field]:'wrong'}));assert.equal(read(),null,field);}
  fs.writeFileSync(f.events,JSON.stringify(f.event));assert.equal(read(),null,'incomplete event must not count');
  fs.writeFileSync(f.events,line({...f.event,transcript_path:'relative.jsonl'}));assert.equal(read(),null);
 }finally{f.clean();}
});
