import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {step11_startCoreServices, step3_stopCoreServices, createFinalizeState, runSelfUpgradeFinalize} from '../self-upgrade.js';
import {prepareBackupOnlyInstall} from '../upgrade-protection.js';
import {serviceFixture} from './helpers/upgrade-service-fixture.js';
const m = createRequire(import.meta.url)('../upgrade-maintenance.cjs');

function context(f) {
  return {tempDir:null,servicesWereRunning:f.j.originalServices.map(service=>service.name),
    originalServices:f.j.originalServices,backupOnlySkillsDir:f.j.skillsDir};
}

test('step11 restarts an ecosystem service and a verified external record', t => {
  const f = serviceFixture(t,{ecosystem:true});
  const external = {name:'custom',script:path.join(f.j.skillsDir,'custom/service.js')};
  f.j.originalServices.push(external);
  f.records([...f.readRecords(),{name:external.name,pid:0,pm2_env:{status:'stopped',pm_exec_path:external.script}}]);
  const result = step11_startCoreServices(context(f),{ecosystemPath:f.file,zylosDir:f.root});
  assert.equal(result.status,'done',result.error);
  assert.ok(f.readRecords().every(record=>record.pm2_env.status==='online'));
  assert.deepEqual(f.commands(),[['jlist'],['start',f.file,'--only','scheduler','--update-env'],['restart','custom','--update-env'],['save']]);
});

for(const defect of ['missing','changed','outside','duplicate','saved-duplicate','no-saved-record']) test(`step11 refuses ${defect} external provenance before starting`, t=>{
  const f=serviceFixture(t,{ecosystem:true,names:[]}),ctx=context(f),record=f.readRecords()[0];
  if(defect==='missing') f.records([]);
  if(defect==='changed'){record.pm2_env.pm_exec_path=path.join(f.j.skillsDir,'changed.js');f.records([record]);}
  if(defect==='outside'){record.pm2_env.pm_exec_path='/tmp/untrusted.js';f.records([record]);}
  if(defect==='duplicate') f.records([record,record]);
  if(defect==='saved-duplicate') ctx.originalServices.push({...ctx.originalServices[0]});
  if(defect==='no-saved-record') ctx.originalServices=[];
  const result=step11_startCoreServices(ctx,{ecosystemPath:f.file,zylosDir:f.root});
  assert.equal(result.status,'failed');
  assert.match(result.error,/original PM2 service record missing or changed/);
  assert.ok(f.commands().every(args=>args[0]==='jlist'));
});

test('step11 external restart failure cannot delete its PM2 record or save success',t=>{
  const f=serviceFixture(t,{ecosystem:true,names:[]});
  fs.writeFileSync(path.join(f.root,'fail-restart'),'yes');
  const result=step11_startCoreServices(context(f),{ecosystemPath:f.file,zylosDir:f.root});
  assert.equal(result.status,'failed');
  assert.deepEqual(f.commands(),[['jlist'],['restart','scheduler','--update-env']]);
  assert.equal(f.readRecords()[0].pm2_env.status,'stopped');
});

test('step11 without ecosystem restarts the original record with updated environment',t=>{
  const f=serviceFixture(t);
  const result=step11_startCoreServices(context(f),{ecosystemPath:f.file,zylosDir:f.root});
  assert.equal(result.status,'done',result.error);
  assert.deepEqual(f.commands(),[['jlist'],['restart','scheduler','--update-env'],['save']]);
});

test('step11 reads protected service provenance from durable journal',t=>{
  const f=serviceFixture(t,{ecosystem:true,names:[]});
  const dir=path.join(f.root,'transaction');fs.mkdirSync(dir);
  m.durable(path.join(dir,'journal.json'),f.j);
  const ctx={...context(f),preInstallProtection:true,transactionDir:dir,journal:f.j,originalServices:[]};
  const result=step11_startCoreServices(ctx,{ecosystemPath:f.file,zylosDir:f.root});
  assert.equal(result.status,'done',result.error);
  assert.equal(f.readRecords()[0].pm2_env.status,'online');
});

test('nonprotected stop captures script provenance and finalize state retains it',()=>{
  const saved={name:'custom',status:'online',script:'/isolated/skills/custom/service.js'};
  const ctx={servicesWereRunning:[],servicesStopped:[]};
  const result=step3_stopCoreServices(ctx,{getSkillsServices:()=>[saved],stopService:()=>{}});
  assert.equal(result.status,'done');
  assert.deepEqual(ctx.originalServices,[saved]);
  assert.notEqual(ctx.originalServices[0],saved);
  assert.deepEqual(createFinalizeState(ctx).originalServices,[saved]);
});

test('backup-only service stop preserves script provenance without a transaction journal', t=>{
  const f=serviceFixture(t,{ecosystem:true,names:[]});
  const ctx={backupOnlyRoot:f.root,backupOnlySkillsDir:f.j.skillsDir};
  prepareBackupOnlyInstall(ctx,{
    probeSnapshotSync:()=>{},services:()=>[{...f.j.originalServices[0],status:'online'}],
    stop:()=>{},snapshot:()=>({dbBackupDir:path.join(f.root,'snapshot'),manifest:{databases:[]}}),verifySnapshot:()=>{},
  });
  assert.deepEqual(ctx.servicesWereRunning,['scheduler']);
  assert.equal(ctx.originalServices[0].script,f.j.originalServices[0].script);
  assert.equal(ctx.transactionDir,undefined);
  const state=createFinalizeState(ctx);
  const result=runSelfUpgradeFinalize(state,{steps:[restored=>{
    assert.deepEqual(restored.originalServices,ctx.originalServices);
    assert.notEqual(restored.originalServices[0],ctx.originalServices[0]);
    return {step:11,name:'start_core_services',status:'done'};
  }]});
  assert.equal(result.success,true);
});
