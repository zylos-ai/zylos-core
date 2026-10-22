import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {collectHealthHook,wakeHealthMonitor} from '../hook-health.js';
import {readProcessStart} from '../runtime-generation.js';
function fixture(t) {
  const zylosDir=fs.mkdtempSync(path.join(os.tmpdir(),'health-hook-stream-'));
  t.after(()=>fs.rmSync(zylosDir,{recursive:true,force:true}));
  return {zylosDir,pid:process.pid,processStart:readProcessStart(process.pid)};
}
const payload={hook_event_name:'StopFailure',session_id:'session',prompt_id:'prompt',error:'rate_limit'};
test('collector appends bounded structured evidence without private prompt or error text',t=>{
  const options=fixture(t);
  const event=collectHealthHook({...payload,prompt:'PRIVATE',error_details:'You have hit your usage limit PRIVATE'},options);
  assert.equal(event.event,'stop_failure');assert.equal(event.type,'runtime_health');assert.equal(event.claude_pid,process.pid);
  const raw=fs.readFileSync(path.join(options.zylosDir,'activity-monitor/tool-events.jsonl'),'utf8');
  assert.doesNotMatch(raw,/PRIVATE|runtime_generation/);assert.equal(JSON.parse(raw).event_id,event.event_id);
  assert.equal(fs.existsSync(path.join(options.zylosDir,'activity-monitor/health-inbox')),false);
});
test('collector writes all registered event types in append order',t=>{
  const options=fixture(t);
  for (const hook_event_name of ['SessionStart','UserPromptSubmit','Stop','StopFailure']) collectHealthHook({...payload,hook_event_name},options);
  const records=fs.readFileSync(path.join(options.zylosDir,'activity-monitor/tool-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(e=>e.event),['session_start','prompt_submit','stop','stop_failure']);
  assert.equal(new Set(records.map(e=>e.event_id)).size,4);
});
test('invalid identity, subagent and unsupported event are rejected without writes',t=>{
  const options=fixture(t);
  for(const change of [{session_id:''},{agent_id:'subagent'},{hook_event_name:'PostToolUse'},{error:''}]) assert.equal(collectHealthHook({...payload,...change},options),null);
  assert.equal(collectHealthHook(payload,{...options,pid:0}),null);
  assert.equal(collectHealthHook(payload,{...options,processStart:null}),null);
  assert.equal(fs.existsSync(path.join(options.zylosDir,'activity-monitor/tool-events.jsonl')),false);
});
test('unknown error is neutral and raw category is not persisted',t=>{
  const options=fixture(t);assert.equal(collectHealthHook({...payload,error:'private_error'},options).error,'unknown');
  assert.doesNotMatch(fs.readFileSync(path.join(options.zylosDir,'activity-monitor/tool-events.jsonl'),'utf8'),/private_error/);
});
test('append failure propagates without creating inbox or fallback identity',t=>{
  const options=fixture(t);fs.mkdirSync(path.join(options.zylosDir,'activity-monitor/tool-events.jsonl'),{recursive:true});
  assert.throws(()=>collectHealthHook(payload,options));
  assert.equal(fs.existsSync(path.join(options.zylosDir,'activity-monitor/runtime-generation.json')),false);
});
test('wakeup to absent monitor is bounded and harmless',async t=>{
  const options=fixture(t);await wakeHealthMonitor({...options,timeoutMs:20});
});
test('CLI collector fails open for malformed input without echoing sensitive text',t=>{
  const options=fixture(t);const script=fileURLToPath(new URL('../hook-health.js',import.meta.url));
  const result=spawnSync(process.execPath,[script],{input:'PRIVATE invalid json',encoding:'utf8',env:{...process.env,ZYLOS_DIR:options.zylosDir}});
  assert.equal(result.status,0);assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE/);
  assert.match(result.stderr,/could not be persisted/);
});
