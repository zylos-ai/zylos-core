import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from '../../../comm-bridge/node_modules/better-sqlite3/lib/index.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../../comm-bridge/scripts/c4-schema.js';
import { reserveStatusNoticeCooldown } from '../../../comm-bridge/scripts/c4-db.js';
import { reserveStatusNotice } from '../../../comm-bridge/scripts/status-notice.js';
import { freezeFirstFailureNotice, processFirstFailureNotices } from '../../../comm-bridge/scripts/first-failure-notice.js';
import { HealthStore } from '../health-store.js';
import { RuntimeHealthCoordinator } from '../runtime-health.js';
import { publishSessionStatus } from '../status-writer.js';
function root(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'supervisor-reason-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const allowed=['rate_limit_unclassified','rate_limit_five_hour','rate_limit_seven_day','authentication_failed','billing_error','overloaded','server_error','model_not_found','hook_evidence_unordered','health_storage_unavailable'];
// health-reason-roundtrip: actual serialization, new owner and projection.
test('six persisted health states round-trip allowed, empty and unknown reasons through new owner and projection',t=>{
 const zylosDir=root(t);let cases=0;
 for(const health of ['ok','rate_limited','auth_failed','unavailable','recovering','down'])for(const reason of [...allowed,'','unknown private text',null]) {
  const store=new HealthStore({zylosDir});store.write({...store.read(),health,reason});
  const expected=health==='ok'?'':allowed.includes(reason)?reason:health==='rate_limited'?'rate_limit_unclassified':health==='auth_failed'?'authentication_failed':'runtime_unavailable';
  const owner=new RuntimeHealthCoordinator({zylosDir});const state=owner.store('claude').read();
  assert.equal(state.health,health);assert.equal(state.reason,expected);assert.equal(JSON.parse(fs.readFileSync(store.file)).reason,expected);
  const value=publishSessionStatus({statusFile:path.join(zylosDir,'status.json'),scene:{ready:true,runId:'r',sessionId:'s',runtime:'claude'},activity:{sessionId:'s',state:'idle',lastActivityAt:1,tools:[]},health:state,now:10});
  assert.equal(value.health,['ok','rate_limited','auth_failed'].includes(health)?health:'unavailable');assert.equal(value.unavailable_reason,health==='ok'?undefined:expected);cases++;
 }
 assert.equal(cases,78);
});
test('recovery clears current reason while frozen historical notice keeps original target and sending semantics; recursive-clear mutant detected',async t=>{
 const zylosDir=root(t),database=new Database(':memory:');guardDatabase(database,schema);t.after(()=>database.close());
 database.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status) VALUES('in','fake','original','test','delivered')").run();
 let now=1000000;const identity={runtime:'claude',session_id:'s',claude_pid:123};
 const store=new HealthStore({zylosDir,now:()=>now,freezeNotice:input=>freezeFirstFailureNotice(database,{...input,sessionGroup:null})});
 const event={schema_version:1,source:'hook',runtime:'claude',event_id:randomUUID(),session_id:'s',claude_pid:123,prompt_id:'p',event:'stop_failure',error:'authentication_failed',received_at:now};
 store.consume(event,{identity});const failed=store.read();const pending=failed.pending_notice;
 now++;store.consume({...event,event_id:randomUUID(),event:'stop',error:null,received_at:now},{identity});assert.equal(store.read().health,'auth_failed');
 now++;store.transition('ok','authentication_failed',{identity,kind:'recovery'});
 const rebuilt=new HealthStore({zylosDir,now:()=>now});const recovered=rebuilt.read();
 const verify=state=>{assert.equal(state.health,'ok');assert.equal(state.reason,'');assert.deepEqual(state.hook_failure,failed.hook_failure);assert.equal(state.pending_notice.reason,pending.reason);assert.equal(state.pending_notice.endpoint,'original');};
 verify(recovered);
 const mutant=structuredClone(recovered);const clear=value=>{if(value&&typeof value==='object')for(const key of Object.keys(value)){if(key==='reason')value[key]='';else clear(value[key]);}};clear(mutant);assert.throws(()=>verify(mutant),assert.AssertionError);
 database.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status) VALUES('in','fake','newer','test','delivered')").run();
 fs.mkdirSync(path.join(process.env.ZYLOS_DIR,'.claude','skills','fake'),{recursive:true});
 const sent=[];await processFirstFailureNotices({store:rebuilt,database,identity:()=>identity,now:()=>now,zylosDir,
 reserve:(channel,endpoint,route)=>reserveStatusNotice(channel,endpoint,route,{reserve:options=>reserveStatusNoticeCooldown({...options,now:Math.floor(now/1000)},database)}),
 send:async(claim,message,route)=>{sent.push({claim,message,route});return {outcome:'sent'};}});
 assert.equal(sent.length,1);assert.equal(sent[0].claim.endpoint,'original');assert.equal(sent[0].route.reason,'authentication_failed');assert.equal(rebuilt.read().health,'ok');assert.equal(rebuilt.read().last_notice_outcome.status,'sent');
});
