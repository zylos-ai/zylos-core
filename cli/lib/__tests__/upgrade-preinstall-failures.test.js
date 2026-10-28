import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {CORE_DATABASES} from '../core-db-backup.js';
import {maintenance as m} from '../upgrade-protection.js';
import {prepareProtectedInstall} from '../upgrade-protection.js';
import {runUpgradeEntry} from '../upgrade-entry.js';

const require=createRequire(import.meta.url);
const Database=require(path.resolve('skills/comm-bridge/node_modules/better-sqlite3'));

function fixture(t, fault) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-preinstall-failure-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const skillsDir=path.join(root,'.claude/skills'),tempDir=path.join(root,'new-package');
  const packageRoot=path.join(root,'installed-package');
  fs.mkdirSync(packageRoot);
  fs.copyFileSync(path.resolve('package.json'),path.join(packageRoot,'package.json'));
  fs.cpSync(path.resolve('cli'),path.join(packageRoot,'cli'),{recursive:true,filter:file=>!file.split(path.sep).includes('__tests__')});
  fs.symlinkSync(path.resolve('node_modules'),path.join(packageRoot,'node_modules'));
  fs.mkdirSync(path.join(packageRoot,'skills'));
  for(const name of fs.readdirSync(path.resolve('skills'))) if(name!=='dashboard') fs.symlinkSync(path.resolve('skills',name),path.join(packageRoot,'skills',name));
  const dashboardRoot=path.join(packageRoot,'skills/dashboard');fs.mkdirSync(path.join(dashboardRoot,'src/lib'),{recursive:true});
  fs.writeFileSync(path.join(dashboardRoot,'package.json'),'{"type":"module","main":"index.js"}');
  fs.symlinkSync(path.resolve('skills/comm-bridge/node_modules'),path.join(dashboardRoot,'node_modules'));
  fs.writeFileSync(path.join(dashboardRoot,'src/lib/schema-owner.js'),`import {createRequire} from 'node:module';
  const Database=createRequire(${JSON.stringify(path.resolve('skills/comm-bridge/package.json'))})('better-sqlite3');
  export const dashboardSchemaOwner={
    supportsNewDatabase(){return true;},
    inspectSchema(file){const db=new Database(file,{readonly:true,fileMustExist:true});try{db.prepare('SELECT value FROM preserved').get();return {currentVersion:1,targetVersion:1,needsMigration:false};}finally{db.close();}},
    migrate(){throw Error('preinstall verification must not migrate Dashboard');}
  };`);
  fs.mkdirSync(path.join(skillsDir,'comm-bridge'),{recursive:true});
  fs.mkdirSync(path.join(tempDir,'skills/comm-bridge'),{recursive:true});
  for (const [owner,schema] of [['comm-bridge','c4-schema.js'],['scheduler','schema.js'],['web-console','schema.js']]) {
    const dest=path.join(skillsDir,owner);fs.mkdirSync(path.join(dest,'scripts'),{recursive:true});
    fs.writeFileSync(path.join(dest,'package.json'),'{"type":"module"}');
    fs.symlinkSync(path.resolve('skills',owner,'node_modules'),path.join(dest,'node_modules'));
    fs.writeFileSync(path.join(dest,'scripts',schema),`export const supportsNewDatabase=true;export const TABLES={preserved:['value']};export function inspectSchema(db){db.prepare('SELECT value FROM preserved').all();return {version:0,empty:false,extensions:{tables:[],columns:[]}};}`);
  fs.writeFileSync(path.join(dest,'scripts/sqlite-schema.js'),'export {}; // pre-chain compatibility fixture');
  }
  const original=new Map();
  for(const {source} of CORE_DATABASES) {
    const file=path.join(root,source);fs.mkdirSync(path.dirname(file),{recursive:true});
    const db=new Database(file);db.exec('CREATE TABLE preserved (value TEXT)');
    db.prepare('INSERT INTO preserved VALUES (?)').run(source);db.close();
    original.set(file,fs.readFileSync(file));
  }
  const bin=path.join(root,'bin'),calls=path.join(root,'pm2-calls'),state=path.join(root,'service-state');
  fs.mkdirSync(bin);fs.writeFileSync(state,'online');
  // Every PM2 invocation, including the frozen recovery subprocess, resolves here.
  fs.writeFileSync(path.join(bin,'pm2'),`#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
const state=${JSON.stringify(state)};
if(args[0]==='jlist') {console.log(JSON.stringify([{name:'fixture-service',pid:fs.readFileSync(state,'utf8')==='online'?process.pid:0,pm2_env:{status:fs.readFileSync(state,'utf8'),pm_exec_path:${JSON.stringify(path.join(skillsDir,'comm-bridge/service.js'))}}}]));}
else if(args[0]==='stop') {if(${JSON.stringify(fault)}==='stop'){console.error('injected PM2 stop failure');process.exit(1);}fs.writeFileSync(state,'stopped');}
else if(args[0]==='restart'||args[0]==='startOrRestart') fs.writeFileSync(state,'online');
else if(args[0]!=='save') {console.error('unexpected fake PM2 command');process.exit(2);}
`,{mode:0o700});
  const prior=process.env.PATH;process.env.PATH=bin+path.delimiter+prior;
  t.after(()=>{process.env.PATH=prior;});
  return {root,skillsDir,tempDir,original,calls,state,packageRoot};
}

for(const fault of ['stop','snapshot']) test(`${fault} failure in default protected pipeline prevents installation and finalizer`,async t=>{
  const f=fixture(t,fault);let installerCalls=0,finalizerCalls=0;
  const result=await runUpgradeEntry({schemaVersion:1,fromVersion:'0.9.3',tempDir:f.tempDir,installedRoot:f.packageRoot,zylosDir:f.root},{
    inspect:()=>({zylosDir:f.root,skillsDir:f.skillsDir,tempDir:f.tempDir,coreDir:f.packageRoot,from:'0.9.3',to:'0.9.4',snapshotFormatVersion:2,steps:[]}),
    resolveNpm:()=>'/fixture/npm-cli.js',savePackage:()=>{},
    prepare:ctx=>prepareProtectedInstall(ctx,fault==='snapshot'?{snapshot:()=>{throw Error('injected snapshot failure');}}:{}),
    install:()=>{installerCalls++;throw Error('installer must not run');},
    finalize:()=>{finalizerCalls++;throw Error('finalizer must not run');},
  });
  assert.equal(result.preInstallProtection,true,JSON.stringify(result));
  assert.equal(result.success,false);
  const restrictedView = /(?:restricted|incomplete) process view|process view incomplete/.test(result.error);
  if (restrictedView) assert.equal(m.canRecognizeProcesses(),false);
  else assert.match(result.error,fault==='stop'?/injected PM2 stop failure/:/injected snapshot failure/);
  assert.equal(installerCalls,0);assert.equal(finalizerCalls,0);
  assert.equal(result.recovery_required,false,JSON.stringify(result));assert.equal(fs.readFileSync(f.state,'utf8'),'online');
  const journal=m.read(path.join(result.transactionDir,'journal.json'));
  assert.equal(journal.installationIntent,false);
  assert.notEqual(journal.installerStarted,true);assert.notEqual(journal.finalizerStarted,true);
  for(const [file,bytes] of f.original) assert.deepEqual(fs.readFileSync(file),bytes,file);
  const calls=fs.readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse);
  if (restrictedView) assert.equal(calls.some(args=>args[0]==='stop'),false,'incomplete process view must reject before stopping services');
  else assert.ok(calls.some(args=>args[0]==='stop'),'real stop boundary must be exercised');
});
