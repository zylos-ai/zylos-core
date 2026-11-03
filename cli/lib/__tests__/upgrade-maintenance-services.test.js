import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {serviceFixture} from './helpers/upgrade-service-fixture.js';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require = createRequire(import.meta.url);
const m = require('../upgrade-maintenance.cjs');
function fixture(t, {ecosystem=false}={}) {
  return serviceFixture(t, {ecosystem});
}
test('originally missing ecosystem restarts verified saved PM2 names without invoking journal script paths', t => {
  const f = fixture(t);
  m.start(f.j);
  assert.deepEqual(f.commands(), [['jlist'], ['restart','scheduler','--update-env']]);
  f.records([{name:'scheduler',pid:123,pm2_env:{status:'online',pm_exec_path:f.j.originalServices[0].script}}]);
  m.verifyServices(f.j);
  assert.deepEqual(f.commands().slice(-2),[['jlist'],['save']]);
  assert.equal(fs.existsSync(f.file), false);
});
for (const changed of ['missing', 'outside', 'changed', 'journal-script']) test(`missing ecosystem restart refuses ${changed} PM2 provenance before starting any service`, t => {
  const f = fixture(t);
  if (changed==='missing') f.records([]);
  if (changed==='outside') f.records([{name:'scheduler', pm2_env:{pm_exec_path:'/tmp/untrusted.js'}}]);
  if (changed==='changed') f.records([{name:'scheduler', pm2_env:{pm_exec_path:path.join(f.j.skillsDir, 'scheduler/scripts/changed.js')}}]);
  if (changed==='journal-script') f.j.originalServices[0].script='/tmp/untrusted.js';
  assert.throws(() => m.start(f.j), /original PM2 service record missing or changed/);
  assert.deepEqual(f.commands(), [['jlist']]);
});
for (const defect of ['missing', 'changed', 'symlink']) test(`originally present ecosystem ${defect} fails closed for restored service restart`, t => {
  const f = fixture(t, {ecosystem:true});
  if (defect==='changed') fs.appendFileSync(f.file, '// altered');
  else {
    fs.unlinkSync(f.file);
    if (defect==='symlink') fs.symlinkSync(path.join(f.root,'outside'),f.file);
  }
  assert.throws(() => m.start(f.j), /ENOENT|identity changed|unsafe recovery path/);
  assert.deepEqual(f.commands(), []);
});
test('present verified original ecosystem retains startOrRestart behavior', t => {
  const f = fixture(t, {ecosystem:true});
  m.start(f.j);
  assert.deepEqual(f.commands(), [['startOrRestart',f.file,'--only','scheduler','--update-env']]);
});
test('new-code ready verification allows intentional regenerated ecosystem bytes', t => {
  const f = fixture(t, {ecosystem:true});
  f.j.phase='new_verifying';
  fs.appendFileSync(f.file, '// legitimate updated ecosystem');
  assert.doesNotThrow(() => m.start(f.j));
  assert.equal(f.commands()[0][0], 'startOrRestart');
});

test('external services use saved restart instead of a silently filtered ecosystem start', t => {
  const f = serviceFixture(t, {ecosystem:true,names:[]});
  m.start(f.j);
  m.verifyServices(f.j);
  assert.equal(f.readRecords()[0].pm2_env.status,'online');
  assert.deepEqual(f.commands(),[['jlist'],['restart','scheduler','--update-env'],['jlist'],['save']]);
});

for (const changed of ['missing','outside','changed','duplicate','saved-duplicate']) {
  test(`external service with present ecosystem refuses ${changed} provenance`, t => {
    const f = serviceFixture(t, {ecosystem:true,names:[]});
    const record = f.readRecords()[0];
    if(changed==='missing') f.records([]);
    if(changed==='outside') {record.pm2_env.pm_exec_path='/tmp/untrusted.js';f.records([record]);}
    if(changed==='changed') {record.pm2_env.pm_exec_path=path.join(f.j.skillsDir,'changed.js');f.records([record]);}
    if(changed==='duplicate') f.records([record,record]);
    if(changed==='saved-duplicate') f.j.originalServices.push({...f.j.originalServices[0]});
    assert.throws(() => m.start(f.j),/original PM2 service record missing or changed/);
    assert.deepEqual(f.commands(),[['jlist']]);
  });
}

for (const source of ['throw Error("cannot load")','module.exports={}','module.exports={apps:[{}]}','module.exports={apps:[{name:"x"},{name:"x"}]}']) {
  test(`invalid ecosystem fails before PM2 actions: ${source}`, t => {
    const f = fixture(t, {ecosystem:true});
    fs.writeFileSync(f.file,source);
    f.j.initialIdentity.ecosystemHash=m.hash(f.file);
    assert.throws(() => m.start(f.j));
    assert.deepEqual(f.commands(),[]);
  });
}

test('ecosystem module loads in a fresh child without parent cache or stdout pollution', t => {
  const f = fixture(t,{ecosystem:true});
  fs.appendFileSync(f.file,'console.log("configuration diagnostic");');
  assert.deepEqual(m.ecosystemServiceNames(f.file),['scheduler']);
  assert.equal(require.cache[f.file],undefined);
  fs.writeFileSync(f.file,'module.exports={apps:[{name:"changed"}]};');
  assert.deepEqual(m.ecosystemServiceNames(f.file),['changed']);
});

test('external restart failure has no delete or ecosystem fallback', t => {
  const f = serviceFixture(t,{ecosystem:true,names:[]});
  fs.writeFileSync(path.join(f.root,'fail-restart'),'yes');
  assert.throws(() => m.start(f.j),/exited 8/);
  assert.deepEqual(f.commands(),[['jlist'],['restart','scheduler','--update-env']]);
});

test('fake PM2 preserves the zero-success filtered-start premise', t => {
  const f = serviceFixture(t,{ecosystem:true,names:[]});
  const result=spawnSync('pm2',['startOrRestart',f.file,'--only','scheduler','--update-env'],{encoding:'utf8'});
  assert.equal(result.status,0);
  assert.equal(f.readRecords()[0].pm2_env.status,'stopped');
});

test('strict service verification refuses an external service remaining stopped', t => {
  const f = serviceFixture(t,{ecosystem:true,names:[]});
  let elapsed=0;
  t.mock.method(Date,'now',()=>elapsed+=40000);
  assert.throws(()=>m.verifyServices(f.j),/original services did not become online/);
  assert.deepEqual(f.commands(),[['jlist']]);
});

test('mixed service recovery keeps the external service in complete verification', t => {
  const f = serviceFixture(t,{ecosystem:true});
  const external={name:'custom',script:path.join(f.j.skillsDir,'custom/service.js')};
  f.j.originalServices.push(external);
  f.records([...f.readRecords(),{name:external.name,pid:0,pm2_env:{status:'stopped',pm_exec_path:external.script}}]);
  m.start(f.j);
  m.verifyServices(f.j);
  assert.ok(f.readRecords().every(record=>record.pm2_env.status==='online'));
  assert.deepEqual(f.commands(),[['jlist'],['startOrRestart',f.file,'--only','scheduler','--update-env'],['restart','custom','--update-env'],['jlist'],['save']]);
});
