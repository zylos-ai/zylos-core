import { getRuntime } from '../../../../cli/lib/runtime/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleAgyHook, runAgySessionStart } from '../agy-hooks.js';
import { SessionActivity } from '../session-activity.js';
import { collectHealthHook } from '../hook-health.js';
import { HealthStore } from '../health-store.js';
import { hooks } from '../../../../cli/lib/runtime/agy/hooks.js';

const agyHookHealth = (await getRuntime('agy')).health.hookHealth;

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-hooks-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'activity-monitor/session-groups/origin');fs.mkdirSync(dir,{recursive:true});
  const env={ZYLOS_DIR:root,ZYLOS_RUN_ID:'run',ZYLOS_MODEL_CONFIG:'{"runtime":"agy"}'};
  return {root,dir,env};
}
test('SessionStart returns JSON injection and consumes only the run clear marker',async t=>{
  const {dir,env}=fixture(t);fs.writeFileSync(path.join(dir,'agy-session-source'),JSON.stringify({runId:'run',source:'clear'}));
  let source;
  const result=await handleAgyHook({conversationId:'session',lastUserInput:'System startup trigger, not a user message. Continue with startup context.'}, {env,eventName:'SessionStart',activity:()=>null,health:()=>null,
    instructions:()=> 'full tail rules\n',orchestrate:async (payload,{writeSync})=>{
      source=payload.source;const buffer=Buffer.from('RECENT CONVERSATIONS\nOUT: already answered');writeSync(1,buffer,0,buffer.length);
    }});
  assert.equal(source,'clear');assert.equal(fs.existsSync(path.join(dir,'agy-session-source')),false);
  const message = JSON.parse(hooks.output({ event: 'SessionStart', result: result })).injectSteps[0].systemMessage.systemMessage;
  const reminder = 'Messages in RECENT CONVERSATIONS that you have already replied to are finished: do not reply to them again.';
  assert.equal(message, `full tail rules\nRECENT CONVERSATIONS\nOUT: already answered\n${reminder}\n`);
  assert.equal(message.split(reminder).length - 1, 1);
});
test('ERROR stops retain identity and schedule a retry without pausing health',async t=>{
  const {root,env}=fixture(t),now=10000;
  const native={conversationId:'session',terminationReason:'ERROR',error:'sensitive native text'};
  const event=await collectHealthHook(hooks.normalize(native,'Stop'),{zylosDir:root,env,nowMs:now,pid:123});
  assert.equal(event.runtime,'agy');assert.equal(event.error,'server_error');
  const store=new HealthStore({runtime:'agy',zylosDir:root,now:()=>now});
  const result=store.consume(event,{hookHealth:agyHookHealth,runId:'run',identity:{runtime:'agy',session_id:'session',claude_pid:123}});
  assert.equal(result.status,'processed');assert.equal(store.read().health,'ok');
  assert.equal(store.read().failure_retry.dueAt,now+30000);
  assert.equal(JSON.stringify(store.read()).includes('sensitive native text'),false);
});
test('busy hooks survive quiet tools and fully-idle stops debounce queued turns',t=>{
  const {dir}=fixture(t),activity=new SessionActivity({runDir:dir,runId:'run',sessionId:'session',runtime:'agy',startedAt:100});
  t.after(()=>activity.close());
  const row=(event,ts)=>({event,ts,runtime:'agy',run_id:'run',session_id:'session'});
  activity.consume([row('prompt',200)]);assert.equal(activity.read(10000).state,'busy');
  activity.consume([row('stop',11000)]);assert.equal(activity.read(11240).state,'busy');
  activity.consume([row('prompt',11250)]);assert.equal(activity.read(13000).state,'busy');
  activity.consume([row('stop',14000)]);assert.equal(activity.read(14500).state,'idle');
});

test('startup emits every declared shard before publishing readiness',async t=>{
  const {env}=fixture(t), chunks=[];let readyOutput;
  const chain=['identity','custom','component'].map((name,chainIndex)=>({name,chainIndex,emit:async()=>name+' marker'}));
  await runAgySessionStart({session_id:'session',source:'startup'}, {env,chainBuilder:()=>({chain}),foreground:()=>{},ready:()=>{readyOutput=Buffer.concat(chunks).toString('utf8');},
    stdout:{fd:1},writeSync:(_fd,buffer,offset,length)=>{chunks.push(Buffer.from(buffer.subarray(offset,offset+length)));return length;}});
  assert.match(readyOutput,/\[2\/3\] custom/);assert.match(readyOutput,/component marker/);
  assert.ok(readyOutput.indexOf('identity marker')<readyOutput.indexOf('custom marker'));
});
