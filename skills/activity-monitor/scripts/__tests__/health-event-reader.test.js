import { getRuntime } from '../../../../cli/lib/runtime/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HealthEventReader } from '../health-event-reader.js';
import { RuntimeHealthCoordinator } from '../runtime-health.js';
import { appendEvent } from '../../../../cli/lib/event-log.js';

const hookHealth = (await getRuntime('claude')).health.hookHealth;

test('cursor keeps failed commit retryable and restarted reader deduplicates through',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'health-reader-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const now=Date.now(),scene={sessionGroup:'telegram:a',runtime:'claude',runDir:path.join(root,'group')},identity={runtime:'claude',session_id:'session',claude_pid:123};
  const health=new RuntimeHealthCoordinator({zylosDir:root,now:()=>now}), reader=new HealthEventReader({coordinator:health,zylosDir:root,now:()=>now,quota:()=>null});t.after(()=>reader.close());
  appendEvent(path.join(scene.runDir,'events.jsonl'),{type:'runtime_health',schema_version:1,source:'hook',runtime:'claude',event:'stop_failure',error:'rate_limit',event_id:'11111111-1111-4111-8111-111111111111',prompt_id:null,received_at:now,...identity});
  const store=health.store('claude'),write=store.write.bind(store);store.write=()=>{throw new Error('disk failed');};
  await assert.rejects(reader.consumeScene(scene,identity,{hookHealth}),/disk failed/);assert.equal(reader.streams.get(scene.sessionGroup).pending.length,1);
  store.write=write;assert.equal((await reader.consumeScene(scene,identity,{hookHealth}))[0].status,'processed');assert.equal(store.read(scene.sessionGroup).last_processed.received_at,now);
  reader.close();const restarted=new HealthEventReader({coordinator:health,zylosDir:root,quota:()=>null});t.after(()=>restarted.close());
  assert.equal((await restarted.consumeScene(scene,identity,{hookHealth}))[0].reason,'replay');
});

