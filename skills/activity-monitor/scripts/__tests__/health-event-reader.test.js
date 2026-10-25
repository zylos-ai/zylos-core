import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HealthEventReader } from '../health-event-reader.js';
import { RuntimeHealthCoordinator } from '../runtime-health.js';
import { appendEvent } from '../../../../cli/lib/event-log.js';

test('T02 F6 cursor keeps failed commit retryable and restarted reader deduplicates through F10',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'health-reader-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const now=Date.now(),scene={sessionGroup:'telegram:a',runtime:'claude',runDir:path.join(root,'group')},identity={runtime:'claude',session_id:'session',claude_pid:123};
  const health=new RuntimeHealthCoordinator({zylosDir:root,now:()=>now}), reader=new HealthEventReader({coordinator:health,zylosDir:root,now:()=>now,quota:()=>null});t.after(()=>reader.close());
  appendEvent(path.join(scene.runDir,'events.jsonl'),{type:'runtime_health',schema_version:1,source:'hook',runtime:'claude',event:'stop_failure',error:'rate_limit',event_id:'11111111-1111-4111-8111-111111111111',prompt_id:null,received_at:now,...identity});
  const store=health.store('claude'),write=store.write.bind(store);store.write=()=>{throw new Error('disk failed');};
  await assert.rejects(reader.consumeScene(scene,identity),/disk failed/);assert.equal(reader.streams.get(scene.sessionGroup).pending.length,1);
  store.write=write;assert.equal((await reader.consumeScene(scene,identity))[0].status,'processed');assert.equal(store.read(scene.sessionGroup).last_processed.received_at,now);
  reader.close();const restarted=new HealthEventReader({coordinator:health,zylosDir:root,quota:()=>null});t.after(()=>restarted.close());
  assert.equal((await restarted.consumeScene(scene,identity))[0].reason,'replay');
});

test('T02 F6 ingestion enriches from its own current F5, never another group or legacy quota',async t=>{
 const {publishContextSample}=await import('../context-monitor.js');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'health-reader-quota-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const now=Date.now(),captured=[];
 const coordinator={consumeHook:async(runtime,event,options)=>{captured.push(options.quota);return {status:'processed'};}};
 const reader=new HealthEventReader({coordinator,zylosDir:root,now:()=>now});t.after(()=>reader.close());
 for(const [group,runId,usage] of [['chat:A','run-a',100],['chat:B','run-b',20]]){
  const env={ZYLOS_DIR:root,ZYLOS_SESSION_GROUP:group,ZYLOS_RUN_ID:runId};
  publishContextSample({session_id:'s',rate_limits:{five_hour:{used_percentage:usage}}},{env,now});
  const scene={sessionGroup:group,runtime:'claude',runId,runDir:path.join(root,'activity-monitor/session-groups',group)};
  appendEvent(path.join(scene.runDir,'events.jsonl'),{type:'runtime_health',runtime:'claude'});
  await reader.consumeScene(scene,{runtime:'claude',session_id:'s',claude_pid:123});
 }
 assert.deepEqual(captured.map(value=>value.rate_limits.five_hour.used_percentage),[100,20]);
});
