import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HealthStore, HEALTH_GROUP_IDLE_MS } from '../health-store.js';

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
  for(const group of ['idle','active','queued','pending','sending','recent','outcome'])
    s.groups[group]={last_processed:{received_at:old,event_id:group}};
  s.groups.pending.pending_notice={event_id:'pending',status:'pending'};
  s.groups.sending.pending_notice={event_id:'sending',status:'sending'};
  s.groups.recent.last_processed.received_at=old+1;
  s.groups.outcome.last_notice_outcome={event_id:'old',status:'sent',observed_at:f.now()};
  f.store.write(s);
  assert.equal(await f.store.pruneGroups({activeGroups:new Set(['active','queued'])}),1);
  const groups=f.store.read().groups;
  assert.equal(Object.hasOwn(groups,'idle'),false);
  for(const group of ['active','queued','pending','sending','recent','outcome'])assert.ok(groups[group],group);
  assert.equal(groups.sending.pending_notice.status,'sending');
});

