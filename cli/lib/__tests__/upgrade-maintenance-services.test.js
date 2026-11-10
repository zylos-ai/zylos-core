import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {serviceRestartFixture} from './helpers/service-restart-fixture.js';
const require = createRequire(import.meta.url);
const m = require('../upgrade-maintenance.cjs');

// Real recovery entry points and bounded PM2 children in a private fixture.
// Run for maintenance restart env changes; unrelated upgrade paths can skip.
// Fixture reads HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/private PATH before launch; no
// native daemon, tmux, database or network, and teardown restores/removes paths.
test('maintenance service restarts omit session identity and retain unrelated environment', t => {
  const f = serviceRestartFixture(t); f.custom();
  const injected = { ZYLOS_RUN_ID: 'caller-run', ZYLOS_SESSION_GROUP: 'chat:caller', SERVICE_SENTINEL: 'preserved' };
  const previous = Object.fromEntries(Object.keys(injected).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, injected);
  console.log('Maintenance isolation:', JSON.stringify(f.env));
  m.restartService('custom-service');
  m.start(f.j);
  const children = f.environments().filter(row => ['restart', 'startOrRestart'].includes(row.args[0]));
  assert.equal(children.length, 3);
  assert.equal(children.filter(row => row.args[0] === 'startOrRestart').length, 1);
  for (const row of children) {
    assert.equal(Object.hasOwn(row.env, 'ZYLOS_RUN_ID'), false);
    assert.equal(Object.hasOwn(row.env, 'ZYLOS_SESSION_GROUP'), false);
    assert.equal(row.env.SERVICE_SENTINEL, 'preserved');
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'PATH']) assert.equal(row.env[key], f.env[key]);
  }
  assert.equal(process.env.ZYLOS_RUN_ID, 'caller-run');
  assert.equal(process.env.ZYLOS_SESSION_GROUP, 'chat:caller');
});

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
  assert.deepEqual(f.calls(),[['jlist'],['startOrRestart',f.file,'--only','scheduler','--update-env'],['restart','custom-service','--update-env'],['jlist'],['jlist'],['save']]);
  assert.ok(f.records().every(record=>record.pm2_env.status==='online'));
});
test('new-code ready verification allows intentional regenerated ecosystem bytes',t=>{
  const f=serviceRestartFixture(t);f.j.phase='upgrade_complete';fs.appendFileSync(f.file,'// regenerated');
  m.start(f.j);assert.equal(f.calls()[0][0],'startOrRestart');
});
for(const source of ['throw Error("broken config")',"throw 'bad config'",'throw null','module.exports={}'])test(`ecosystem loading refuses invalid configuration ${source}`,t=>{
  const f=serviceRestartFixture(t);fs.writeFileSync(f.file,source);f.j.initialIdentity.ecosystemHash=m.hash(f.file);
  assert.throws(()=>m.start(f.j),error=>{
    assert.match(error.message,/ecosystem.*load|load.*ecosystem/i);
    assert.match(error.message,/^failed to load ecosystem: (broken config|bad config|null|invalid ecosystem apps)$/);
    assert.doesNotMatch(error.message,/\[eval\]|\n\s+at |Node\.js v/);
    return true;
  });assert.deepEqual(f.calls(),[]);
});
test('ecosystem names allow duplicates and ignore unnamed or nonstring entries',t=>{
  const f=serviceRestartFixture(t);
  fs.writeFileSync(f.file,'module.exports={apps:[{name:"scheduler"},{name:"scheduler"},{},{name:12},null]};');
  assert.deepEqual(m.ecosystemServiceNames(f.file),['scheduler']);
});
test('unnamed and nonstring ecosystem entries preserve external saved-record restarts',t=>{
  const f=serviceRestartFixture(t);
  fs.writeFileSync(f.file,'module.exports={apps:[{script:"service.js"},{name:12},null]};');
  f.j.initialIdentity.ecosystemHash=m.hash(f.file);
  m.start(f.j);
  assert.deepEqual(f.calls(),[['jlist'],['restart','scheduler','--update-env']]);
});
test('ecosystem loading observes changed exports without polluting the parent require cache',t=>{
  const f=serviceRestartFixture(t);assert.deepEqual(m.ecosystemServiceNames(f.file),['scheduler']);
  fs.writeFileSync(f.file,'console.log("config diagnostic");module.exports={apps:[{name:"custom-service"}]};');
  assert.deepEqual(m.ecosystemServiceNames(f.file),['custom-service']);assert.equal(require.cache[f.file],undefined);
});
test('external restart failure does not delete a PM2 record or retry via ecosystem',t=>{
  const f=serviceRestartFixture(t,{names:[]});f.fail();
  assert.doesNotThrow(()=>m.start(f.j));
  assert.deepEqual(f.calls(),[['jlist'],['restart','scheduler','--update-env']]);
});
test('verification warns for a saved custom service that remains stopped',t=>{
  const f=serviceRestartFixture(t);f.custom();f.records([f.record('scheduler','online'),f.record('custom-service')]);
  m.verifyServices(f.j);
  assert.match(f.j.serviceWarnings[0],/custom-service/);
  assert.deepEqual(f.calls(),[['jlist'],['jlist'],['save']]);
});
