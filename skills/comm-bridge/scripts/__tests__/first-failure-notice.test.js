import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { guardDatabase } from '../sqlite-schema.js';
import * as schema from '../c4-schema.js';
import { beginRuntimeDelivery, finishRuntimeDelivery, readDeliveryIdentity } from '../runtime-delivery.js';
import { enqueueFirstFailureNotice, processFirstFailureNotices, cleanupFailureNoticeHistory } from '../first-failure-notice.js';
import { claimStatusNotice, startStatusNotice, finishStatusNotice } from '../c4-db.js';
import { statusNoticeKey, normalizeStatusEndpoint } from '../status-notice.js';
import { classifyHealthNotice } from '../../../activity-monitor/scripts/health-notice-classification.js';

const identity = { runtime:'claude', runtime_generation:'generation', session_id:'session', process_start:'process', claude_pid:123 };
test('delivery identity requires current generation, process incarnation and tmux ancestry', () => {
  const options={generationReader:()=>identity,processStart:()=>'process',run:()=> '100',
    read:file=>file.endsWith('foreground-session.json')?JSON.stringify(identity):'123 (claude) S 100 0 0'};
  assert.equal(readDeliveryIdentity(options).session_id,'session');
  assert.equal(readDeliveryIdentity({...options,processStart:()=>'reused-pid'}),null);
  assert.equal(readDeliveryIdentity({...options,generationReader:()=>({...identity,runtime_generation:'new'})}),null);
  assert.equal(readDeliveryIdentity({...options,generationReader:()=>({...identity,runtime:'codex'})}),null);
  assert.equal(readDeliveryIdentity({...options,run:()=> '999'}),null);
  assert.equal(readDeliveryIdentity({...options,run:()=>{throw Error('tmux gone');}}),null);
});
function fixture(t, file = ':memory:') {
  const db = new Database(file); guardDatabase(db,schema);
  t.after(() => db.close());
  return db;
}
function delivery(db, id, { status = 'submitted', started = 100, submitted = 110, scope = identity,
  endpoint = `group|root:r|thread:t|msg:${id}`, channel = 'fake' } = {}) {
  db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status) VALUES (?,'in',?,?,'private user text','running')")
    .run(id,channel,endpoint);
  const item = { id,type:'conversation',channel,endpoint_id:endpoint };
  const record = beginRuntimeDelivery(item,scope,{ database:db,now:started });
  if (status !== 'submitting') finishRuntimeDelivery(record,item,status,scope,{ database:db,now:submitted });
  return { item,record };
}
function enqueue(db, { id = 'event', at = 150, scope = identity, reason = 'hook_failure', error = 'rate_limit', verify = false,
  state = {health:'rate_limited',episode:1} } = {}) {
  const event = { event_id:id,event:'stop_failure',runtime_generation:scope.runtime_generation,
    session_id:scope.session_id,process_start:scope.process_start,received_at:at,error };
  return enqueueFirstFailureNotice(db,{ runtime:'claude',state,identity:scope,event,
    result:{ status:'processed',reason,verify,notice:classifyHealthNotice(event,at) } });
}
function processor(db, { scope = identity, now = 200000, outcome = 'sent', sent = [] } = {}) {
  let sequence = 0;
  return { database:db,identity:() => scope,now:() => now,
    reserve(channel,endpoint,route) {
      return claimStatusNotice({ key:statusNoticeKey(channel,endpoint),episode:route.healthEpisode,attemptId:`attempt-${++sequence}`,
        channel,endpoint,normalizedEndpoint:normalizeStatusEndpoint(endpoint),now:Math.floor(now/1000) },db);
    },
    send(claim,message,route) {
      sent.push({claim,message,route});
      startStatusNotice(claim,Math.floor(now/1000),db);
      finishStatusNotice(claim,outcome,{now:Math.floor(now/1000)},db);
      return {outcome};
    },
  };
}

test('B targets latest dispatcher submission, never receive-only delivered bookkeeping', t => {
  const db = fixture(t);
  delivery(db,1); delivery(db,2,{ started:120,submitted:130 });
  db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status) VALUES (3,'in','fake','wrong','rejected','delivered')").run();
  assert.equal(enqueue(db),true);
  assert.equal(enqueue(db),false);
  const row = db.prepare('SELECT * FROM runtime_notice_intents').get();
  assert.equal(row.conversation_id,2);
  assert.equal(row.endpoint,'group|root:r|thread:t|msg:2');
  assert.doesNotMatch(JSON.stringify(row),/private user text|rejected/);
  delivery(db,4,{ started:160,submitted:170 });
  const sent=[]; processFirstFailureNotices(processor(db,{sent}));
  assert.equal(sent.length,1); assert.equal(sent[0].claim.endpoint,row.endpoint);
  assert.equal(sent[0].route.context,'failure');
});

test('newer uncertain submission blocks fallback to older target', t => {
  const db = fixture(t); delivery(db,1);
  delivery(db,2,{ started:120,submitted:160,status:'verify_failed' });
  assert.equal(enqueue(db),false);
});

test('fast failure freezes exact in-flight candidate until verified, never retargeting newer delivery', t => {
  const db=fixture(t);delivery(db,1);
  const {item,record}=delivery(db,2,{started:120,status:'submitting'});
  assert.equal(enqueue(db),true);
  const sent=[];processFirstFailureNotices(processor(db,{sent,now:200}));
  assert.equal(sent.length,0);
  assert.equal(db.prepare('SELECT status FROM runtime_notice_intents').get().status,'pending');
  finishRuntimeDelivery(record,item,'submitted',identity,{database:db,now:250});
  delivery(db,3,{started:300,submitted:310});
  processFirstFailureNotices(processor(db,{sent,now:400}));
  assert.equal(sent.length,1);assert.match(sent[0].claim.endpoint,/msg:2$/);
});

test('in-flight delivery wait is bounded and unknown submission cannot send', t => {
  for (const outcome of ['verify_failed','submitting','submitted']) {
    const db=fixture(t);const {item,record}=delivery(db,1,{status:'submitting'});enqueue(db);
    if(outcome!=='submitting')finishRuntimeDelivery(record,item,outcome,identity,{database:db,now:70000});
    const sent=[];processFirstFailureNotices(processor(db,{sent,now:70001}));
    assert.equal(sent.length,0);
    assert.equal(db.prepare('SELECT status FROM runtime_notice_intents').get().status,'suppressed');
  }
});

test('bounded seven-day cleanup preserves pending target and latest current delivery', t => {
  const db=fixture(t);delivery(db,1);enqueue(db);delivery(db,2);delivery(db,3);
  enqueue(db,{id:'terminal'});db.prepare("UPDATE runtime_notice_intents SET status='sent' WHERE event_id='terminal'").run();
  cleanupFailureNoticeHistory(db,identity,8*86400000);
  assert.deepEqual(db.prepare('SELECT conversation_id FROM runtime_deliveries ORDER BY id').all().map(r=>r.conversation_id),[1,3]);
  assert.deepEqual(db.prepare('SELECT event_id FROM runtime_notice_intents').all().map(r=>r.event_id),['event']);
});

test('generation/session changes and ignored or unordered events cannot create targets', t => {
  const db=fixture(t); delivery(db,1);
  for (const scope of [{...identity,runtime_generation:'new'},{...identity,session_id:'new'},{...identity,process_start:'new'}])
    assert.equal(enqueue(db,{scope}),false);
  for (const reason of ['missing_prompt','unordered_failure','duplicate']) assert.equal(enqueue(db,{reason}),false);
  assert.equal(enqueue(db,{verify:true}),false);
  assert.equal(beginRuntimeDelivery({type:'control',id:5,channel:'fake',endpoint_id:'group'},identity,{database:db}),null);
  for (const channel of ['system','void','scheduler']) assert.equal(beginRuntimeDelivery({type:'conversation',id:5,channel,endpoint_id:'group'},identity,{database:db}),null);
});

test('submission identity changes cannot produce verified provenance', t => {
  const db=fixture(t);
  const {record,item}=delivery(db,1,{status:'submitting'});
  finishRuntimeDelivery(record,item,'submitted',{...identity,runtime_generation:'new'},{database:db,now:110});
  assert.equal(db.prepare('SELECT status FROM runtime_deliveries').get().status,'uncertain');
  assert.equal(enqueue(db),false);
});

test('unproven billing and nonquota terminal errors do not create new first replies', t => {
  for (const error of ['billing_error','server_error','unknown']) {
    const db=fixture(t);delivery(db,1);
    assert.equal(enqueue(db,{error,reason:error,state:{health:'ok',episode:1}}),false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM runtime_notice_intents').get().n,0);
  }
});

test('event and notice intent transaction rolls back together', t => {
  const db=fixture(t);delivery(db,1);
  assert.throws(() => db.transaction(() => { enqueue(db); throw Error('crash'); })(),/crash/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM runtime_notice_intents').get().n,0);
});

test('old-generation pending intent is stale and missing proof defers', t => {
  const db=fixture(t);delivery(db,1);enqueue(db);
  processFirstFailureNotices(processor(db,{scope:null}));
  assert.equal(db.prepare('SELECT status FROM runtime_notice_intents').get().status,'pending');
  processFirstFailureNotices(processor(db,{scope:{...identity,runtime_generation:'new'}}));
  assert.equal(db.prepare('SELECT status FROM runtime_notice_intents').get().status,'stale');
});

test('scope changes after claiming release the unsent claim; thrown sender stays uncertain', t => {
  for (const mode of ['scope','throw']) {
    const db=fixture(t);delivery(db,1);enqueue(db);
    const options=processor(db);let calls=0;
    if(mode==='scope')options.identity=()=>++calls===1?identity:{...identity,runtime_generation:'new'};
    options.send=()=>{throw Error('sender exception');};
    processFirstFailureNotices(options);
    assert.equal(db.prepare('SELECT status FROM runtime_notice_intents').get().status,mode==='scope'?'stale':'uncertain');
    assert.equal(db.prepare('SELECT status FROM status_notice_attempts').get().status,mode==='scope'?'failed':'uncertain');
  }
});

test('healthy terminal unknown send never replays same event; new event shares global success cooldown', t => {
  const db=fixture(t);delivery(db,1);enqueue(db,{state:{health:'ok',episode:1}});
  const sent=[];processFirstFailureNotices(processor(db,{sent,outcome:'uncertain'}));
  processFirstFailureNotices(processor(db,{sent,now:1000000}));
  assert.equal(sent.length,1);
  enqueue(db,{id:'event2',state:{health:'ok',episode:1}});processFirstFailureNotices(processor(db,{sent,now:1000000}));
  assert.equal(sent.length,2);
  enqueue(db,{id:'event3',state:{health:'ok',episode:1}});processFirstFailureNotices(processor(db,{sent,now:1001000}));
  assert.equal(sent.length,2);
});

test('uncertain first failure suppresses inbound notices across the same persistent outage', t => {
  const db=fixture(t);delivery(db,1);enqueue(db);
  const sent=[];processFirstFailureNotices(processor(db,{sent,outcome:'uncertain'}));
  const inbound=processor(db,{now:1000000});
  assert.equal(inbound.reserve('fake','group|root:r|thread:t|msg:new',{healthEpisode:'claude:1'}).reason,'uncertain');
  db.prepare('INSERT INTO runtime_health_state VALUES (?,?,?,?)').run('claude',1,JSON.stringify({health:'rate_limited',episode:1}),200000);
  cleanupFailureNoticeHistory(db,identity,8*86400000);
  assert.equal(inbound.reserve('fake','group|root:r|thread:t|msg:new',{healthEpisode:'claude:1'}).reason,'uncertain');
  assert.equal(inbound.reserve('fake','group|root:r|thread:t|msg:new',{healthEpisode:'claude:2'}).suppressed,false);
});

test('uncertain inbound notice suppresses first failure without starting a second send', t => {
  const db=fixture(t);delivery(db,1);
  const inbound=processor(db,{outcome:'uncertain'});
  const claim=inbound.reserve('fake','group|root:r|thread:t|msg:new',{healthEpisode:'claude:1'});
  inbound.send(claim,'inbound',{});
  enqueue(db);const sent=[];processFirstFailureNotices(processor(db,{sent,now:1000000}));
  assert.equal(sent.length,0);
  assert.equal(db.prepare('SELECT status FROM runtime_notice_intents').get().status,'uncertain');
});

function child(root, code) {
  return new Promise((resolve,reject) => {
    const proc=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,ZYLOS_DIR:root},stdio:['ignore','pipe','pipe']});
    let stderr='';proc.stderr.on('data',chunk=>stderr+=chunk);proc.once('error',reject);
    proc.once('exit',(code,signal)=>resolve({code,signal,stderr}));
  });
}

for (const mode of ['concurrent','crash_after_success']) test(`first-reply ${mode} never duplicates after restart`, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'first-failure-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'comm-bridge'));fs.mkdirSync(path.join(root,'.claude/skills/fake'),{recursive:true});
  const file=path.join(root,'comm-bridge/c4.db');
  const db=new Database(file);guardDatabase(db,schema);delivery(db,1);enqueue(db);db.close();
  const marker=path.join(root,'sent');
  const imports=`import fs from 'node:fs';import {processFirstFailureNotices} from ${JSON.stringify(new URL('../first-failure-notice.js',import.meta.url).href)};
    import {getDb,close,startStatusNotice,finishStatusNotice} from ${JSON.stringify(new URL('../c4-db.js',import.meta.url).href)};`;
  const code=imports+`processFirstFailureNotices({identity:()=>(${JSON.stringify(identity)}),send(claim){
    startStatusNotice(claim);fs.appendFileSync(${JSON.stringify(marker)},${JSON.stringify('send\n')});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);finishStatusNotice(claim,'sent');
    ${mode==='crash_after_success' ? "process.kill(process.pid,'SIGKILL');" : "return {outcome:'sent'};"}
    }});close();`;
  if(mode==='concurrent') {
    for(const result of await Promise.all([child(root,code),child(root,code)]))assert.equal(result.code,0,result.stderr);
  } else {
    assert.equal((await child(root,code)).signal,'SIGKILL');
    const restarted=await child(root,imports+`getDb().prepare('UPDATE status_notice_cooldowns SET expires_at=0').run();
      processFirstFailureNotices({identity:()=>(${JSON.stringify(identity)}),send(){throw Error('duplicate');}});close();`);
    assert.equal(restarted.code,0,restarted.stderr);
  }
  assert.equal(fs.readFileSync(marker,'utf8'),'send\n');
  const check=new Database(file);assert.equal(check.prepare('SELECT status FROM runtime_notice_intents').get().status,'sent');check.close();
});
