import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HealthStore, HEALTH_GROUP_IDLE_MS } from '../health-store.js';
import { processFirstFailureNotices } from '../../../comm-bridge/scripts/first-failure-notice.js';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'health-retention-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let clock=1792000000000, freezes=0;
  const identity={runtime:'claude',session_id:'current-session',claude_pid:123};
  const store=new HealthStore({zylosDir:root,now:()=>clock,freezeNotice:({event})=>{
    freezes++;
    return {event_id:event.event_id,runtime:'claude',session_id:identity.session_id,claude_pid:123,
      conversation_id:1,channel:'test',endpoint:'room',health:'unavailable',reason:'overloaded',
      error:'overloaded',notice:{noticeCode:'service_error'},status:'pending',created_at:clock};
  }});
  const event=()=>({schema_version:1,event_id:randomUUID(),source:'hook',runtime:'claude',
    session_id:identity.session_id,prompt_id:'prompt',event:'stop_failure',received_at:clock,claude_pid:123,error:'overloaded'});
  return {root,store,identity,event,advance:ms=>clock+=ms,now:()=>clock,freezes:()=>freezes};
}

test('idle cleanup protects live, queued, recent and unfinished notification groups',async t=>{
  const f=fixture(t),s=f.store.read(),old=f.now()-HEALTH_GROUP_IDLE_MS;
  for(const group of ['idle','active','queued','pending','sending','recent','outcome','origin'])
    s.groups[group]={last_processed:{received_at:old,event_id:group}};
  s.groups.pending.pending_notice={event_id:'pending',status:'pending'};
  s.groups.sending.pending_notice={event_id:'sending',status:'sending'};
  s.groups.recent.last_processed.received_at=old+1;
  s.groups.outcome.last_notice_outcome={event_id:'old',status:'sent',observed_at:f.now()};
  f.store.write(s);
  assert.equal(await f.store.pruneGroups({activeGroups:new Set(['active','queued'])}),1);
  const groups=f.store.read().groups;
  assert.equal(Object.hasOwn(groups,'idle'),false);
  for(const group of ['active','queued','pending','sending','recent','outcome','origin'])assert.ok(groups[group],group);
  assert.equal(groups.sending.pending_notice.status,'sending');
});

test('deleted group cleanup removes terminal evidence while preserving pending notification state',async t=>{
  const f=fixture(t),event=f.event();f.store.consume(event,{identity:f.identity,sessionGroup:'chat:deleted'});
  assert.equal(await f.store.pruneGroups({isDeleted:async()=>true}),0);
  assert.equal(f.store.read('chat:deleted').pending_notice.event_id,event.event_id);
  f.store.updatePending(event.event_id,{status:'sent'},'chat:deleted');
  assert.equal(await f.store.pruneGroups({isDeleted:async()=>true}),1);
  const reopened=new HealthStore({zylosDir:f.root,now:f.now});
  assert.equal(Object.hasOwn(reopened.read().groups,'chat:deleted'),false);
});

test('pruned group revival rejects old failure and sends a new valid failure once',async t=>{
  const f=fixture(t),group='chat:revived',old=f.event();
  f.store.consume(old,{identity:f.identity,sessionGroup:group});
  f.store.updatePending(old.event_id,{status:'sent'},group);
  f.advance(HEALTH_GROUP_IDLE_MS);
  assert.equal(await f.store.pruneGroups(),1);
  f.store=new HealthStore({zylosDir:f.root,now:f.now,freezeNotice:f.store.freezeNotice});
  const stale=f.store.consume(old,{identity:f.identity,sessionGroup:group});
  assert.equal(stale.reason,'stale_event');assert.equal(f.freezes(),1);
  const fresh=f.event();f.store.consume(fresh,{identity:f.identity,sessionGroup:group});
  assert.equal(f.freezes(),2);
  let sends=0;
  const options={store:f.store,sessionGroup:group,identity:async()=>f.identity,now:f.now,
    database:{prepare:()=>({get:()=>({status:'delivered',session_group:group})})},
    reserve:()=>({suppressed:false}),send:async()=>{sends++;return {outcome:'sent'};}};
  assert.equal(await processFirstFailureNotices(options),1);
  assert.equal(await processFirstFailureNotices(options),0);
  assert.equal(f.store.consume(fresh,{identity:f.identity,sessionGroup:group}).reason,'replay');
  assert.equal(sends,1);assert.equal(f.freezes(),2);
  assert.equal(f.store.read(group).last_notice_outcome.status,'sent');
});

test('cache reads file once and successful writes immediately update every group view',t=>{
  const f=fixture(t),state=f.store.read();state.groups['chat:a']={last_processed:{received_at:1,event_id:'a'}};f.store.write(state);
  const store=new HealthStore({zylosDir:f.root,now:f.now});
  let reads=0;const read=fs.readFileSync;
  t.mock.method(fs,'readFileSync',function(file,...args){if(file===store.file)reads++;return read.call(this,file,...args);});
  for(let i=0;i<30;i++)assert.equal(store.read('chat:a').last_processed.event_id,'a');
  assert.equal(reads,1);
  const selected=store.read('chat:a');selected.last_processed={received_at:2,event_id:'b'};store.write(selected,'chat:a');
  assert.equal(store.read().groups['chat:a'].last_processed.event_id,'b');assert.equal(reads,1);
  const isolated=store.read();isolated.groups['chat:a'].last_processed.event_id='mutated';
  assert.equal(store.read('chat:a').last_processed.event_id,'b');
});

test('cache detects external atomic replacements and still quarantines corrupt files',t=>{
  const f=fixture(t),state=f.store.read();f.store.write(state);f.store.read();
  const replacement=f.store.file+'.replacement',raw=JSON.parse(fs.readFileSync(f.store.file,'utf8'));
  raw.hook.groups['chat:new']={lastProcessedAt:42,lastProcessedEventId:'external'};
  fs.writeFileSync(replacement,JSON.stringify(raw));fs.renameSync(replacement,f.store.file);
  assert.equal(f.store.read('chat:new').last_processed.event_id,'external');
  fs.writeFileSync(f.store.file,'broken');assert.equal(f.store.read().health,'ok');
  assert.equal(fs.existsSync(f.store.file),false);
  assert.equal(fs.readdirSync(path.dirname(f.store.file)).filter(name=>name.includes('.corrupt-')).length,1);
});

test('in-flight send survives cleanup and persists its terminal outcome',async t=>{
  const f=fixture(t),group='chat:sending',event=f.event();
  f.store.consume(event,{identity:f.identity,sessionGroup:group});
  let release,started;
  const sending=new Promise(resolve=>{started=resolve;});
  const result=processFirstFailureNotices({store:f.store,sessionGroup:group,identity:async()=>f.identity,now:f.now,
    database:{prepare:()=>({get:()=>({status:'delivered',session_group:group})})},
    reserve:()=>({suppressed:false}),send:()=>{started();return new Promise(resolve=>{release=resolve;});}});
  await sending;
  try {
    assert.equal(f.store.read(group).pending_notice.status,'sending');
    f.advance(HEALTH_GROUP_IDLE_MS);
    assert.equal(await f.store.pruneGroups({isDeleted:async()=>true}),0);
  } finally {release({outcome:'sent'});await result;}
  assert.equal(f.store.read(group).last_notice_outcome.status,'sent');
  assert.equal(await f.store.pruneGroups({isDeleted:async()=>true}),1);
});

test('cache preserves durable publication and does not adopt a failed write',t=>{
  const f=fixture(t),state=f.store.read();f.store.write(state);
  const fsync=fs.fsyncSync,rename=fs.renameSync;
  let syncs=0;
  t.mock.method(fs,'fsyncSync',function(...args){syncs++;return fsync.apply(this,args);});
  f.store.write({...state,revision:1});const first=syncs;
  assert.ok(first>0);f.store.write({...state,revision:2});assert.equal(syncs,first*2);
  t.mock.method(fs,'renameSync',function(from,to){if(to===f.store.file)throw Object.assign(new Error('fixture rename failed'),{code:'EIO'});return rename.call(this,from,to);});
  assert.throws(()=>f.store.write({...state,revision:3}),/fixture rename failed/);
  assert.equal(f.store.read().revision,2);
  assert.equal(JSON.parse(fs.readFileSync(f.store.file,'utf8')).hook.revision,2);
});
