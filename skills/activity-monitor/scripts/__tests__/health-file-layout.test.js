import { getRuntime } from '../../../../cli/lib/runtime/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HealthStore } from '../health-store.js';

const hookHealth = (await getRuntime('claude')).health.hookHealth;

const identity={runtime:'claude',session_id:'session',claude_pid:123};
const event={schema_version:1,source:'hook',...identity,event_id:'11111111-1111-1111-1111-111111111111',
  prompt_id:'prompt',event:'stop_failure',error:'rate_limit',received_at:100000};
const pendingFields=['eventId','conversationId','channel','endpoint','health','reason','notice','createdAt'].sort();
const topFields=['v','runtime','health','reason','cooldownUntil','rateLimitResetTime','unavailableSince',
  'recoveringStartedAt','restartFailureCount','lastRecoveryAt','lastDownCheckAt','lastUserMessageRecoveryAt',
  'updatedAt','hook','rateLimitActive'].sort();

function fixture(t,{runtime='claude',...options}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'health-layout-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const warnings=[];
  const store=new HealthStore({runtime,zylosDir:root,now:()=>100000,log:message=>warnings.push(message),
    freezeNotice:({event:input})=>({event_id:input.event_id,...identity,conversation_id:12,
      channel:'fake',endpoint:'group|thread:t|msg:12',health:'rate_limited',reason:'rate_limit_unclassified',
      error:'rate_limit',notice:{eligible:true,noticeCode:'rate_limited'},created_at:input.received_at,status:'pending'}),...options});
  return {root,store,warnings,file:path.join(root,'activity-monitor/runtime-health',runtime+'.json')};
}
function disk(f) {return JSON.parse(fs.readFileSync(f.file,'utf8'));}
function camelKeys(value) {
  if(!value||typeof value!=='object')return;
  for(const [key,child] of Object.entries(value)) {assert.ok(!key.includes('_'),'disk key '+key);camelKeys(child);}
}
function consume(f) {assert.equal(f.store.consume(event,{hookHealth, identity}).status,'processed');}

test('disk has exact engine fields, nested camelCase evidence and exact pending shape',t=>{
  const f=fixture(t);consume(f);
  const evidence=f.store.read();
  evidence.outage_quota={evidence_id:event.event_id,snapshot:{schema_version:1,source:'statusline',...identity,
    observed_at:100000,rate_limits:{five_hour:{used_percentage:100,resets_at:500}}}};
  evidence.recovered={session_id:identity.session_id,evidence_id:event.event_id,screen_fingerprint:'screen',revision:1};
  f.store.write(evidence);
  const scheduling={cooldownUntil:321,rateLimitResetTime:'tomorrow',unavailableSince:12,
    recoveringStartedAt:13,restartFailureCount:2,lastRecoveryAt:14,lastDownCheckAt:15,lastUserMessageRecoveryAt:16};
  assert.equal(f.store.saveScheduling(scheduling,f.store.read().revision),true);
  const raw=disk(f);
  assert.deepEqual(Object.keys(raw).filter(key=>key!=='pendingNotice').sort(),topFields);
  assert.deepEqual(Object.keys(raw.hook.groups.origin.pendingNotice).sort(),pendingFields);
  assert.equal(raw.v,1);assert.equal(raw.runtime,'claude');assert.equal(raw.updatedAt,100000);
  for(const [key,value] of Object.entries(scheduling))assert.equal(raw[key],value,key);
  assert.equal(raw.hook.groups.origin.lastProcessedAt,100000);assert.equal(raw.hook.groups.origin.lastProcessedEventId,event.event_id);
  assert.deepEqual(raw.hook.lastFailure,{eventId:event.event_id,error:'rate_limit',observedAt:100000});
  assert.equal(raw.hook.pid,123);assert.equal(raw.hook.processStart,undefined);
  assert.equal(raw.hook.groups.origin.pendingNotice.conversationId,12);assert.equal(raw.hook.groups.origin.pendingNotice.createdAt,100000);
  camelKeys(raw);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)),['claude.json']);
  const reopened=new HealthStore({zylosDir:f.root,now:()=>100000});
  assert.equal(reopened.read().pending_notice.status,'pending');
  assert.equal(reopened.read().pending_notice.claude_pid,identity.claude_pid);
  assert.deepEqual(reopened.read().scheduling,scheduling);
  assert.deepEqual(reopened.read().outage_quota,evidence.outage_quota);
  assert.deepEqual(reopened.read().recovered,evidence.recovered);
  assert.equal(reopened.consume(event,{identity}).reason,'replay');
});

for(const mode of ['json'])test('invalid '+mode+' is quarantined and warned before ok fallback',t=>{
  const f=fixture(t);consume(f);
  const original=mode==='json'?'{broken':JSON.stringify({...disk(f),...(mode==='version'?{v:2}:{runtime:'codex'})});
  fs.writeFileSync(f.file,original);
  assert.equal(f.store.read().health,'ok');assert.equal(f.store.read().reason,'');
  const files=fs.readdirSync(path.dirname(f.file));
  const quarantined=files.find(name=>/^claude\.json\.corrupt-\d+$/.test(name));
  assert.ok(quarantined);assert.equal(fs.readFileSync(path.join(path.dirname(f.file),quarantined),'utf8'),original);
  assert.equal(f.warnings.length,1);
});

