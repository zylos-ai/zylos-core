import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {writeHealthQuota,readHealthQuota,sanitizeHealthQuota} from '../health-quota.js';

function fixture(t) {
  const zylosDir=fs.mkdtempSync(path.join(os.tmpdir(),'health-quota-'));
  t.after(()=>fs.rmSync(zylosDir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(zylosDir,'activity-monitor'));
  const identity={runtime:'claude',session_id:'session',claude_pid:123};
  fs.writeFileSync(path.join(zylosDir,'activity-monitor','foreground-session.json'),JSON.stringify(identity));
  const options={zylosDir,managedIdentity:()=>identity,nowMs:1000000,pid:123};
  return {identity,options,read:(extra={})=>readHealthQuota({identity,zylosDir,nowMs:1000000,...extra})};
}
const status={session_id:'session',rate_limits:{five_hour:{used_percentage:100,resets_at:2000},seven_day:{used_percentage:40,resets_at:3000}}};
test('producer and reader preserve bounded quota fields with matching PID and session',t=>{
  const {identity,options,read}=fixture(t);
  const saved=writeHealthQuota({...status,prompt:'SECRET',rate_limits:{...status.rate_limits,spend_limit:{secret:'SECRET'},five_hour:{...status.rate_limits.five_hour,secret:'SECRET'}}},options);
  assert.deepEqual(read(),saved);assert.equal(JSON.stringify(saved).includes('SECRET'),false);
  assert.deepEqual(saved.rate_limits,status.rate_limits);
  assert.equal(read({identity:{...identity,session_id:'other'}}),null);
  assert.equal(read({identity:{...identity,claude_pid:999}}),null);
  assert.equal(Object.hasOwn(saved,'process_start'),false);
  assert.equal(read({nowMs:1060001}),null);assert.equal(read({nowMs:999999}),null);
});
test('producer rejects unmanaged process and foreground PID or session mismatch',t=>{
  const {options}=fixture(t);
  for(const change of [{managedIdentity:()=>null},{pid:999},{pid:null},{pid:0}])assert.equal(writeHealthQuota(status,{...options,...change}),null);
  assert.equal(writeHealthQuota({...status,session_id:'other'},options),null);
  assert.equal(fs.existsSync(path.join(options.zylosDir,'activity-monitor','health-quota')),false);
});
test('absent or malformed windows replace older quota with neutral evidence',t=>{
  const {options,read}=fixture(t);writeHealthQuota(status,options);
  writeHealthQuota({session_id:'session'},options);assert.equal(read(),null);
  for(const bad of [-1,101,'100',null,NaN,Infinity]) {
    writeHealthQuota({session_id:'session',rate_limits:{five_hour:{used_percentage:bad}}},options);assert.equal(read(),null);
  }
});
test('reset seconds must be future bounded numeric integers; missing reset cannot fabricate ETA',t=>{
  const {options,read}=fixture(t);
  for(const resets_at of [999,1000,1000.1,'2000',1000+8*86400+1,null]) {
    writeHealthQuota({session_id:'session',rate_limits:{five_hour:{used_percentage:100,resets_at}}},options);assert.equal(read(),null);
  }
  writeHealthQuota({session_id:'session',rate_limits:{five_hour:{used_percentage:100}}},options);
  assert.deepEqual(read().rate_limits,{five_hour:{used_percentage:100}});
});
test('captured snapshot validation rejects newer observations and expired resets without filesystem trust',t=>{
  const {identity,options}=fixture(t);const snapshot=writeHealthQuota(status,options);
  assert.equal(sanitizeHealthQuota(snapshot,{identity,nowMs:options.nowMs-1}),null);
  assert.equal(sanitizeHealthQuota({...snapshot,rate_limits:{five_hour:{used_percentage:100,resets_at:1001}}},{identity,nowMs:1001000}),null);
  assert.equal(sanitizeHealthQuota({...snapshot,source:'mtime'},{identity,nowMs:options.nowMs}),null);
});
test('process replacement rejects late producer and old snapshots without deleting legacy files',t=>{
  const {identity,options,read}=fixture(t);writeHealthQuota(status,options);
  const directory=path.join(options.zylosDir,'activity-monitor','health-quota');
  fs.writeFileSync(path.join(directory,'unrelated.json'),'retain');
  const replacement={...identity,claude_pid:999};
  assert.equal(writeHealthQuota(status,{...options,managedIdentity:()=>replacement}),null);
  assert.equal(read({identity:replacement}),null);
  assert.equal(fs.readFileSync(path.join(directory,'unrelated.json'),'utf8'),'retain');
});
test('legacy process-start metadata is ignored and stripped when PID and session match',t=>{
  const {identity,options,read}=fixture(t);
  const saved=writeHealthQuota(status,{...options,processStart:null});
  const legacy={...saved,process_start:'old-process-incarnation'};
  fs.writeFileSync(path.join(options.zylosDir,'activity-monitor/health-quota/claude.json'),JSON.stringify(legacy));
  const current={...identity,process_start:'new-process-incarnation'};
  assert.deepEqual(read({identity:current,processStart:()=>{throw Error('must not read proc');}}),saved);
  assert.deepEqual(sanitizeHealthQuota(legacy,{identity:current,nowMs:options.nowMs}),saved);
  assert.equal(Object.hasOwn(saved,'process_start'),false);
});
test('reader rejects malformed, oversized, or nonregular snapshot files',t=>{
  const {options,read}=fixture(t);const snapshot=writeHealthQuota(status,options);
  const file=path.join(options.zylosDir,'activity-monitor','health-quota','claude.json');
  for(const content of ['{',JSON.stringify({...snapshot,padding:'x'.repeat(3000)})]) {fs.writeFileSync(file,content);assert.equal(read(),null);}
});
test('context monitor preserves legacy status output and excludes raw failed input from logs',t=>{
  const {options}=fixture(t);
  const script=fileURLToPath(new URL('../context-monitor.js',import.meta.url));
  const env={...process.env,ZYLOS_DIR:options.zylosDir};
  const payload={...status,custom_field:'legacy consumer value',context_window:{used_percentage:0}};
  const result=spawnSync(process.execPath,[script],{env,input:JSON.stringify(payload),encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(result.stdout,'');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(options.zylosDir,'activity-monitor','statusline.json'),'utf8')),payload);
  const invalid=spawnSync(process.execPath,[script],{env,input:'{"SECRET_RAW_INPUT":',encoding:'utf8'});
  assert.equal(invalid.status,0);
  assert.equal(fs.readFileSync(path.join(options.zylosDir,'activity-monitor','context-monitor.log'),'utf8').includes('SECRET_RAW_INPUT'),false);
});
