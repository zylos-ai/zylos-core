import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HealthStore } from '../health-store.js';

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
function consume(f) {assert.equal(f.store.consume(event,{identity}).status,'processed');}

test('missing health file always starts ok regardless of old projected health',t=>{
  const f=fixture(t,{initialHealth:'rate_limited',initialReason:'rate_limit_five_hour'});
  assert.equal(f.store.read().health,'ok');assert.equal(f.store.read().reason,'');
  assert.equal(fs.existsSync(f.file),false);
});

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

for(const mode of ['json','version','runtime'])test('invalid '+mode+' is quarantined and warned before ok fallback',t=>{
  const f=fixture(t);consume(f);
  const original=mode==='json'?'{broken':JSON.stringify({...disk(f),...(mode==='version'?{v:2}:{runtime:'codex'})});
  fs.writeFileSync(f.file,original);
  assert.equal(f.store.read().health,'ok');assert.equal(f.store.read().reason,'');
  const files=fs.readdirSync(path.dirname(f.file));
  const quarantined=files.find(name=>/^claude\.json\.corrupt-\d+$/.test(name));
  assert.ok(quarantined);assert.equal(fs.readFileSync(path.join(path.dirname(f.file),quarantined),'utf8'),original);
  assert.equal(f.warnings.length,1);
});

for(const field of ['lastProcessedAt','revision','episode'])test('malformed hook '+field+' is quarantined without losing original bytes',t=>{
  for(const value of ['invalid',-1,1.5]) {
    const f=fixture(t);consume(f);
    const raw=disk(f);(field === 'lastProcessedAt' ? raw.hook.groups.origin : raw.hook)[field]=value;
    const original=JSON.stringify(raw);fs.writeFileSync(f.file,original);
    const state=f.store.read();
    assert.equal(state.health,'ok');assert.equal(state.reason,'');
    assert.equal(state.pending_notice,undefined);assert.equal(state.last_processed,undefined);
    assert.equal(fs.existsSync(f.file),false);
    const backups=fs.readdirSync(path.dirname(f.file)).filter(name=>/^claude\.json\.corrupt-\d+$/.test(name));
    assert.equal(backups.length,1);
    assert.equal(fs.readFileSync(path.join(path.dirname(f.file),backups[0]),'utf8'),original);
    assert.equal(f.warnings.length,1);
  }
});

test('two corrupt files at the same millisecond preserve both quarantined originals',t=>{
  const f=fixture(t);consume(f);
  fs.writeFileSync(f.file,'{first-corrupt');assert.equal(f.store.read().health,'ok');
  const first=path.join(path.dirname(f.file),'claude.json.corrupt-100000');
  assert.equal(fs.readFileSync(first,'utf8'),'{first-corrupt');
  fs.writeFileSync(f.file,'{second-corrupt');assert.equal(f.store.read().health,'ok');
  assert.equal(fs.readFileSync(first,'utf8'),'{first-corrupt');
  assert.equal(fs.readFileSync(path.join(path.dirname(f.file),'claude.json.corrupt-100001'),'utf8'),'{second-corrupt');
  assert.equal(f.warnings.length,2);assert.equal(fs.existsSync(f.file),false);
});

for(const status of ['sent','failed','uncertain','suppressed','stale'])test('terminal '+status+' clears pending and records outcome together',t=>{
  const f=fixture(t);consume(f);
  assert.equal(f.store.updatePending(event.event_id,{status,updated_at:100001}),true);
  const raw=disk(f);assert.equal(raw.hook.groups.origin.pendingNotice,undefined);assert.equal(raw.hook.groups.origin.pendingAttempt,undefined);
  assert.equal(raw.hook.groups.origin.lastNoticeOutcome.status,status);camelKeys(raw);
  const restored=new HealthStore({zylosDir:f.root});
  assert.equal(restored.read().pending_notice,undefined);assert.equal(restored.read().last_notice_outcome.status,status);
});

test('sending marker is outside pending payload and restart records uncertain without replay',t=>{
  const f=fixture(t);consume(f);
  f.store.updatePending(event.event_id,{status:'sending',updated_at:100001});
  assert.deepEqual(Object.keys(disk(f).hook.groups.origin.pendingNotice).sort(),pendingFields);
  assert.ok(disk(f).hook.groups.origin.pendingAttempt);camelKeys(disk(f));
  const restarted=new HealthStore({zylosDir:f.root}).read();
  assert.equal(restarted.pending_notice,undefined);
  assert.equal(restarted.last_notice_outcome.status,'uncertain');
  assert.equal(disk(f).hook.groups.origin.pendingNotice,undefined);
});

test('old send outcome cannot clear a newer pending event',t=>{
  const f=fixture(t);consume(f);
  const state=f.store.read();
  state.pending_notice.event_id='22222222-2222-2222-2222-222222222222';
  f.store.write(state);
  const before=fs.readFileSync(f.file,'utf8');
  assert.equal(f.store.updatePending(event.event_id,{status:'sent',updated_at:100001}),false);
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
});

test('runtime files remain independent and self-identifying',t=>{
  const f=fixture(t);f.store.write(f.store.read());
  const other=new HealthStore({runtime:'codex',zylosDir:f.root,now:()=>100000});other.write(other.read());
  assert.equal(disk(f).runtime,'claude');
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(f.file),'codex.json'),'utf8')).runtime,'codex');
});
