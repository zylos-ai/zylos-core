import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SessionActivity} from '../session-activity.js';
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
 fs.writeFileSync(transcript,JSON.stringify({message:{content:[{type:'tool_result',tool_use_id:'a'},{type:'tool_result',tool_use_id:'late'}]}})+'\n');
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
