import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeAgyHook, handleAgyHook, runAgySessionStart, readAgySessionSource } from '../agy-hooks.js';
import { SessionActivity } from '../session-activity.js';
import { publishContextSample } from '../context-monitor.js';
import { collectHealthHook } from '../hook-health.js';
import { HealthStore } from '../health-store.js';
import { usageModelFacts } from '../../../../cli/lib/session-usage-reader.js';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-hooks-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'activity-monitor/session-groups/origin');fs.mkdirSync(dir,{recursive:true});
  const env={ZYLOS_DIR:root,ZYLOS_RUN_ID:'run',ZYLOS_MODEL_CONFIG:'{"runtime":"agy"}'};
  return {root,dir,env};
}
test('native hook normalization filters partial stops and later invocations',()=>{
  const payload={conversationId:'session',transcriptPath:'/isolated/native.jsonl'};
  const start=normalizeAgyHook(payload,'SessionStart');
  assert.equal(start.session_id,'session');assert.equal(start.transcript_path,payload.transcriptPath);
  assert.equal(normalizeAgyHook({...payload,invocationNum:1},'PreInvocation'),null);
  assert.equal(normalizeAgyHook({...payload,invocationNum:0},'PreInvocation').hook_event_name,'UserPromptSubmit');
  assert.equal(normalizeAgyHook({...payload,fullyIdle:false},'Stop'),null);
  assert.equal(normalizeAgyHook({...payload,fullyIdle:true},'Stop').hook_event_name,'Stop');
  assert.equal(normalizeAgyHook({...payload,terminationReason:'ERROR'},'Stop').hook_event_name,'StopFailure');
});
test('SessionStart returns JSON injection and consumes only the run clear marker',async t=>{
  const {dir,env}=fixture(t);fs.writeFileSync(path.join(dir,'agy-session-source'),JSON.stringify({runId:'run',source:'clear'}));
  let source;
  const result=await handleAgyHook({conversationId:'session',lastUserInput:'System startup trigger, not a user message. Continue with startup context.'}, {env,eventName:'SessionStart',activity:()=>null,health:()=>null,
    instructions:()=> 'full tail rules\n',orchestrate:async (payload,{writeSync})=>{
      source=payload.source;const buffer=Buffer.from('RECENT CONVERSATIONS\nOUT: already answered');writeSync(1,buffer,0,buffer.length);
    }});
  assert.equal(source,'clear');assert.equal(fs.existsSync(path.join(dir,'agy-session-source')),false);
  const message = result.injectSteps[0].systemMessage.systemMessage;
  const reminder = 'Messages in RECENT CONVERSATIONS that you have already replied to are finished: do not reply to them again.';
  assert.equal(message, `full tail rules\nRECENT CONVERSATIONS\nOUT: already answered\n${reminder}\n`);
  assert.equal(message.split(reminder).length - 1, 1);
});
test('startup SessionStart preserves injection without the answered-message reminder', async t => {
  const { env } = fixture(t);
  let source;
  const result = await handleAgyHook({ conversationId: 'session',
    lastUserInput: 'System startup trigger, not a user message. Continue with startup context.' }, {
    env, eventName: 'SessionStart', activity: () => null, health: () => null,
    instructions: () => 'full tail rules\n', orchestrate: async (payload, { writeSync }) => {
      source = payload.source;
      const buffer = Buffer.from('RECENT CONVERSATIONS\nOUT: already answered');
      writeSync(1, buffer, 0, buffer.length);
    },
  });
  assert.equal(source, 'startup');
  assert.equal(result.injectSteps[0].systemMessage.systemMessage,
    'full tail rules\nRECENT CONVERSATIONS\nOUT: already answered');
});
test('ERROR stops persist identity-bound unhealthy evidence without native error text',t=>{
  const {root,env}=fixture(t),now=10000;
  const native={conversationId:'session',terminationReason:'ERROR',error:'sensitive native text'};
  const event=collectHealthHook(normalizeAgyHook(native,'Stop'),{zylosDir:root,env,nowMs:now,pid:123});
  assert.equal(event.runtime,'agy');assert.equal(event.error,'server_error');
  const store=new HealthStore({runtime:'agy',zylosDir:root,now:()=>now});
  const result=store.consume(event,{identity:{runtime:'agy',session_id:'session',claude_pid:123}});
  assert.equal(result.status,'processed');assert.equal(store.read().health,'unavailable');
  assert.equal(JSON.stringify(store.read()).includes('sensitive native text'),false);
});
test('ERROR stops classify explicit key rejection as auth failure without persisting native text', t => {
  const {root,env}=fixture(t),now=10000;
  for (const error of ['HTTP 401', 'HTTP/1.1 403', 'Request failed with status code 403',
    '[403 Forbidden] rejected request', '401 Unauthorized', 'API key not valid. Please pass a valid API key.',
    'API_KEY_INVALID', 'Invalid API key', 'API key was rejected']) {
    const event=collectHealthHook(normalizeAgyHook({conversationId:'session',terminationReason:'ERROR',
      error: error + ' private-native-key'},'Stop'),{zylosDir:root,env,nowMs:now,pid:123});
    assert.equal(event.error,'authentication_failed',error);
    const store=new HealthStore({runtime:'agy',zylosDir:root,now:()=>now});
    store.consume(event,{identity:{runtime:'agy',session_id:'session',claude_pid:123}});
    assert.equal(store.read().health,'auth_failed',error);
  }
  assert.equal(fs.readFileSync(path.join(root,'activity-monitor/session-groups/origin/events.jsonl'),'utf8').includes('private-native-key'),false);
});
test('ERROR stops keep network, server and ambiguous failures separate from authentication', () => {
  for (const error of [undefined, {}, 403, 'upstream HTTP 503', 'Connection reset', 'request 403 bytes failed',
    'API key lookup timed out', 'HTTP 4010', 'invalid model']) {
    assert.equal(normalizeAgyHook({conversationId:'session',terminationReason:'ERROR',error},'Stop').error,'server_error',String(error));
  }
});
test('AGY statusLine carries native context and ignores its invalid transcript path',t=>{
  const {env}=fixture(t);
  const sample=publishContextSample({conversationId:'session',agent_state:'idle',transcript_path:'/nonexistent/desktop',context_window:{used_percentage:20,context_window_size:1048576}},{env,now:1000});
  assert.equal(sample.session_id,'session');assert.equal('transcript_path' in sample,false);
  assert.equal(usageModelFacts(sample,'agy',{runtime:'agy',mode:'default'}).contextWindow,1048576);
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
test('Esc idle fallback validates run/session and background work can resume',t=>{
  const {dir}=fixture(t),activity=new SessionActivity({runDir:dir,runId:'run',sessionId:'session',runtime:'agy',startedAt:100});
  t.after(()=>activity.close());
  activity.consume([{event:'prompt',ts:200,runtime:'agy',run_id:'run',session_id:'session'}]);
  const write=(state,capturedAt,more={})=>fs.writeFileSync(path.join(dir,'statusline.json'),JSON.stringify({session_id:'session',agent_state:state,zylos:{v:1,runId:'run',capturedAt},...more}));
  write('idle',1000,{session_id:'other'});assert.equal(activity.read(2000).state,'busy');
  write('idle',2100,{task_count:1});assert.equal(activity.read(3000).state,'busy');
  write('idle',3100);assert.equal(activity.read(3300).state,'busy');assert.equal(activity.read(3600).state,'idle');
  write('working',4000);assert.equal(activity.read(4100).state,'busy');
});

test('startup emits every declared shard before publishing readiness',async t=>{
  const {env}=fixture(t), chunks=[];let readyOutput;
  const chain=['identity','custom','component'].map((name,chainIndex)=>({name,chainIndex,emit:async()=>name+' marker'}));
  await runAgySessionStart({session_id:'session',source:'startup'}, {env,chainBuilder:()=>({chain}),foreground:()=>{},ready:()=>{readyOutput=Buffer.concat(chunks).toString('utf8');},
    stdout:{fd:1},writeSync:(_fd,buffer,offset,length)=>{chunks.push(Buffer.from(buffer.subarray(offset,offset+length)));return length;}});
  assert.match(readyOutput,/\[2\/3\] custom/);assert.match(readyOutput,/component marker/);
  assert.ok(readyOutput.indexOf('identity marker')<readyOutput.indexOf('custom marker'));
});
test('startup capture preserves multibyte bytes across short writes',async t=>{
  const {env}=fixture(t);
  const result=await handleAgyHook({conversationId:'session',lastUserInput:'System startup trigger, not a user message. Continue with startup context.'}, {env,eventName:'SessionStart',activity:()=>null,health:()=>null,instructions:()=>'',
    orchestrate:async(_payload,{writeSync})=>{const bytes=Buffer.from('中');for(let offset=0;offset<bytes.length;offset++)writeSync(1,bytes,offset,1);}});
  assert.equal(result.injectSteps[0].systemMessage.systemMessage,'中');
});
test('clear marker rejects a different run and consumes malformed input',t=>{
  const {dir,env}=fixture(t),file=path.join(dir,'agy-session-source');
  for(const content of [JSON.stringify({runId:'old',source:'clear'}),'invalid']) {
    fs.writeFileSync(file,content);assert.equal(readAgySessionSource(env),'startup');assert.equal(fs.existsSync(file),false);
  }
  assert.equal(readAgySessionSource(env),'startup');
});
