import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SessionActivity,TRANSCRIPT_READ_BUDGET_BYTES,TRANSCRIPT_LINE_LIMIT_BYTES,RECENT_TOOL_RESULTS_LIMIT,OPEN_TURN_INACTIVITY_TIMEOUT_MS} from '../session-activity.js';
import {handleHookActivity} from '../hook-activity.js';
import {publishContextSample} from '../context-monitor.js';
function fixture(t,runtime='claude') {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'session-activity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const activity=new SessionActivity({runDir:root,runId:'r',sessionId:'s',runtime,startedAt:100});t.after(()=>activity.close());
 const row=(event,more={})=>({v:1,run_id:'r',session_id:'s',runtime,ts:200,event,...more});return {root,activity,row};
}
test('current main-agent tools only; stop timestamp and late post preserve newer tools',t=>{
 const {activity,row}=fixture(t);activity.consume([row('pre_tool',{tool_use_id:'old',session_id:'old'}),row('pre_tool',{tool_use_id:'sub',agent_id:'a'}),row('pre_tool',{tool_use_id:'a'}),row('pre_tool',{tool_use_id:'b',ts:400}),row('stop',{ts:300}),row('post_tool',{tool_use_id:'a',ts:500})]);
 assert.deepEqual([...activity.tools.keys()],['b']);activity.consume([row('stop',{ts:600})]);assert.equal(activity.read(5000).state,'idle');
});
test('Claude transcript results arriving before a hook stay remembered',t=>{
 const {root,activity,row}=fixture(t);const transcript=path.join(root,'s.jsonl');
 fs.writeFileSync(transcript,['a','late'].map(id=>JSON.stringify({message:{content:[{type:'tool_result',tool_use_id:id}]}})).join('\n')+'\n');
 activity.consume([row('session_start',{transcript_path:transcript}),row('pre_tool',{tool_use_id:'a'})]);activity.read();
 assert.equal(activity.tools.size,0);activity.consume([row('pre_tool',{tool_use_id:'late'})]);assert.equal(activity.tools.size,0);
});
test('Codex does not pair rollout ids, stop closes unpaired tools',t=>{
 const {root,activity,row}=fixture(t,'codex');const transcript=path.join(root,'s.jsonl');fs.writeFileSync(transcript,JSON.stringify({content:[{type:'tool_result',tool_use_id:'a'}]})+'\n');
 activity.consume([row('session_start',{transcript_path:transcript}),row('pre_tool',{tool_use_id:'a'})]);activity.read();assert.equal(activity.tools.size,1);activity.consume([row('stop')]);assert.equal(activity.tools.size,0);
});
test('native status retained, single run writes origin with identity',t=>{
 const {root}=fixture(t);const env={ZYLOS_DIR:root,ZYLOS_RUN_ID:'r'};const original={session_id:'s',cost:{total_cost_usd:7},future:{x:true}};
 const sample=publishContextSample(original,{env,now:123});assert.deepEqual(sample,{...original,zylos:{v:1,runId:'r',sessionGroup:'origin',capturedAt:123}});
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'activity-monitor/session-groups/origin/statusline.json'))),sample);
 assert.equal(fs.existsSync(path.join(root,'activity-monitor/cost-log.jsonl')),false);
});
test('hook retains subagent facts and selected tool inputs without prompt/output',t=>{
 const {root}=fixture(t);const env={ZYLOS_DIR:root,ZYLOS_RUN_ID:'r',ZYLOS_MODEL_CONFIG:'{"runtime":"codex"}'};
 const record=handleHookActivity({hook_event_name:'PreToolUse',session_id:'s',agent_id:'sub',tool_name:'Bash',tool_use_id:'t',tool_input:{command:'ls',secret:'omit'},prompt:'omit',tool_response:'omit'},{env,nowMs:123});
 assert.equal(record.runtime,'codex');assert.equal(record.agent_id,'sub');assert.deepEqual(record.tool_input,{command:'ls'});assert.equal(record.session_group,'origin');assert.equal('prompt' in record,false);
});

test('child activity stays separate from every main-agent idle and tool field',t=>{
 for(const runtime of ['claude','codex']){
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

test('child lifecycles track independent latest activity and stop without resurrection',t=>{
 const {activity,row}=fixture(t);
 activity.consume([row('subagent_start',{agent_id:'first',ts:200}),
  row('subagent_start',{agent_id:'second',ts:250}),
  row('pre_tool',{agent_id:'first',ts:400}),
  row('post_tool',{agent_id:'second',ts:350})]);
 let result=activity.read(5000);
 assert.deepEqual(result.activeSubagents,[{agentId:'first',lastActivityAt:400},{agentId:'second',lastActivityAt:350}]);
 assert.equal(result.lastSubagentActivityAt,400);
 activity.consume([row('subagent_stop',{agent_id:'first',ts:500}),
  row('subagent_start',{agent_id:'first',ts:300}),
  row('post_tool',{agent_id:'first',ts:550})]);
 result=activity.read(6000);
 assert.deepEqual(result.activeSubagents,[{agentId:'second',lastActivityAt:350}]);
 assert.equal(result.lastSubagentActivityAt,550);
 activity.consume([row('subagent_stop',{agent_id:'second',ts:600})]);
 result=activity.read(7000);
 assert.deepEqual(result.activeSubagents,[]);assert.equal(result.lastSubagentActivityAt,600);
});

test('child inactivity expires at the TTL boundary and new activity resets its clock',t=>{
 const {activity,row}=fixture(t);
 activity.consume([row('subagent_start',{agent_id:'worker',ts:200})]);
 assert.equal(activity.read(1800199).activeSubagents.length,1);
 assert.equal(activity.read(1800200).activeSubagents.length,0);
 activity.consume([row('pre_tool',{agent_id:'worker',ts:1800201})]);
 assert.deepEqual(activity.read(1800202).activeSubagents,[{agentId:'worker',lastActivityAt:1800201}]);
 assert.equal(activity.read(1800450,{subagentTtlMs:250}).activeSubagents.length,1);
 assert.equal(activity.read(1800451,{subagentTtlMs:250}).activeSubagents.length,0);
 assert.equal(activity.read(1800451).lastSubagentActivityAt,1800201);
});

test('child aggregation rejects foreign identities and invalid timestamps and requires a start',t=>{
 const {activity,row}=fixture(t);
 activity.consume([row('subagent_start',{agent_id:'worker',ts:200}),
  row('pre_tool',{agent_id:'worker',run_id:'other',ts:9000}),
  row('pre_tool',{agent_id:'worker',session_id:'other',ts:9000}),
  row('pre_tool',{agent_id:'worker',runtime:'codex',ts:9000}),
  row('pre_tool',{agent_id:'worker',type:'runtime_health',ts:9000}),
  ...[NaN,Infinity,'9000',99].map(ts=>row('pre_tool',{agent_id:'worker',ts})),
  row('pre_tool',{agent_id:'orphan',ts:250}),
  row('subagent_start',{agent_id:123,ts:9000})]);
 const result=activity.read(10000);
 assert.deepEqual(result.activeSubagents,[{agentId:'worker',lastActivityAt:200}]);
 assert.equal(result.lastSubagentActivityAt,250);
 assert.equal(result.lastActivityAt,100);assert.equal(result.state,'idle');
});

// Boundary: real event files, rotation and child recovery across main turns.
// Run for activity/recovery changes; unrelated UI work may skip. The official
// runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; fixture closes readers
// and removes its private files. No tmux, PM2, runtime or network is started.
test('restart recovers child lifetimes across rotations and main turn boundaries',async t=>{
 const {appendEvent,rotateEventLog}=await import('../../../../cli/lib/event-log.js');
 for(const terminal of [false,true]){
  const {root,activity,row}=fixture(t);const log=path.join(root,'events.jsonl'),transcript=path.join(root,'s.jsonl');
  fs.writeFileSync(transcript,'{}\n');fs.utimesSync(transcript,0.05,0.05);
  appendEvent(log,row('session_start',{ts:50,transcript_path:transcript}));
  appendEvent(log,row('subagent_start',{agent_id:'worker',ts:110}));
  rotateEventLog(log,{maxBytes:0,now:1000});
  appendEvent(log,row('prompt',{ts:120}));
  appendEvent(log,row('stop',{ts:130}));
  rotateEventLog(log,{maxBytes:0,now:1001});
  appendEvent(log,row('pre_tool',{agent_id:'worker',tool_use_id:'child-tool',ts:140}));
  if(terminal)appendEvent(log,row('subagent_stop',{agent_id:'worker',ts:150}));
  const result=activity.read(10000);
  assert.equal(activity.transcriptPath,transcript);
  assert.deepEqual(result.events.map(event=>event.event),['stop']);
  assert.equal(result.state,'idle');assert.equal(result.lastActivityAt,130);
  assert.deepEqual(result.tools,[]);
  assert.deepEqual(result.activeSubagents,terminal?[]:[{agentId:'worker',lastActivityAt:140}]);
  assert.equal(result.lastSubagentActivityAt,terminal?150:140);
  assert.deepEqual(activity.read(11000).activeSubagents,result.activeSubagents);
  appendEvent(log,row('subagent_stop',{agent_id:'worker',ts:160}));
  const stopped=activity.read(12000);
  assert.deepEqual(stopped.activeSubagents,[]);assert.equal(stopped.lastSubagentActivityAt,160);
 }
});

test('missing native tool id remains busy until factual stop',t=>{
 const {activity,row}=fixture(t);activity.consume([row('pre_tool',{tool:'Bash'})]);assert.equal(activity.read(10000).state,'busy');activity.consume([row('stop',{ts:300})]);assert.equal(activity.read(10000).state,'idle');
});

test('restart: recover latest turn across rotation and associate older session_start before timestamp',async t=>{
 const {appendEvent,rotateEventLog}=await import('../../../../cli/lib/event-log.js');
 const {root,activity,row}=fixture(t);const log=path.join(root,'events.jsonl'),transcript=path.join(root,'s.jsonl');
 fs.writeFileSync(transcript,JSON.stringify({message:{content:[{type:'tool_result',tool_use_id:'done'}]}})+'\n');
 appendEvent(log,row('session_start',{ts:50,transcript_path:transcript}));
 appendEvent(log,row('pre_tool',{ts:110,tool_use_id:'obsolete'}));
 rotateEventLog(log,{maxBytes:0,now:1000});
 appendEvent(log,row('prompt',{ts:120}));
 appendEvent(log,row('pre_tool',{ts:130,tool_use_id:'done',tool:'Read'}));
 rotateEventLog(log,{maxBytes:0,now:1001});
 appendEvent(log,row('pre_tool',{ts:140,tool_use_id:'live',tool:'Bash'}));
 const result=activity.read(10000);
 assert.equal(activity.transcriptPath,transcript);assert.deepEqual(result.tools.map(tool=>tool.id),['live']);
 assert.equal(result.busySince,120);
 assert.deepEqual(result.events.map(event=>event.event),['prompt','pre_tool','pre_tool']);
 appendEvent(log,row('post_tool',{ts:150,tool_use_id:'live'}));assert.equal(activity.read(10000).tools.length,0);
});

test('native-less tools cannot collide with real IDs or be closed by unrelated post/result',t=>{
 const {activity,row}=fixture(t);activity.consume([row('pre_tool'),row('pre_tool',{tool_use_id:'unidentified:1'}),row('post_tool',{tool_use_id:'unidentified:1'})]);
 assert.equal(activity.tools.size,1);assert.equal(typeof activity.read(10000).tools[0].id,'symbol');assert.equal(JSON.stringify(activity.read(10000).tools).includes('unidentified'),false);
 activity.consume([row('stop',{ts:300})]);assert.equal(activity.tools.size,0);
});

test('B: supervisor/pool/router diagnostic mutation cannot provide activity or tool facts',t=>{
 const {root,activity,row}=fixture(t);fs.writeFileSync(path.join(root,'events.jsonl'),JSON.stringify(row('pre_tool',{tool_use_id:'live'}))+'\n');
 const original=activity.read(10000);assert.equal(original.state,'busy');
 for(const name of ['supervisor-events','pool-metrics','router-events']){
  const file=path.join(root,`${name}.jsonl`);
  fs.writeFileSync(file,JSON.stringify({...row('stop'),event:'restart_done',request_id:'forged'})+'\n');
  assert.deepEqual(activity.read(10000).tools,original.tools);
  fs.truncateSync(file,0);fs.renameSync(file,path.join(root,`${name}.1000.jsonl`));fs.unlinkSync(path.join(root,`${name}.1000.jsonl`));
 }
 assert.deepEqual(activity.read(10000).tools,original.tools);
});

test('grouped usage replaces native envelope and rejects missing run identity',t=>{
 const {root}=fixture(t);const env={ZYLOS_DIR:root,ZYLOS_RUN_ID:'r',ZYLOS_SESSION_GROUP:'lark:x'};
 const sample=publishContextSample({session_id:'s',zylos:{v:99,runId:'foreign'}},{env,now:123});
 assert.deepEqual(sample.zylos,{v:1,runId:'r',sessionGroup:'lark:x',capturedAt:123});
 const file=path.join(root,'activity-monitor/session-groups/lark:x/statusline.json');
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),sample);
 for(const runId of [undefined,'','   ']) assert.throws(()=>publishContextSample({session_id:'bad'},{env:{...env,ZYLOS_RUN_ID:runId}}),/Missing statusLine run identity/);
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),sample);
});
test('DM F14: legacy usage stays at legacy path without a fabricated run envelope',t=>{
 const {root}=fixture(t);const original={session_id:'old',cost:{total_cost_usd:7},zylos:{v:1,runId:'forged'}};
 const sample=publishContextSample(original,{env:{ZYLOS_DIR:root},now:123});
 assert.deepEqual(sample,{session_id:'old',cost:{total_cost_usd:7}});
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'activity-monitor/statusline.json'))),sample);
 assert.equal(original.zylos.runId,'forged');
 assert.equal(fs.existsSync(path.join(root,'activity-monitor/session-groups')),false);
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

test('unknown recovered busy start uses run start and transcript-only activity uses last idle sample',t=>{
 const recovered=fixture(t);
 recovered.activity.consume([recovered.row('pre_tool',{ts:5000,tool_use_id:'a'})]);
 assert.equal(recovered.activity.read(6000).busySince,100);
 const {activity,root,row}=fixture(t),transcript=path.join(root,'transcript.jsonl');
 fs.writeFileSync(transcript,'{}\n');fs.utimesSync(transcript,0.1,0.1);
 activity.consume([row('session_start',{ts:100,transcript_path:transcript})]);
 assert.equal(activity.read(5000).state,'idle');assert.equal(activity.read(6000).state,'idle');
 fs.utimesSync(transcript,7,7);assert.equal(activity.read(8000).busySince,6000);
 assert.equal(activity.read(8500).busySince,6000);
});

for(const runtime of ['claude','codex'])test(`quiet samples keep an open ${runtime} turn busy until its closing hook`,t=>{
 const {activity,row}=fixture(t,runtime);
 activity.consume([row('prompt',{ts:6000}),row('pre_tool',{ts:6500,tool_use_id:'first'}),row('post_tool',{ts:7000,tool_use_id:'first'})]);
 assert.equal(activity.read(7500).busySince,6000);
 const quiet=activity.read(11000);
 assert.equal(quiet.state,'busy');assert.equal(quiet.turnOpen,true);assert.equal(quiet.busySince,6000);
 assert.equal(quiet.idleSince,null);assert.equal(quiet.lastActivityAt,7000);assert.equal(quiet.lastResponseAt,6500);
 activity.consume([row('pre_tool',{ts:12000,tool_use_id:'request'}),row('post_tool',{ts:12600,tool_use_id:'request'})]);
 const reply=activity.read(18800);
 assert.equal(reply.state,'busy');assert.equal(reply.turnOpen,true);assert.equal(reply.busySince,6000);
 assert.equal(reply.tools.length,0);assert.equal(reply.idleSince,null);assert.equal(reply.lastResponseAt,12000);
 activity.consume([row(runtime==='claude'?'idle':'stop',{ts:19000})]);
 const closed=activity.read(23000);
 assert.equal(closed.state,'idle');assert.equal(closed.turnOpen,false);assert.equal(closed.busySince,null);
});

for(const runtime of ['claude','codex'])test(`${runtime} model wait remains busy without manufacturing activity or response evidence`,t=>{
 const {activity,row}=fixture(t,runtime);
 activity.consume([row('prompt',{ts:6000})]);
 for(const now of [9001,66000,305999]){
  const waiting=activity.read(now);
  assert.equal(waiting.state,'busy');assert.equal(waiting.turnOpen,true);
  assert.equal(waiting.busySince,6000);assert.equal(waiting.idleSince,null);
  assert.equal(waiting.lastActivityAt,6000);assert.equal(waiting.lastResponseAt,null);
  assert.deepEqual(waiting.tools,[]);assert.equal(waiting.transcriptPending,false);
 }
 activity.consume([row('stop',{ts:307000})]);
 assert.equal(activity.read(309999).state,'busy','closing hook retains the normal recent-activity window');
 const closed=activity.read(310000);
 assert.equal(closed.state,'idle');assert.equal(closed.turnOpen,false);assert.equal(closed.busySince,null);
 assert.equal(closed.idleSince,310000);assert.equal(closed.lastResponseAt,null);
});

for(const runtime of ['claude','codex'])test(`${runtime} restart recovers quiet API wait and accepts only current main-agent closing hooks`,async t=>{
 const {appendEvent,rotateEventLog}=await import('../../../../cli/lib/event-log.js');
 for(const terminal of [false,true]){
  const {root,activity,row}=fixture(t,runtime),log=path.join(root,'events.jsonl');
  appendEvent(log,row('session_start',{ts:100}));
  appendEvent(log,row('prompt',{ts:200}));appendEvent(log,row('stop',{ts:300}));
  rotateEventLog(log,{maxBytes:0,now:1000});
  appendEvent(log,row('prompt',{ts:6000}));
  appendEvent(log,row('stop',{ts:7000,agent_id:'child'}));
  appendEvent(log,row('stop',{ts:7100,session_id:'other'}));
  if(terminal)appendEvent(log,row('stop',{ts:8000}));
  const recovered=activity.read(66000);
  assert.equal(recovered.state,terminal?'idle':'busy');assert.equal(recovered.turnOpen,!terminal);
  assert.equal(recovered.busySince,terminal?null:6000);assert.equal(recovered.lastResponseAt,null);
  assert.equal(recovered.lastActivityAt,terminal?8000:6000);
  assert.deepEqual(recovered.tools,[]);
  assert.equal(activity.read(126000).state,terminal?'idle':'busy');
  if(!terminal){
   appendEvent(log,row(runtime==='claude'?'idle':'stop',{ts:127000}));
   const closed=activity.read(130000);
   assert.equal(closed.state,'idle');assert.equal(closed.turnOpen,false);assert.equal(closed.busySince,null);
  }
 }
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

test('Codex assistant output requires matching rollout identity and excludes input and interruption records',t=>{
 const {root,activity,row}=fixture(t,'codex'),transcript=path.join(root,'s.jsonl');
 const record=(type,ts,payload)=>({type,timestamp:new Date(ts).toISOString(),payload});
 const output=ts=>record('response_item',ts,{type:'message',role:'assistant',content:[{type:'output_text',text:'Working on the task.'}]});
 const rows=[record('session_meta',100,{id:'foreign'}),output(200),record('session_meta',250,{id:'s'}),
  record('response_item',300,{type:'message',role:'user',content:[{type:'input_text',text:'continue'}]}),
  record('event_msg',350,{type:'turn_aborted',reason:'interrupted'})];
 fs.writeFileSync(transcript,rows.map(value=>JSON.stringify(value)).join('\n')+'\n');
 activity.consume([row('session_start',{ts:100,transcript_path:transcript})]);
 assert.equal(activity.read(5000).lastResponseAt,null);
 fs.appendFileSync(transcript,JSON.stringify(output(400))+'\n');
 assert.equal(activity.read(6000).lastResponseAt,400);
 fs.appendFileSync(transcript,JSON.stringify(record('response_item',450,{type:'function_call',name:'exec_command',arguments:'{}',call_id:'call'}))+'\n');
 assert.equal(activity.read(7000).lastResponseAt,450);
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

test('oversized transcript lines have bounded carry and parsing resumes after newline',t=>{
 const {root,activity,row}=fixture(t),transcript=path.join(root,'s.jsonl'),warnings=[];
 activity.warn=value=>warnings.push(value);
 fs.writeFileSync(transcript,'x'.repeat(TRANSCRIPT_LINE_LIMIT_BYTES+1)+'\n'+
  JSON.stringify({type:'assistant',timestamp:new Date(400).toISOString(),sessionId:'s',message:{role:'assistant',model:'claude',content:[{type:'text',text:'Working.'}]}})+'\n');
 activity.consume([row('session_start',{ts:100,transcript_path:transcript})]);
 let value;
 for(let reads=0;reads<8;reads++) {
  value=activity.read(5000+reads);
  assert.ok(activity.transcriptPartial.length<=TRANSCRIPT_LINE_LIMIT_BYTES);
  if(!value.transcriptPending)break;
 }
 assert.equal(value.transcriptPending,false);assert.equal(value.lastResponseAt,400);
 assert.equal(warnings.filter(value=>value==='transcript_line_too_large').length,1);
});

test('recent tool results remain capped across idle gaps before delayed hooks',t=>{
 const {root,activity,row}=fixture(t),transcript=path.join(root,'s.jsonl');
 const result=id=>JSON.stringify({message:{content:[{type:'tool_result',tool_use_id:id}]}})+'\n';
 fs.writeFileSync(transcript,Array.from({length:RECENT_TOOL_RESULTS_LIMIT+40},(_,i)=>result(`result-${i}`)).join(''));
 activity.consume([row('session_start',{ts:100,transcript_path:transcript}),row('pre_tool',{ts:200,tool_use_id:'active'})]);
 activity.read(5000);
 assert.equal(activity.results.size,RECENT_TOOL_RESULTS_LIMIT);
 activity.consume([row('stop',{ts:6000})]);
 fs.appendFileSync(transcript,result('not-paired'));
 activity.read(7000);
 assert.equal(activity.results.has('not-paired'),true);
 assert.ok(activity.results.size<=RECENT_TOOL_RESULTS_LIMIT);
});


test('unfinished EOF record does not fence recovery and completes on a later append',t=>{
 const {root,activity,row}=fixture(t),transcript=path.join(root,'s.jsonl');
 const record=JSON.stringify({type:'assistant',sessionId:'s',timestamp:new Date(400).toISOString(),message:{role:'assistant',model:'claude',content:[{type:'text',text:'Working.'}]}});
 fs.writeFileSync(transcript,record.slice(0,-3));
 activity.consume([row('session_start',{ts:100,transcript_path:transcript})]);
 const partial=activity.read(5000);
 assert.equal(partial.transcriptPending,false);assert.equal(partial.lastResponseAt,null);
 assert.ok(activity.transcriptPartial.length>0);
 assert.equal(activity.read(6000).transcriptPending,false);
 fs.appendFileSync(transcript,record.slice(-3)+'\n');
 const complete=activity.read(7000);
 assert.equal(complete.transcriptPending,false);assert.equal(complete.lastResponseAt,400);
 assert.equal(activity.transcriptPartial.length,0);
});

test('oversized unfinished EOF record remains unknown without indefinitely fencing recovery',t=>{
 const {root,activity,row}=fixture(t),transcript=path.join(root,'s.jsonl');
 fs.writeFileSync(transcript,'x'.repeat(TRANSCRIPT_LINE_LIMIT_BYTES+1));
 activity.consume([row('session_start',{ts:100,transcript_path:transcript})]);
 let value;
 for(let reads=0;reads<8;reads++) {
  value=activity.read(5000+reads);
  if(!value.transcriptPending)break;
 }
 assert.equal(value.transcriptPending,false);assert.equal(value.lastResponseAt,null);
 assert.equal(activity.transcriptSkippingLine,true);assert.equal(activity.transcriptPartial.length,0);
 assert.equal(activity.read(6000).transcriptPending,false);
 fs.appendFileSync(transcript,'\n'+JSON.stringify({type:'assistant',sessionId:'s',timestamp:new Date(400).toISOString(),message:{role:'assistant',model:'claude',content:[{type:'text',text:'Working.'}]}})+'\n');
 const recovered=activity.read(7000);
 assert.equal(recovered.transcriptPending,false);assert.equal(recovered.lastResponseAt,400);
 assert.equal(activity.transcriptSkippingLine,false);
});

test('a result parsed during an idle hook gap prevents a delayed pre-tool from becoming phantom work',t=>{
 const {root,activity,row}=fixture(t),transcript=path.join(root,'s.jsonl');
 fs.writeFileSync(transcript,JSON.stringify({message:{role:'user',content:[{type:'tool_result',tool_use_id:'delayed'}]}})+'\n');
 activity.consume([row('session_start',{transcript_path:transcript})]);activity.read(5000);
 assert.equal(activity.tools.size,0);activity.consume([row('pre_tool',{tool_use_id:'delayed',ts:300})]);
 assert.equal(activity.tools.size,0);assert.ok(activity.results.size<=RECENT_TOOL_RESULTS_LIMIT);
});

test('assistant metadata, missing model and synthetic records cannot count as AI response',t=>{
 const {root,activity,row}=fixture(t),transcript=path.join(root,'s.jsonl');
 const native=(model,more={})=>({type:'assistant',sessionId:'s',timestamp:new Date(400).toISOString(),isSidechain:false,
  message:{role:'assistant',model,content:[{type:'text',text:'Some text'}]},...more});
 fs.writeFileSync(transcript,[native('claude',{isMeta:true}),native(''),native(undefined),native('<synthetic>'),native('claude',{error:'interrupted'}),
  native('claude',{message:{role:'assistant',model:'claude',isMeta:true,content:[{type:'text',text:'Metadata'}]}})]
  .map(value=>JSON.stringify(value)).join('\n')+'\n');
 activity.consume([row('session_start',{ts:100,transcript_path:transcript})]);
 assert.equal(activity.read(5000).lastResponseAt,null);
});

test('Codex metadata records cannot impersonate assistant output or tool calls',t=>{
 const {root,activity,row}=fixture(t,'codex'),transcript=path.join(root,'s.jsonl');
 const record=(type,ts,payload,more={})=>({type,timestamp:new Date(ts).toISOString(),payload,...more});
 const rows=[record('session_meta',100,{id:'s'}),
  record('response_item',300,{type:'message',role:'assistant',content:[{type:'output_text',text:'Metadata output'}]},{isMeta:true}),
  record('response_item',400,{type:'function_call',name:'exec_command',isMeta:true})];
 fs.writeFileSync(transcript,rows.map(value=>JSON.stringify(value)).join('\n')+'\n');
 activity.consume([row('session_start',{ts:100,transcript_path:transcript})]);
 assert.equal(activity.read(5000).lastResponseAt,null);
});

for(const block of [{type:'thinking',thinking:'Considering the next step.'},{type:'tool_use',id:'call',name:'Read',input:{file_path:'fixture'}}])test(`Claude ${block.type}-only assistant content counts as genuine response`,t=>{
 const {root,activity,row}=fixture(t),transcript=path.join(root,'s.jsonl');
 fs.writeFileSync(transcript,JSON.stringify({type:'assistant',sessionId:'s',timestamp:new Date(400).toISOString(),isSidechain:false,
  message:{role:'assistant',model:'claude',content:[block]}})+'\n');
 activity.consume([row('session_start',{ts:100,transcript_path:transcript})]);
 assert.equal(activity.read(5000).lastResponseAt,400);
});

test('replacement Codex rollout inode must establish its own matching session identity',t=>{
 const {root,activity,row}=fixture(t,'codex'),transcript=path.join(root,'s.jsonl');
 const native=(type,ts,payload)=>JSON.stringify({type,timestamp:new Date(ts).toISOString(),payload})+'\n';
 const output=ts=>native('response_item',ts,{type:'message',role:'assistant',content:[{type:'output_text',text:'Actual assistant output.'}]});
 fs.writeFileSync(transcript,native('session_meta',100,{id:'s'}));
 activity.consume([row('session_start',{ts:100,transcript_path:transcript})]);
 assert.equal(activity.read(5000).lastResponseAt,null);
 fs.renameSync(transcript,path.join(root,'previous.jsonl'));
 fs.writeFileSync(transcript,output(400));
 assert.equal(activity.read(6000).lastResponseAt,null);
 fs.appendFileSync(transcript,native('session_meta',450,{id:'s'})+output(500));
 assert.equal(activity.read(7000).lastResponseAt,500);
});

for(const extra of [0,1])test(`valid JSONL record ${extra?'above':'at'} the transcript line limit is ${extra?'skipped':'parsed'}`,t=>{
 const {root,activity,row}=fixture(t),transcript=path.join(root,'s.jsonl'),warnings=[];
 activity.warn=value=>warnings.push(value);
 const record={type:'assistant',sessionId:'s',timestamp:new Date(400).toISOString(),message:{role:'assistant',model:'claude',content:[{type:'text',text:'Working.'}]},padding:''};
 const base=JSON.stringify(record);
 record.padding='x'.repeat(TRANSCRIPT_LINE_LIMIT_BYTES+extra-Buffer.byteLength(base));
 const line=JSON.stringify(record);
 assert.equal(Buffer.byteLength(line),TRANSCRIPT_LINE_LIMIT_BYTES+extra);
 fs.writeFileSync(transcript,line+'\n');
 activity.consume([row('session_start',{ts:100,transcript_path:transcript})]);
 let value;
 for(let reads=0;reads<8;reads++) {
  value=activity.read(5000+reads);
  if(!value.transcriptPending)break;
 }
 assert.equal(value.transcriptPending,false);
 assert.equal(value.lastResponseAt,extra?null:400);
 assert.equal(warnings.filter(value=>value==='transcript_line_too_large').length,extra);
});

test('Codex response timestamps must belong to the current session lifetime',t=>{
 const {root,activity,row}=fixture(t,'codex'),transcript=path.join(root,'s.jsonl');
 const native=(type,timestamp,payload)=>({type,timestamp,payload});
 const user={type:'message',role:'user',content:[{type:'input_text',text:'Processed request'}]};
 const output={type:'message',role:'assistant',content:[{type:'output_text',text:'Actual response'}]};
 const rows=[native('session_meta',new Date(50).toISOString(),{id:'s'}),
  native('response_item',new Date(99).toISOString(),user),native('response_item',new Date(99).toISOString(),output),
  native('response_item','invalid',user),native('response_item',400,output)];
 fs.writeFileSync(transcript,rows.map(value=>JSON.stringify(value)).join('\n')+'\n');
 activity.consume([row('session_start',{ts:100,transcript_path:transcript})]);
 const excluded=activity.read(5000);
 assert.equal(excluded.lastResponseAt,null);
 fs.appendFileSync(transcript,JSON.stringify(native('response_item',new Date(100).toISOString(),user))+'\n'+
  JSON.stringify(native('response_item',new Date(100).toISOString(),output))+'\n');
 const boundary=activity.read(6000);
 assert.equal(boundary.lastResponseAt,100);
});


for(const runtime of ['claude','codex'])test(`${runtime} input side effects and lifecycle hooks never count as AI response`,t=>{
 const {root,activity,row}=fixture(t,runtime),transcript=path.join(root,'s.jsonl');
 const native=(type,ts,more)=>({type,timestamp:new Date(ts).toISOString(),...more});
 const rows=runtime==='claude' ? [
  native('user',300,{sessionId:'s',message:{role:'user',content:'Please answer.'}}),
  native('queue-operation',310,{sessionId:'s',operation:'enqueue'}),
  native('queue-operation',320,{sessionId:'s',operation:'dequeue'}),
  native('queue-operation',330,{sessionId:'s',operation:'remove',reason:'absorbed_mid_turn'}),
  native('attachment',340,{sessionId:'s',attachment:{type:'queued_command',commandMode:'prompt'}}),
 ] : [
  native('session_meta',100,{payload:{id:'s'}}),
  native('response_item',300,{payload:{type:'message',role:'user',content:[{type:'input_text',text:'Please answer.'}]}}),
  native('event_msg',310,{payload:{type:'user_message',message:'continue'}}),
  native('event_msg',320,{payload:{type:'turn_aborted'}}),
 ];
 fs.writeFileSync(transcript,rows.map(value=>JSON.stringify(value)).join('\n')+'\n');
 activity.consume([row('session_start',{ts:100,transcript_path:transcript}),
  ...['prompt','post_tool','post_tool_failure','permission_request','stop','idle'].map(event=>row(event,{ts:350})),
  ...['subagent_start','subagent_stop','post_tool','post_tool_failure'].map(event=>row(event,{ts:360,agent_id:'child'}))]);
 assert.equal(activity.read(5000).lastResponseAt,null);
});

for(const runtime of ['claude','codex'])test(`${runtime} recovers only actual main and child pre-tool response history across newer prompts`,async t=>{
 const {appendEvent,rotateEventLog}=await import('../../../../cli/lib/event-log.js');
 const {root,activity,row}=fixture(t,runtime),log=path.join(root,'events.jsonl'),transcript=path.join(root,'s.jsonl');
 fs.writeFileSync(transcript,'');
 appendEvent(log,row('session_start',{ts:100,transcript_path:transcript}));
 appendEvent(log,row('pre_tool',{ts:200,tool_use_id:'old-main'}));
 appendEvent(log,row('pre_tool',{ts:250,agent_id:'child',tool_use_id:'old-child'}));
 appendEvent(log,row('stop',{ts:300}));
 rotateEventLog(log,{maxBytes:0,now:1000});
 appendEvent(log,row('prompt',{ts:400}));
 appendEvent(log,row('post_tool',{ts:450}));
 for(const now of [5000,6000]) {
  const result=activity.read(now);
  assert.equal(result.lastResponseAt,250);assert.deepEqual(result.tools,[]);
  assert.equal(result.turnOpen,true);assert.equal(result.busySince,400);
 }
});

test('Claude AI response recognition excludes foreign sessions, children and invalid lifetime timestamps',t=>{
 const {activity}=fixture(t);
 const native=more=>({type:'assistant',sessionId:'s',timestamp:new Date(400).toISOString(),
  message:{role:'assistant',model:'claude-sonnet-4-5',content:[{type:'text',text:'Working.'}]},...more});
 for(const more of [{sessionId:'foreign'},{isSidechain:true},{agent_id:'child'},{agentId:'child'},
  {timestamp:new Date(99).toISOString()},{timestamp:'invalid'},{timestamp:400}])activity.recordTranscript(native(more));
 assert.equal(activity.lastResponseAt,null);
 activity.recordTranscript(native({timestamp:new Date(100).toISOString()}));
 assert.equal(activity.lastResponseAt,100);
});

for(const event of ['pre_tool','post_tool','post_tool_failure','permission_request','subagent_start','subagent_stop'])test(`only matching pre_tool records count as response, not ${event} side effects`,t=>{
 const {activity,row}=fixture(t);
 for(const agent_id of [undefined,'child']) {
  activity.consume([row(event,{ts:200,agent_id})]);
  for(const more of [{run_id:'foreign'},{session_id:'foreign'},{runtime:'codex'},{type:'runtime_health'},
   ...[NaN,Infinity,'9000',99].map(ts=>({ts}))])activity.consume([row('pre_tool',{ts:9000,agent_id,...more})]);
 }
 assert.equal(activity.read(10000).lastResponseAt,event==='pre_tool'?200:null);
});

test('Codex custom tool calls are actual response records',t=>{
 const {activity}=fixture(t,'codex');
 activity.recordTranscript({type:'session_meta',payload:{id:'s'}});
 activity.recordTranscript({type:'response_item',timestamp:new Date(400).toISOString(),
  payload:{type:'custom_tool_call',name:'apply_patch',input:'*** Begin Patch\n*** End Patch',call_id:'call'}});
 assert.equal(activity.lastResponseAt,400);
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

test('AGY busy status includes active native tasks and running subagents', t => {
 for(const [extra,busy] of [
  [{},false],
  [{task_count:0,subagents:[]},false],
  [{task_count:1},true],
  [{subagents:[{id:'child',status:'running'}]},true],
  [{subagents:[{id:'done',status:'completed'},{id:'active',status:'running'}]},true],
  [{subagents:[{id:'child',status:'completed'}]},false],
 ]) {
  const {root,activity,row}=fixture(t,'agy');activity.consume([row('prompt')]);
  fs.writeFileSync(path.join(root,'statusline.json'),JSON.stringify({session_id:'s',agent_state:'idle',...extra,
   zylos:{v:1,runId:'r',capturedAt:1000}}));
  assert.equal(activity.read(72000).state,busy?'busy':'idle',JSON.stringify(extra));
 }
});

test('completed AGY subagent reorder and list growth do not restart idle stability', t => {
 const {root,activity,row}=fixture(t,'agy');activity.consume([row('prompt')]);
 const done=id=>({id,status:'completed'});
 const write=(capturedAt,subagents)=>fs.writeFileSync(path.join(root,'statusline.json'),JSON.stringify({
  session_id:'s',agent_state:'idle',subagents,zylos:{v:1,runId:'r',capturedAt}}));
 write(1000,[done('a'),done('b')]);assert.equal(activity.read(1000).state,'busy');
 write(1200,[done('b'),done('a'),done('c')]);assert.equal(activity.read(1500).state,'idle');
 write(72000,[done('c'),done('a'),done('d'),done('b')]);assert.equal(activity.read(72000).state,'idle');
 assert.equal(activity.read(145000).state,'idle');
});

test('AGY no-expiry status still rejects foreign identity, future and pre-activity samples', t => {
 for(const patch of [
  {session_id:'other'}, {zylos:{v:1,runId:'other',capturedAt:1000}},
  {zylos:{v:2,runId:'r',capturedAt:1000}}, {zylos:{v:1,runId:'r',capturedAt:73000}},
  {zylos:{v:1,runId:'r',capturedAt:50}}, {zylos:{v:1,runId:'r',capturedAt:150}},
 ]) {
  const {root,activity,row}=fixture(t,'agy');activity.consume([row('prompt')]);
  fs.writeFileSync(path.join(root,'statusline.json'),JSON.stringify({session_id:'s',agent_state:'idle',
   zylos:{v:1,runId:'r',capturedAt:1000},...patch}));
  assert.equal(activity.read(72000).state,'busy',JSON.stringify(patch));
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

for(const runtime of ['claude','codex'])test(`${runtime} unfinished tools survive silent long turns and reader restart`,async t=>{
 const {appendEvent}=await import('../../../../cli/lib/event-log.js');
 const {root,activity,row}=fixture(t,runtime);
 appendEvent(path.join(root,'events.jsonl'),row('prompt',{ts:6000}));
 appendEvent(path.join(root,'events.jsonl'),row('pre_tool',{ts:7000,tool_use_id:'foreground',tool:'Bash'}));
 const check=reader=>{
  for(const now of [307000,1227000,2407000]) {
   const observed=reader.read(now);
   assert.equal(observed.state,'busy');assert.equal(observed.turnOpen,true);
   assert.equal(observed.tools.length,1);assert.equal(observed.tools[0].id,'foreground');
   assert.equal(observed.lastActivityAt,7000);assert.equal(observed.lastResponseAt,7000);
   assert.equal(observed.quietTurnDue,false);assert.equal(reader.claimQuietTurn(7000,now),false);
  }
 };
 check(activity);
 const restarted=new SessionActivity({runDir:root,runId:'r',sessionId:'s',runtime,startedAt:100});
 t.after(()=>restarted.close());check(restarted);
 appendEvent(path.join(root,'events.jsonl'),row('post_tool',{ts:608000,tool_use_id:'foreground'}));
 assert.equal(restarted.read(608000+OPEN_TURN_INACTIVITY_TIMEOUT_MS-1).state,'busy');
 const due=restarted.read(608000+OPEN_TURN_INACTIVITY_TIMEOUT_MS);
 assert.equal(due.state,'busy');assert.equal(due.tools.length,0);assert.equal(due.quietTurnDue,true);
});

for(const runtime of ['claude','codex'])test(`${runtime} hook and transcript activity each extend the open-turn deadline`,t=>{
 const {root,activity,row}=fixture(t,runtime),transcript=path.join(root,'s.jsonl');
 fs.writeFileSync(transcript,'');fs.utimesSync(transcript,0.1,0.1);
 activity.consume([row('session_start',{transcript_path:transcript}),row('prompt',{ts:6000})]);
 assert.equal(activity.read(305999).state,'busy');
 activity.consume([row('post_tool',{ts:305999,tool_use_id:'done'})]);
 assert.equal(activity.read(605998).state,'busy');
 // Partial/unfinished native output still grows the file during streaming.
 fs.appendFileSync(transcript,'{"streaming":');fs.utimesSync(transcript,605.998,605.998);
 assert.equal(activity.read(605999).state,'busy');
 assert.equal(activity.read(905997).state,'busy');
 const due=activity.read(605998+OPEN_TURN_INACTIVITY_TIMEOUT_MS);
 assert.equal(due.state,'busy');assert.equal(due.quietTurnDue,true);
 assert.equal(due.lastActivityAt,605998);assert.equal(due.lastResponseAt,null);
});

for(const runtime of ['claude','codex'])test(`${runtime} restart retains the original quiet-turn deadline without declaring idle`,async t=>{
 const {appendEvent}=await import('../../../../cli/lib/event-log.js');
 const {root,activity,row}=fixture(t,runtime);
 appendEvent(path.join(root,'events.jsonl'),row('prompt',{ts:6000}));
 const due=activity.read(6000+OPEN_TURN_INACTIVITY_TIMEOUT_MS);
 assert.equal(due.state,'busy');assert.equal(due.turnOpen,true);assert.equal(due.quietTurnDue,true);
 assert.equal(due.lastActivityAt,6000);
});

for(const runtime of ['claude','codex'])test(`${runtime} changed native turn rejects an old quiet-turn admission`,t=>{
 const {activity,row}=fixture(t,runtime),deadline=6000+OPEN_TURN_INACTIVITY_TIMEOUT_MS;
 activity.consume([row('prompt',{ts:6000})]);activity.read(deadline);
 assert.equal(activity.claimQuietTurn(6000,deadline),true);
 activity.consume([row('prompt',{ts:deadline+1})]);
 activity.consume([row('quiet_turn_interrupt',{ts:deadline+2,turn_started_at:6000,last_activity_at:6000,
  last_native_activity_at:6000,last_response_at:null,control_id:7})]);
 assert.equal(activity.read(deadline+2).state,'busy');
 assert.equal(activity.claimQuietTurn(deadline+1,deadline+1+OPEN_TURN_INACTIVITY_TIMEOUT_MS),true);
});

for(const runtime of ['claude','codex'])test(`${runtime} recovered interrupt facts retain scope and cannot close newer native work`,async t=>{
 const {appendEvent}=await import('../../../../cli/lib/event-log.js');
 for(const newer of ['prompt','pre_tool']){
  const {root,activity,row}=fixture(t,runtime),file=path.join(root,'events.jsonl');
  appendEvent(file,row('prompt',{ts:6000}));
  appendEvent(file,row('quiet_turn_interrupt_attempt',{ts:1206000,last_activity_at:6000,turn_started_at:6000,last_native_activity_at:6000,last_response_at:null}));
  appendEvent(file,row(newer,{ts:1206001,tool_use_id:'new-tool'}));
  appendEvent(file,row('quiet_turn_interrupt',{ts:1206002,last_activity_at:6000,turn_started_at:6000,last_native_activity_at:6000,last_response_at:null,control_id:7}));
  const recovered=activity.read(1206003);
  assert.equal(recovered.state,'busy');assert.equal(recovered.turnOpen,true);
  assert.equal(recovered.lastActivityAt,1206001);
  assert.equal(recovered.lastResponseAt,newer==='pre_tool'?1206001:null);
  assert.equal(recovered.tools.length,newer==='pre_tool'?1:0);
 }
 const {root,activity,row}=fixture(t,runtime),file=path.join(root,'events.jsonl');
 appendEvent(file,row('prompt',{ts:6000}));
 for(const foreign of [{run_id:'other'},{session_id:'other'},{runtime:'other'},{agent_id:'child'}]){
  appendEvent(file,row('quiet_turn_interrupt_attempt',{ts:1206000,last_activity_at:6000,turn_started_at:6000,last_native_activity_at:6000,last_response_at:null,...foreign}));
  appendEvent(file,row('quiet_turn_interrupt',{ts:1206001,last_activity_at:6000,turn_started_at:6000,last_native_activity_at:6000,last_response_at:null,control_id:7,...foreign}));
 }
 const recovered=activity.read(1206002);
 assert.equal(recovered.state,'busy');assert.equal(recovered.lastActivityAt,6000);assert.equal(recovered.lastResponseAt,null);
 assert.equal(activity.claimQuietTurn(6000,1206002),true);
});
