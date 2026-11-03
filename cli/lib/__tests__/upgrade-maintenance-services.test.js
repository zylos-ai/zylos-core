import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {serviceRestartFixture} from './helpers/service-restart-fixture.js';
const require = createRequire(import.meta.url);
const m = require('../upgrade-maintenance.cjs');

test('fake PM2 filters ecosystem names and reports success for zero matches without starting them', t => {
  const f = serviceRestartFixture(t);
  const result = spawnSync(f.pm2,['startOrRestart',f.file,'--only','custom-service','--update-env']);
  assert.equal(result.status,0);
  assert.equal(f.records().find(record=>record.name==='custom-service').pm2_env.status,'stopped');
});
test('originally missing ecosystem restarts verified saved PM2 names without invoking journal script paths', t => {
  const f = serviceRestartFixture(t,{ecosystem:false});
  m.start(f.j);
  assert.deepEqual(f.calls(),[['jlist'],['restart','scheduler','--update-env']]);
  m.verifyServices(f.j);
  assert.deepEqual(f.calls().slice(-2),[['jlist'],['save']]);
  assert.equal(fs.existsSync(f.file),false);
});
for (const ecosystem of [false,true]) for (const changed of ['missing','outside','changed','journal-script','duplicate-record','duplicate-saved']) test(`${ecosystem?'present':'missing'} ecosystem refuses ${changed} saved external provenance before restarting`, t => {
  const f = serviceRestartFixture(t,{ecosystem,names:[]});
  if(changed==='missing')f.records([]);
  if(changed==='outside')f.records([{name:'scheduler',pm2_env:{pm_exec_path:'/tmp/untrusted.js'}}]);
  if(changed==='changed')f.records([{name:'scheduler',pm2_env:{pm_exec_path:path.join(f.skillsDir,'changed.js')}}]);
  if(changed==='journal-script')f.j.originalServices[0].script='/tmp/untrusted.js';
  if(changed==='duplicate-record')f.records([f.record('scheduler'),f.record('scheduler')]);
  if(changed==='duplicate-saved')f.j.originalServices.push({...f.j.originalServices[0]});
  assert.throws(()=>m.start(f.j),/original PM2 service record missing or changed/);
  assert.deepEqual(f.calls(),[['jlist']]);
});
for(const defect of ['missing','changed','symlink'])test(`present ecosystem ${defect} fails closed for restored service restart`,t=>{
  const f=serviceRestartFixture(t);
  if(defect==='changed')fs.appendFileSync(f.file,'// altered');
  else {fs.unlinkSync(f.file);if(defect==='symlink')fs.symlinkSync(path.join(f.root,'outside'),f.file);}
  assert.throws(()=>m.start(f.j),/ENOENT|identity changed|unsafe recovery path/);
  assert.deepEqual(f.calls(),[]);
});
test('mixed ecosystem and custom services restart through their respective paths and remain in verification',t=>{
  const f=serviceRestartFixture(t);f.custom();
  m.start(f.j);m.verifyServices(f.j);
  assert.deepEqual(f.calls(),[['jlist'],['startOrRestart',f.file,'--only','scheduler','--update-env'],['restart','custom-service','--update-env'],['jlist'],['save']]);
  assert.ok(f.records().every(record=>record.pm2_env.status==='online'));
});
test('new-code ready verification allows intentional regenerated ecosystem bytes',t=>{
  const f=serviceRestartFixture(t);f.j.phase='upgrade_complete';fs.appendFileSync(f.file,'// regenerated');
  m.start(f.j);assert.equal(f.calls()[0][0],'startOrRestart');
});
for(const source of ['throw Error("broken config")','module.exports={}','module.exports={apps:[{}]}'])test(`ecosystem loading refuses invalid configuration ${source}`,t=>{
  const f=serviceRestartFixture(t);fs.writeFileSync(f.file,source);f.j.initialIdentity.ecosystemHash=m.hash(f.file);
  assert.throws(()=>m.start(f.j),/broken config|invalid ecosystem/);assert.deepEqual(f.calls(),[]);
});
test('ecosystem loading observes changed exports without polluting the parent require cache',t=>{
  const f=serviceRestartFixture(t);assert.deepEqual(m.ecosystemServiceNames(f.file),['scheduler']);
  fs.writeFileSync(f.file,'console.log("config diagnostic");module.exports={apps:[{name:"custom-service"}]};');
  assert.deepEqual(m.ecosystemServiceNames(f.file),['custom-service']);assert.equal(require.cache[f.file],undefined);
});
test('external restart failure does not delete a PM2 record or retry via ecosystem',t=>{
  const f=serviceRestartFixture(t,{names:[]});f.fail();
  assert.throws(()=>m.start(f.j),/restart failed/);
  assert.deepEqual(f.calls(),[['jlist'],['restart','scheduler','--update-env']]);
});
test('verification does not exclude a saved custom service that remains stopped',t=>{
  const f=serviceRestartFixture(t);f.custom();f.records([f.record('scheduler','online'),f.record('custom-service')]);f.listLimit(1);
  assert.throws(()=>m.verifyServices(f.j),/list unavailable/);
  assert.deepEqual(f.calls(),[['jlist'],['jlist']]);
});
