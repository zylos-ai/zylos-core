import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {step11_startCoreServices} from '../self-upgrade.js';
import {serviceFixture} from './helpers/upgrade-service-fixture.js';
const m = createRequire(import.meta.url)('../upgrade-maintenance.cjs');

function context(f) {
  const dir = path.join(f.root, 'transaction');
  fs.mkdirSync(dir, {recursive:true, mode:0o700});
  m.durable(path.join(dir, 'journal.json'), f.j);
  return {tempDir:null,servicesWereRunning:f.j.originalServices.map(service=>service.name),
    preInstallProtection:true,transactionDir:dir};
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
  const f=serviceFixture(t,{ecosystem:true,names:[]}),record=f.readRecords()[0];
  if(defect==='missing') f.records([]);
  if(defect==='changed'){record.pm2_env.pm_exec_path=path.join(f.j.skillsDir,'changed.js');f.records([record]);}
  if(defect==='outside'){record.pm2_env.pm_exec_path='/tmp/untrusted.js';f.records([record]);}
  if(defect==='duplicate') f.records([record,record]);
  const ctx=context(f);
  if(defect==='saved-duplicate') f.j.originalServices.push({...f.j.originalServices[0]});
  if(defect==='no-saved-record') f.j.originalServices=[];
  m.durable(path.join(ctx.transactionDir, 'journal.json'), f.j);
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
  const ctx={...context(f),journal:{originalServices:[]},originalServices:[]};
  const result=step11_startCoreServices(ctx,{ecosystemPath:f.file,zylosDir:f.root});
  assert.equal(result.status,'done',result.error);
  assert.equal(f.readRecords()[0].pm2_env.status,'online');
});

for (const source of ['throw Error("cannot load")', 'module.exports={}']) {
  test(`step11 rejects invalid ecosystem before starting any service: ${source}`, t => {
    const f=serviceFixture(t,{ecosystem:true});
    fs.writeFileSync(f.file,source);
    const result=step11_startCoreServices(context(f),{ecosystemPath:f.file,zylosDir:f.root});
    assert.equal(result.status,'failed');
    assert.match(result.error,/cannot load|invalid ecosystem/);
    assert.match(result.error,/^failed to load ecosystem: /);
    assert.doesNotMatch(result.error,/\[eval\]|\n\s+at |Node\.js/);
    assert.deepEqual(f.commands(),[]);
    assert.equal(f.readRecords()[0].pm2_env.status,'stopped');
  });
}

test('step11 treats unnamed and nonstring ecosystem apps as external saved services', t => {
  const f=serviceFixture(t,{ecosystem:true});
  fs.writeFileSync(f.file,`module.exports={apps:[{script:${JSON.stringify(f.j.originalServices[0].script)}},{name:42},null]};`);
  const result=step11_startCoreServices(context(f),{ecosystemPath:f.file,zylosDir:f.root});
  assert.equal(result.status,'done',result.error);
  assert.deepEqual(f.commands(),[['jlist'],['restart','scheduler','--update-env'],['save']]);
  assert.equal(f.readRecords()[0].pm2_env.status,'online');
});

test('step11 accepts duplicate ecosystem names', t => {
  const f=serviceFixture(t,{ecosystem:true});
  fs.writeFileSync(f.file,'module.exports={apps:[{name:"scheduler"},{name:"scheduler"}]};');
  const result=step11_startCoreServices(context(f),{ecosystemPath:f.file,zylosDir:f.root});
  assert.equal(result.status,'done',result.error);
  assert.deepEqual(f.commands(),[['start',f.file,'--only','scheduler','--update-env'],['save']]);
});
