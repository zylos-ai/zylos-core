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
test('context monitor preserves native status and identifies publication failures without exposing input',t=>{
  const {options}=fixture(t);
  const script=fileURLToPath(new URL('../context-monitor.js',import.meta.url));
  const env={...process.env,ZYLOS_DIR:options.zylosDir};
  const payload={...status,custom_field:'legacy consumer value',context_window:{used_percentage:0}};
  const result=spawnSync(process.execPath,[script],{env,input:JSON.stringify(payload),encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(result.stdout,'');
  const written=JSON.parse(fs.readFileSync(path.join(options.zylosDir,'activity-monitor','statusline.json'),'utf8'));
  assert.deepEqual(written,payload);assert.equal(Object.hasOwn(written,'zylos'),false);
  const invalid=spawnSync(process.execPath,[script],{env,input:'{"SECRET_RAW_INPUT":',encoding:'utf8'});
  assert.equal(invalid.status,0);
  const legacyLog=fs.readFileSync(path.join(options.zylosDir,'activity-monitor','hook-activity-errors.log'),'utf8');
  assert.match(legacyLog,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z session_group="unknown" run_id="unknown" statusline: invalid sample or publication failure\n$/);
  assert.equal(legacyLog.includes('SECRET_RAW_INPUT'),false);

  const invoke=(name,extraEnv,input='{"broken":')=>{
    const root=path.join(options.zylosDir,name);
    const result=spawnSync(process.execPath,[script],{env:{...process.env,ZYLOS_DIR:root,...extraEnv},input,encoding:'utf8'});
    assert.equal(result.status,0);assert.equal(result.stdout,'');
    return {root,log:path.join(root,'activity-monitor','hook-activity-errors.log')};
  };
  const groupedRoot=path.join(options.zylosDir,'grouped');
  fs.mkdirSync(path.join(groupedRoot,'activity-monitor/session-groups/telegram:a/statusline.json'),{recursive:true});
  const grouped=invoke('grouped',{ZYLOS_SESSION_GROUP:'telegram:a',ZYLOS_RUN_ID:'run-group'},JSON.stringify(payload));
  assert.match(fs.readFileSync(grouped.log,'utf8'),/session_group="telegram:a" run_id="run-group" statusline:/);
  assert.equal(fs.existsSync(path.join(groupedRoot,'activity-monitor/session-groups/telegram:a/events.jsonl')),false);

  const single=invoke('single',{ZYLOS_RUN_ID:'run-single'});
  assert.match(fs.readFileSync(single.log,'utf8'),/session_group="origin" run_id="run-single" statusline:/);
  const missingRun=invoke('missing-run',{ZYLOS_SESSION_GROUP:'telegram:a'});
  assert.match(fs.readFileSync(missingRun.log,'utf8'),/session_group="unknown" run_id="unknown" statusline:/);
  const invalidIdentity=invoke('invalid',{ZYLOS_SESSION_GROUP:'..\/bad',ZYLOS_RUN_ID:'run-invalid'});
  assert.match(fs.readFileSync(invalidIdentity.log,'utf8'),/session_group="unknown" run_id="unknown" statusline:/);

  const unwritableRoot=path.join(options.zylosDir,'unwritable');
  fs.mkdirSync(path.join(unwritableRoot,'activity-monitor','hook-activity-errors.log'),{recursive:true});
  const unwritable=spawnSync(process.execPath,[script],{env:{...process.env,ZYLOS_DIR:unwritableRoot,ZYLOS_RUN_ID:'run'},input:'{',encoding:'utf8'});
  assert.equal(unwritable.status,0);assert.equal(unwritable.stdout,'');
});

test('first-failure quota reads exact run/session and never the legacy latest snapshot',async t=>{
  const {readScopedHealthQuota}=await import('../health-quota.js');
  const {publishContextSample}=await import('../context-monitor.js');
  const {identity,options}=fixture(t);writeHealthQuota(status,options);
  const env={ZYLOS_DIR:options.zylosDir,ZYLOS_RUN_ID:'run-a',ZYLOS_SESSION_GROUP:'chat:A'};
  const runDir=path.join(options.zylosDir,'activity-monitor/session-groups/chat:A');
  const read=extra=>readScopedHealthQuota({runDir,runId:'run-a',identity,nowMs:options.nowMs,...extra});
  assert.equal(read(),null); // An existing legacy quota file is not evidence for this group.
  publishContextSample({...status,secret:'exclude'},{env,now:options.nowMs});
  assert.deepEqual(read().rate_limits,status.rate_limits);assert.equal(JSON.stringify(read()).includes('secret'),false);
  assert.equal(read({runId:'run-b'}),null);assert.equal(read({identity:{...identity,session_id:'other'}}),null);
  assert.equal(read({identity:{...identity,runtime:'codex'}}),null);
  assert.equal(read({nowMs:options.nowMs-1}),null);assert.equal(read({nowMs:options.nowMs+60001}),null);
  const file=path.join(runDir,'statusline.json');fs.writeFileSync(file,'{');assert.equal(read(),null);
  publishContextSample({session_id:'session'},{env,now:options.nowMs});assert.equal(read(),null);
  const otherDir=path.join(options.zylosDir,'activity-monitor/session-groups/chat:B');assert.equal(read({runDir:otherDir}),null);
});
