import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runSelfUpgrade} from '../self-upgrade.js';
import {maintenance as m} from '../upgrade-protection.js';

const require=createRequire(import.meta.url);
const Database=require(path.resolve('skills/comm-bridge/node_modules/better-sqlite3'));

function fixture(t, fault) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-preinstall-failure-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const skillsDir=path.join(root,'.claude/skills'),tempDir=path.join(root,'new-package');
  fs.mkdirSync(path.join(skillsDir,'comm-bridge'),{recursive:true});
  fs.mkdirSync(path.join(tempDir,'skills/comm-bridge'),{recursive:true});
  fs.writeFileSync(path.join(skillsDir,'comm-bridge/package.json'),'{}');
  const original=new Map();
  for(const source of m.DB_PATHS) {
    const file=path.join(root,source);fs.mkdirSync(path.dirname(file),{recursive:true});
    const db=new Database(file);db.exec('CREATE TABLE preserved (value TEXT)');
    db.prepare('INSERT INTO preserved VALUES (?)').run(source);db.close();
    original.set(file,fs.readFileSync(file));
  }
  if(fault==='snapshot') {
    fs.mkdirSync(path.join(root,'.backup'));
    // A real filesystem failure at the snapshot destination, before publication.
    fs.writeFileSync(path.join(root,'.backup/db'),'snapshot destination unavailable');
  }
  const bin=path.join(root,'bin'),calls=path.join(root,'pm2-calls'),state=path.join(root,'service-state');
  fs.mkdirSync(bin);fs.writeFileSync(state,'online');
  // Every PM2 invocation, including the frozen recovery subprocess, resolves here.
  fs.writeFileSync(path.join(bin,'pm2'),`#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
const state=${JSON.stringify(state)};
if(args[0]==='jlist') {console.log(JSON.stringify([{name:'fixture-service',pid:0,pm2_env:{status:fs.readFileSync(state,'utf8'),pm_exec_path:${JSON.stringify(path.join(skillsDir,'comm-bridge/service.js'))}}}]));}
else if(args[0]==='stop') {if(${JSON.stringify(fault)}==='stop'){console.error('injected PM2 stop failure');process.exit(1);}fs.writeFileSync(state,'stopped');}
else if(args[0]==='restart'||args[0]==='startOrRestart') fs.writeFileSync(state,'online');
else if(args[0]!=='save') {console.error('unexpected fake PM2 command');process.exit(2);}
`,{mode:0o700});
  const prior=process.env.PATH;process.env.PATH=bin+path.delimiter+prior;
  t.after(()=>{process.env.PATH=prior;});
  return {root,skillsDir,tempDir,original,calls};
}

for(const fault of ['stop','snapshot']) test(`${fault} failure in default protected pipeline prevents installation and finalizer`,t=>{
  const f=fixture(t,fault);let installerCalls=0,finalizerCalls=0;
  const result=runSelfUpgrade({tempDir:f.tempDir,newVersion:'fixture-new'},{
    zylosDir:f.root,skillsDir:f.skillsDir,
    getCurrentVersion:()=>({success:true,version:'fixture-old'}),
    step4:{execSync:()=>{installerCalls++;throw Error('installer must not run');}},
    runInstalledFinalizer:()=>{finalizerCalls++;throw Error('finalizer must not run');},
  });
  assert.equal(result.preInstallProtection,true,JSON.stringify(result));
  assert.equal(result.success,false);
  assert.deepEqual(result.steps.map(step=>step.step),[1,2,3]);
  assert.equal(result.steps.at(-1).status,'failed');
  assert.match(result.steps.at(-1).error,fault==='stop'?/injected PM2 stop failure/:/EEXIST|ENOTDIR/);
  assert.equal(installerCalls,0);assert.equal(finalizerCalls,0);
  const journal=m.read(path.join(result.transactionDir,'journal.json'));
  assert.equal(journal.installationIntent,false);
  assert.notEqual(journal.installerStarted,true);assert.notEqual(journal.finalizerStarted,true);
  for(const [file,bytes] of f.original) assert.deepEqual(fs.readFileSync(file),bytes,file);
  const calls=fs.readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(args=>args[0]==='stop'),'real stop boundary must be exercised');
});
