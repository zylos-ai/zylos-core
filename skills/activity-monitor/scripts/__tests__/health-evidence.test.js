import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../../comm-bridge/node_modules/better-sqlite3/lib/index.js';
import {migrateHealthNotices} from '../../../comm-bridge/scripts/c4-health-migration.js';
import {HealthStore} from '../health-store.js';
import {HealthController} from '../health-controller.js';
import {HealthEngine} from '../health-engine.js';
import {quotaClassification} from '../health-evidence.js';

const generation='00000000-0000-4000-8000-000000000001';
const identity={runtime:'claude',runtime_generation:generation,session_id:'session',claude_pid:123,process_start:generation+':123'};
const now=1000000;
const event=(overrides={})=>({schema_version:1,event_id:'00000000-0000-4000-8000-000000000002',source:'hook',runtime:'claude',runtime_generation:generation,session_id:'session',prompt_id:'prompt',event:'stop_failure',error:'rate_limit',received_at:now,claude_pid:123,process_start:generation+':123',...overrides});
function fixture(){const db=new Database(':memory:');migrateHealthNotices(db);const store=new HealthStore(db,{now:()=>now});return {db,store,consume:e=>store.consume(e,{identity,fallbackId:'fixture'})};}

test('current Stop establishes Hook OK priority only against screen rate limits',()=>{
  const {db,store,consume}=fixture();
  assert.equal(consume(event({event:'stop',error:null})).reason,'hook_ok');
  assert.equal(store.transition('rate_limited','',{identity,kind:'screen'}).accepted,false);
  assert.equal(store.read().health,'ok');
  assert.equal(store.transition('auth_failed','',{identity,kind:'screen'}).accepted,true);
  db.close();
});
test('delayed Stop cannot erase a Hook failure and new generation does not inherit Hook priority',()=>{
  const {db,store,consume}=fixture();consume(event());
  const stop=event({event:'stop',event_id:'00000000-0000-4000-8000-000000000004',error:null});
  assert.equal(consume(stop).reason,'unproven_success_order');
  assert.equal(store.read().health,'rate_limited');
  assert.equal(store.transition('auth_failed','',{identity:{...identity,runtime_generation:'new'},kind:'screen'}).accepted,true);
  db.close();
});
test('stale foreign or unproven Stop cannot gain screen priority',()=>{
  for(const change of [{received_at:now-300001},{session_id:'foreign'},{process_start:null},{prompt_id:null}]) {
    const {db,store,consume}=fixture();consume(event({event:'stop',error:null,...change}));
    assert.equal(store.transition('rate_limited','',{identity,kind:'screen'}).accepted,true);db.close();
  }
});
test('identity hooks alone never establish successful response evidence',()=>{
  for(const type of ['session_start','prompt_submit']) {
    const {db,store,consume}=fixture();consume(event({event:type,error:null}));
    assert.equal(store.transition('rate_limited','',{identity,kind:'screen'}).accepted,true);db.close();
  }
});
test('last Hook status projects only sanitized current terminal evidence',()=>{
  const {db,store,consume}=fixture();consume(event({error:'billing_error',last_assistant_message:'SECRET'}));
  const hook=store.read().last_hook;
  assert.deepEqual(Object.keys(hook).sort(),['error','event','event_id','observed_at','runtime_generation']);
  assert.equal(hook.error,'billing_error');assert.equal(JSON.stringify(hook).includes('SECRET'),false);
  consume(event({session_id:'foreign',event_id:'00000000-0000-4000-8000-000000000008'}));
  assert.deepEqual(store.read().last_hook,hook);db.close();
});
test('retention preserves pending/current/future evidence and removes only expired processed rows',()=>{
  const {db,store,consume}=fixture();consume(event());
  const current=store.read().evidence_id;
  db.prepare('UPDATE runtime_health_events SET processed_at=?,received_at=?').run(now-400000,now-400000);
  const insert=db.prepare('INSERT INTO runtime_health_events(event_id,source,received_at,payload_json,status,processed_at) VALUES(?,?,?,?,?,?)');
  insert.run('old','screen',now-400000,'{}','processed',now-400000);
  insert.run('pending','hook',now-400000,'{}','pending',null);
  insert.run('future','hook',now+1,'{}','processed',now-400000);
  store.pruneEvents();
  assert.deepEqual(db.prepare('SELECT event_id FROM runtime_health_events ORDER BY event_id').all().map(x=>x.event_id),[current,'future','pending'].sort());db.close();
});

test('exact Hook classifications separate single failure from persistent health',()=>{
  for(const error of ['rate_limit','authentication_failed','billing_error','overloaded','server_error','model_not_found','rate_limit_error','authentication_error','unknown']){
    const {db,store,consume}=fixture();const result=consume(event({error}));
    assert.equal(store.read().health,error==='rate_limit'?'rate_limited':error==='authentication_failed'?'auth_failed':'ok');
    assert.equal(result.status,'processed');db.close();
  }
});
test('same terminal prompt/error deduplicates new event UUIDs and excludes raw diagnostics',()=>{
  const {db,store,consume}=fixture();consume(event({error_details:'SECRET',last_assistant_message:'SECRET'}));const revision=store.read().revision;
  assert.equal(consume(event({event_id:'00000000-0000-4000-8000-000000000003'})).reason,'duplicate');assert.equal(store.read().revision,revision);
  assert.equal(db.prepare('SELECT count(*) n FROM runtime_health_events').get().n,1);
  assert.ok(!db.prepare('SELECT payload_json FROM runtime_health_events').get().payload_json.includes('SECRET'));db.close();
});
test('bad schema foreign generation/session process reused PID and expiry never mutate health',()=>{
  const {db,store,consume}=fixture();
  for(const change of [{schema_version:2},{runtime_generation:'00000000-0000-4000-8000-000000000003'},{session_id:'old'},{process_start:generation+':99'},{received_at:now-300001},{received_at:now+1},{process_start:null}]){
    const result=consume(event({...change,prompt_id:'p'+JSON.stringify(change).length,event_id:'00000000-0000-4000-8000-000000000003'}));assert.equal(result.status,'ignored');assert.equal(store.read().health,'ok');
  }db.close();
});
test('valid Hook blocks unassociated screen, recovery watermark rejects delayed and unseen failures',()=>{
  const {db,store,consume}=fixture();consume(event());assert.equal(store.transition('auth_failed','x',{identity,kind:'screen'}).accepted,false);
  const prior=store.read();store.transition('ok','',{identity,kind:'recovery',expectedRevision:prior.revision,screenFingerprint:'old-screen'});
  const watermark=store.read().recovered;
  assert.equal(consume(event({prompt_id:'new-or-delayed'})).reason,'unordered_failure');assert.equal(store.read().health,'ok');assert.deepEqual(store.read().recovered,watermark);
  const reopened=new HealthStore(db,{now:()=>now});assert.deepEqual(reopened.read().recovered,watermark);db.close();
});
test('missing prompt is diagnostic-only and requests controlled verification',()=>{const {db,store,consume}=fixture();assert.equal(consume(event({prompt_id:null})).verify,true);assert.equal(store.read().health,'ok');db.close();});
test('SQLite rollback cannot commit health without consumed event',()=>{
  const {db,store,consume}=fixture();db.exec("CREATE TRIGGER fail_consumed BEFORE UPDATE ON runtime_health_events BEGIN SELECT RAISE(ABORT,'injected');END");
  assert.throws(()=>consume(event()),/injected/);assert.equal(store.read().health,'ok');assert.equal(db.prepare('SELECT count(*) n FROM runtime_health_events').get().n,0);db.close();
});
test('quota requires matching generation/session bounded freshness finite numeric percentage',()=>{
  const base={runtime_generation:generation,session_id:'session',observed_at:now,rate_limits:{five_hour:{used_percentage:100}}};
  assert.equal(quotaClassification(base,event(),now),'rate_limit_five_hour');
  for(const bad of [{...base,observed_at:now-60001},{...base,session_id:'old'},{...base,runtime_generation:'old'},{...base,rate_limits:{five_hour:{used_percentage:'100'}}},{...base,rate_limits:{five_hour:{used_percentage:101}}},{...base,rate_limits:{five_hour:{used_percentage:NaN}}},null])assert.equal(quotaClassification(bad,event(),now),'rate_limit_unclassified');
});
test('failed spool transaction retains event, successful commit ACK removes it',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'health-controller-'));const {db,store}=fixture();
  const inbox=path.join(dir,'activity-monitor','health-inbox');fs.mkdirSync(inbox,{recursive:true});const file=path.join(inbox,event().event_id+'.json');fs.writeFileSync(file,JSON.stringify(event()));
  const engine=new HealthEngine({log(){},readHeartbeatPending(){return null;}},{now:()=>now});const controller=new HealthController({store,engine,identity:()=>identity,zylosDir:dir});
  db.exec("CREATE TRIGGER fail_consumed BEFORE UPDATE ON runtime_health_events BEGIN SELECT RAISE(ABORT,'injected');END");controller.drain();assert.ok(fs.existsSync(file));assert.equal(engine.health,'ok');
  db.exec('DROP TRIGGER fail_consumed');controller.drain();assert.ok(!fs.existsSync(file));assert.equal(engine.health,'rate_limited');engine.destroy();db.close();fs.rmSync(dir,{recursive:true,force:true});
});
test('async auth check cannot overwrite newer Hook evidence',async()=>{
  const {db,store}=fixture();let finish;let kills=0;
  const engine=new HealthEngine({log(){},readHeartbeatPending(){return null;},detectAuthFailure:()=>({detected:true}),checkAuth:()=>new Promise(r=>{finish=r;}),killTmuxSession(){kills++;}},{userMessageCheckDelayMs:0,now:()=>now});
  const controller=new HealthController({store,engine,identity:()=>identity});const checking=engine.onUserMessageDelivered();
  controller.apply(store.consume(event(),{identity}).state);finish({status:'failure'});await checking;
  assert.equal(engine.health,'rate_limited');assert.equal(kills,0);engine.destroy();db.close();
});
test('pre-recovery screen fingerprint and obsolete probe are rejected',()=>{
  const {db,store}=fixture();let current=identity;
  const engine=new HealthEngine({log(){},readHeartbeatPending(){return null;},detectRateLimit:()=>({detected:true})},{now:()=>now});
  const controller=new HealthController({store,engine,identity:()=>current,fingerprint:()=> 'same-screen'});
  store.transition('ok','',{identity,kind:'recovery',screenFingerprint:'same-screen'});assert.equal(engine.deps.detectRateLimit().detected,false);
  const fence=controller.captureFence();current={...identity,runtime_generation:'00000000-0000-4000-8000-000000000009'};assert.equal(controller.validFence(fence),false);engine.destroy();db.close();
});
test('episode persists across reason and runtime changes; next confirmed outage increments',()=>{
  const {db,store,consume}=fixture();consume(event());const first=store.read().episode;
  store.transition('unavailable','',{identity,kind:'probe-failure'});assert.equal(store.read().episode,first);
  store.transition('ok','',{identity,kind:'recovery'});store.transition('unavailable','',{identity,kind:'probe-failure'});assert.equal(store.read().episode,first+1);db.close();
});
test('writer lease blocks overlapping owner; expired owner cannot commit a stale revision',()=>{
  const {db,store,consume}=fixture();consume(event());let clock=now;
  const other=new HealthStore(db,{now:()=>clock});
  assert.throws(()=>other.transition('ok','',{identity,kind:'recovery'}),/lease held/);
  const oldRevision=store.read().revision;clock+=30001;
  assert.equal(other.transition('ok','',{identity,kind:'recovery',expectedRevision:oldRevision}).accepted,true);
  assert.throws(()=>store.transition('auth_failed','',{identity,kind:'auth-probe',expectedRevision:oldRevision}),/lease held/);
  clock+=30001;
  const third=new HealthStore(db,{now:()=>clock});
  assert.equal(third.transition('auth_failed','',{identity,kind:'auth-probe',expectedRevision:oldRevision}).accepted,false);
  assert.equal(third.read().health,'ok');db.close();
});

test('screen and probe transitions journal decisions atomically with health',()=>{
  const {db,store,consume}=fixture();consume(event());
  assert.equal(store.transition('auth_failed','SECRET',{identity,kind:'screen'}).accepted,false);
  const ignored=db.prepare("SELECT * FROM runtime_health_events WHERE source='screen'").get();
  assert.equal(ignored.status,'ignored');assert.equal(ignored.reason,'hook_priority');
  assert.equal(ignored.payload_json.includes('SECRET'),false);
  db.exec("CREATE TRIGGER fail_journal BEFORE INSERT ON runtime_health_events WHEN NEW.source='recovery' BEGIN SELECT RAISE(ABORT,'injected');END");
  assert.throws(()=>store.transition('ok','',{identity,kind:'recovery'}),/injected/);
  assert.equal(store.read().health,'rate_limited');
  db.exec('DROP TRIGGER fail_journal');
  store.transition('ok','',{identity,kind:'recovery'});
  const accepted=db.prepare("SELECT * FROM runtime_health_events WHERE source='recovery'").get();
  assert.equal(accepted.status,'processed');assert.equal(store.read().evidence_id,accepted.event_id);db.close();
});

test('rejected screen cooldown cannot mutate Hook state or recovery counters',()=>{
  const {db,store,consume}=fixture();consume(event({error:'authentication_failed'}));
  const engine=new HealthEngine({log(){},readHeartbeatPending(){return null;}},{now:()=>now});
  new HealthController({store,engine,identity:()=>identity});engine.restartFailureCount=3;
  assert.equal(engine.enterRateLimited(2000,'later'),false);
  assert.equal(engine.health,'auth_failed');assert.equal(engine.cooldownUntil,0);
  assert.equal(engine.restartFailureCount,3);assert.equal(engine.cooldownTimer,null);engine.destroy();db.close();
});

test('current failed heartbeat can move Hook rate limit to unavailable',()=>{
  const {db,store,consume}=fixture();consume(event());
  const pending={control_id:'probe',phase:'recovery'};
  const engine=new HealthEngine({log(){},readHeartbeatPending:()=>pending,clearHeartbeatPending(){},detectRateLimit:()=>({detected:false})},{now:()=>now});
  const controller=new HealthController({store,engine,identity:()=>identity});
  engine.probeFences.set(pending.control_id,controller.captureFence());engine.onHeartbeatFailure(pending,'failed');
  assert.equal(engine.health,'unavailable');assert.equal(store.read().health,'unavailable');
  assert.equal(store.read().source,'probe-failure');engine.destroy();db.close();
});

test('monitor restart restores cooldown and backoff without invalidating probe revision',()=>{
  const {db,store}=fixture();
  const dependencies={log(){},readHeartbeatPending(){return null;}};
  const engine=new HealthEngine(dependencies,{now:()=>now});
  const controller=new HealthController({store,engine,identity:()=>identity});
  engine.enterRateLimited(1600);
  engine.restartFailureCount=3;engine.lastRecoveryAt=995;
  const revision=store.read().revision;controller.persistScheduling();
  assert.equal(store.read().revision,revision);engine.destroy();
  const restored=new HealthEngine(dependencies,{now:()=>now+100000});
  new HealthController({store:new HealthStore(db,{now:()=>now+100000}),engine:restored,identity:()=>identity});
  assert.equal(restored.health,'rate_limited');assert.equal(restored.cooldownUntil,1600);
  assert.equal(restored.restartFailureCount,3);assert.equal(restored.lastRecoveryAt,995);
  assert.equal(restored.getBackoffDelay(),1500);restored.destroy();db.close();
});

test('competing monitor cannot kill runtime while health writer lease is held',()=>{
  const {db,store}=fixture();store.transition('unavailable','',{identity,kind:'probe-failure'});
  let kills=0;
  const engine=new HealthEngine({log(){},readHeartbeatPending(){return null;},killTmuxSession(){kills++;}},{now:()=>now});
  new HealthController({store:new HealthStore(db,{now:()=>now}),engine,identity:()=>identity});
  assert.throws(()=>engine.triggerRecovery('retry'),/lease held/);assert.equal(kills,0);
  engine.destroy();db.close();
});

test('heartbeat Stop telemetry before its done receipt preserves the recovery fence',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'health-stop-recovery-'));
  const {db,store}=fixture();
  store.transition('unavailable','',{identity,kind:'probe-failure'});
  let pending={control_id:'heartbeat-recovery',phase:'recovery',created_at:now/1000};
  const engine=new HealthEngine({log(){},readHeartbeatPending:()=>pending,
    clearHeartbeatPending(){pending=null;},getHeartbeatStatus:()=> 'done'}, {now:()=>now});
  const controller=new HealthController({store,engine,identity:()=>identity,zylosDir:dir});
  engine.probeFences.set(pending.control_id,controller.captureFence());
  const revision=store.read().revision;
  const inbox=path.join(dir,'activity-monitor','health-inbox');fs.mkdirSync(inbox,{recursive:true});
  const stop=event({event:'stop',error:null,prompt_id:'heartbeat'});
  fs.writeFileSync(path.join(inbox,stop.event_id+'.json'),JSON.stringify(stop));
  engine.runMaintenanceCycle(true,now/1000);
  assert.equal(engine.health,'ok');assert.equal(store.read().health,'ok');
  assert.equal(store.read().revision,revision+1,'only verified recovery advances health revision');
  assert.equal(store.read().last_hook.event,'stop');assert.equal(pending,null);
  assert.equal(fs.readdirSync(inbox).length,0);
  engine.destroy();db.close();fs.rmSync(dir,{recursive:true,force:true});
});
