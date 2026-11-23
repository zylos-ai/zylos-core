import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SessionActivity,TRANSCRIPT_READ_BUDGET_BYTES,OPEN_TURN_INACTIVITY_TIMEOUT_MS} from '../session-activity.js';
function fixture(t,runtime='claude') {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'session-activity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const activity=new SessionActivity({runDir:root,runId:'r',sessionId:'s',runtime,startedAt:100});t.after(()=>activity.close());
 const row=(event,more={})=>({v:1,run_id:'r',session_id:'s',runtime,ts:200,event,...more});return {root,activity,row};
}
test('current main-agent tools only; stop timestamp and late post preserve newer tools',t=>{
 const {activity,row}=fixture(t);activity.consume([row('pre_tool',{tool_use_id:'old',session_id:'old'}),row('pre_tool',{tool_use_id:'sub',agent_id:'a'}),row('pre_tool',{tool_use_id:'a'}),row('pre_tool',{tool_use_id:'b',ts:400}),row('stop',{ts:300}),row('post_tool',{tool_use_id:'a',ts:500})]);
 assert.deepEqual([...activity.tools.keys()],['b']);activity.consume([row('stop',{ts:600})]);assert.equal(activity.read(5000).state,'idle');
});

test('child activity stays separate from every main-agent idle and tool field',t=>{
 for(const runtime of ['claude','codex','agy']){
  const main=fixture(t,runtime),child=fixture(t,runtime);
  const mainRows=[main.row('prompt',{ts:200}),main.row('stop',{ts:300})];
  main.activity.consume(mainRows);child.activity.consume(mainRows);
  child.activity.consume([child.row('subagent_start',{agent_id:'worker',ts:400}),
   child.row('pre_tool',{agent_id:'worker',tool_use_id:'shared-id',tool:'Bash',ts:9900})]);
  const mainFields=value=>({state:value.state,idleSince:value.idleSince,tools:value.tools,lastActivityAt:value.lastActivityAt});
  const idle=child.activity.read(10000);
  assert.deepEqual(mainFields(idle),mainFields(main.activity.read(10000)));
  assert.equal(idle.state,'idle');
  assert.deepEqual(idle.activeSubagents,[{agentId:'worker',lastActivityAt:9900}]);
  const tool=main.row('pre_tool',{tool_use_id:'shared-id',tool:'Read',ts:11000});
  main.activity.consume([tool]);child.activity.consume([tool,
   child.row('post_tool',{agent_id:'worker',tool_use_id:'shared-id',ts:11500}),
   child.row('subagent_stop',{agent_id:'worker',ts:11600})]);
  const busy=child.activity.read(12000);
  assert.deepEqual(mainFields(busy),mainFields(main.activity.read(12000)));
  assert.equal(busy.state,'busy');assert.equal(busy.tools.length,1);
  assert.deepEqual(busy.activeSubagents,[]);
 }
});

test('restart: recover latest turn across rotation and associate older session_start before timestamp',async t=>{
 const {appendEvent,rotateEventLog}=await import('../../../../cli/lib/event-log.js');
 const {root,activity,row}=fixture(t);const log=path.join(root,'events.jsonl'),transcript=path.join(root,'s.jsonl');
 fs.writeFileSync(transcript,JSON.stringify({message:{content:[{type:'tool_result',tool_use_id:'done'}]}})+'\n');
 appendEvent(log,row('session_start',{ts:50,transcript_path:transcript}));
 appendEvent(log,row('pre_tool',{ts:110,tool_use_id:'obsolete'}));
 appendEvent(log,row('stop',{ts:115}));
 rotateEventLog(log,{maxBytes:0,now:1000});
 appendEvent(log,row('prompt',{ts:120}));
 appendEvent(log,row('pre_tool',{ts:130,tool_use_id:'done',tool:'Read'}));
 rotateEventLog(log,{maxBytes:0,now:1001});
 appendEvent(log,row('pre_tool',{ts:140,tool_use_id:'live',tool:'Bash'}));
 const result=activity.read(10000);
 assert.equal(activity.transcriptPath,transcript);assert.deepEqual(result.tools.map(tool=>tool.id),['live']);
 assert.equal(result.busySince,120);
 assert.deepEqual(result.events.map(event=>event.event),['pre_tool','stop','prompt','pre_tool','pre_tool']);
 appendEvent(log,row('post_tool',{ts:150,tool_use_id:'live'}));assert.equal(activity.read(10000).tools.length,0);
});

test('busy start follows the main turn across tools and completions until observed idle',t=>{
 const {activity,row}=fixture(t);
 assert.equal(activity.read(5000).busySince,null);
 activity.consume([row('prompt',{ts:6000}),row('pre_tool',{ts:6500,tool_use_id:'a'}),
  row('post_tool',{ts:7000,tool_use_id:'a'}),row('pre_tool',{ts:7500,tool_use_id:'b'})]);
 assert.equal(activity.read(8000).busySince,6000);
 activity.consume([row('stop',{ts:8500})]);assert.equal(activity.read(9000).busySince,6000);
 assert.equal(activity.read(12000).busySince,null);
 activity.consume([row('pre_tool',{ts:13000,tool_use_id:'c'}),row('pre_tool',{ts:12900,agent_id:'child'})]);
 assert.equal(activity.read(14000).busySince,13000);
});

test('only AI work advances response time; Escape and continue artifacts do not',t=>{
 const {root,activity,row}=fixture(t),transcript=path.join(root,'s.jsonl');
 fs.writeFileSync(transcript,'');
 activity.consume([row('session_start',{ts:100,transcript_path:transcript}),row('prompt',{ts:200}),
  row('pre_tool',{ts:250,tool_use_id:'main'}),row('pre_tool',{ts:300,agent_id:'child'}),
  row('pre_tool',{ts:9000,agent_id:'child',session_id:'foreign'})]);
 assert.equal(activity.read(5000).lastResponseAt,300);
 activity.consume([row('stop',{ts:400}),row('idle',{ts:410}),row('prompt',{ts:420}),
  row('post_tool',{ts:430,tool_use_id:'main'}),row('subagent_stop',{ts:440,agent_id:'child'})]);
 const record=(type,ts,more={})=>({type,sessionId:'s',timestamp:new Date(ts).toISOString(),isSidechain:false,...more});
 const rows=[record('user',450,{message:{role:'user',content:[{type:'text',text:'[Request interrupted by user]'}]}}),
  record('user',460,{message:{role:'user',content:[{type:'text',text:'continue'}]}}),
  record('assistant',470,{message:{role:'assistant',model:'<synthetic>',content:[{type:'text',text:'interrupted'}]}}),
  record('assistant',480,{isApiErrorMessage:true,message:{role:'assistant',model:'claude',content:[{type:'text',text:'error'}]}})];
 fs.appendFileSync(transcript,rows.map(value=>JSON.stringify(value)).join('\n')+'\n');
 assert.equal(activity.read(6000).lastResponseAt,300);
 fs.appendFileSync(transcript,JSON.stringify(record('assistant',500,{message:{role:'assistant',model:'claude',content:[{type:'text',text:'Resuming the task.'}]}}))+'\n');
 assert.equal(activity.read(7000).lastResponseAt,500);
 assert.equal(activity.read(8000).lastResponseAt,500);
});

test('large transcripts obey a per-read byte budget before exposing a late AI response',t=>{
 const {root,activity,row}=fixture(t),transcript=path.join(root,'s.jsonl');
 const line=JSON.stringify({type:'progress'})+'\n';
 fs.writeFileSync(transcript,line.repeat(Math.ceil(TRANSCRIPT_READ_BUDGET_BYTES*3/line.length))+
  JSON.stringify({type:'assistant',timestamp:new Date(400).toISOString(),sessionId:'s',message:{role:'assistant',model:'claude',content:[{type:'text',text:'Working.'}]}})+'\n');
 activity.consume([row('session_start',{ts:100,transcript_path:transcript})]);
 let value=activity.read(5000);
 assert.equal(value.transcriptPending,true);assert.equal(value.lastResponseAt,null);
 assert.ok(activity.transcriptOffset<=TRANSCRIPT_READ_BUDGET_BYTES);
 for(let reads=0;reads<8 && value.transcriptPending;reads++) {
  const before=activity.transcriptOffset;
  value=activity.read(6000+reads);
  assert.ok(activity.transcriptOffset-before<=TRANSCRIPT_READ_BUDGET_BYTES);
 }
 assert.equal(value.transcriptPending,false);assert.equal(value.lastResponseAt,400);
 assert.equal(activity.results.size,0);
});

test('AGY change-driven idle and busy status remain current after seventy seconds', t => {
 for(const state of ['idle','working']) {
  const {root,activity,row}=fixture(t,'agy');
  activity.consume([row('prompt')]);
  fs.writeFileSync(path.join(root,'statusline.json'),JSON.stringify({session_id:'s',agent_state:state,
   zylos:{v:1,runId:'r',capturedAt:1000}}));
  for(const now of [72000,145000]) {
   assert.equal(activity.read(now).state,state==='idle'?'idle':'busy',`${state} at ${now}`);
  }
 }
});

// Boundary: inactivity eligibility derives from real hook/transcript files, with an
// injected observation clock. Run for turn/timeout/transcript changes; skip UI.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; no processes started.
for(const runtime of ['claude','codex'])test(`${runtime} quiet turn waits twenty minutes and closes only after interrupt admission`,t=>{
 const {activity,row}=fixture(t,runtime);
 activity.consume([row('prompt',{ts:6000})]);
 const deadline=6000+OPEN_TURN_INACTIVITY_TIMEOUT_MS;
 assert.equal(activity.read(deadline-1).state,'busy');
 assert.equal(activity.read(deadline).state,'busy');assert.equal(activity.read(deadline).quietTurnDue,true);
 assert.equal(activity.claimQuietTurn(6000,deadline),true);
 assert.equal(activity.claimQuietTurn(6000,deadline),false);
 activity.consume([row('quiet_turn_interrupt',{ts:deadline,turn_started_at:6000,last_activity_at:6000,
  last_native_activity_at:6000,last_response_at:null,control_id:7})]);
 const expired=activity.read(deadline);
 assert.equal(expired.state,'idle');assert.equal(expired.turnOpen,false);
 assert.equal(expired.busySince,null);assert.equal(expired.idleSince,deadline);
 assert.deepEqual(expired.tools,[]);assert.equal(expired.lastActivityAt,6000);
 assert.equal(expired.lastResponseAt,null);
 assert.equal(activity.read(deadline+10000).state,'idle');
 activity.consume([row('pre_tool',{ts:8000,tool_use_id:'stale'})]);
 assert.equal(activity.read(deadline+10001).state,'idle','late stale tool hook cannot resurrect expired work');
 activity.consume([row('prompt',{ts:deadline+11000})]);
 const next=activity.read(deadline+20000);
 assert.equal(next.state,'busy');assert.equal(next.turnOpen,true);assert.equal(next.busySince,deadline+11000);
});

