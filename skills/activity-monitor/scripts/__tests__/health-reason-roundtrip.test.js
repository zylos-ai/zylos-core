import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
