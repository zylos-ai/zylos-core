import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {resolveUpgradeNpmCli,installUpgradeTarget} from '../upgrade-entry.js';
const require=createRequire(import.meta.url),m=require('../upgrade-maintenance.cjs');
const runInstaller=(ctx,options)=>m.runInstaller(ctx.transactionDir,ctx.journal,options);
function fixture(t,body){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-installer-'))),dir=path.join(root,'.backup/self-upgrade/tx');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 for(const [src,dest] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-finalizer.cjs','finalizer.cjs']]){fs.copyFileSync(path.resolve('cli/lib',src),path.join(dir,dest));fs.chmodSync(path.join(dir,dest),0o600);}fs.writeFileSync(path.join(dir,'runner.cjs'),'// fixture',{mode:0o600});
 const materialNames=['maintenance.cjs','finalizer.cjs','runner.cjs'];
 const closure=path.join(dir,'sqlite-runtime'),files=['package.json','core-db-backup-worker.js','node_modules/better-sqlite3/lib/index.js'];
 const driverClosureHashes=files.map(file=>{const p=path.join(closure,file);fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,'fixture',{mode:0o600});return {file,bytes:fs.statSync(p).size,sha256:m.hash(p)};});
 const d={formatVersion:1,transactionId:'tx',nodePath:process.execPath,runnerPath:path.join(dir,'runner.cjs'),workerPath:path.join(closure,'core-db-backup-worker.js'),driverPath:path.join(closure,'node_modules/better-sqlite3/lib/index.js'),driverClosureRoot:closure,driverClosureHashes,hashes:Object.fromEntries(materialNames.map(file=>[file,m.hash(path.join(dir,file))]))};m.durable(path.join(dir,'descriptor.json'),d);
 const j={formatVersion:1,transactionId:'tx',zylosDir:root,nodePath:process.execPath,from:'0.9.3',recoveryHashes:d.hashes,initialIdentity:{nodePath:process.execPath},phase:'installing',installationIntent:true};m.update(dir,j);
 const npmCli=path.join(root,'npm-cli.js');fs.writeFileSync(npmCli,body,{mode:0o600});const helper=require(path.join(dir,'finalizer.cjs'));
 t.after(()=>{try{const saved=m.read(path.join(dir,'journal.json'));if(saved.installerPid)process.kill(-saved.installerPid,'SIGKILL');}catch{}fs.rmSync(root,{recursive:true,force:true});});
 return {root,dir,j,npmCli,helper,ctx:{transactionDir:dir,journal:j},read:()=>m.read(path.join(dir,'journal.json'))};
}
for(const ci of [undefined,'xyz'])test(`protected npm preserves inherited CI=${ci} under original Node with durable started evidence`,t=>{
 const previous=process.env.CI;
 if(ci===undefined)delete process.env.CI;else process.env.CI=ci;
 t.after(()=>{if(previous===undefined)delete process.env.CI;else process.env.CI=previous;});
 const f=fixture(t,`const fs=require('node:fs');const dir=process.argv[2];const j=JSON.parse(fs.readFileSync(dir+'/journal.json'));if(!j.installerStarted||!Number.isSafeInteger(j.installerPid)||j.installerPid<=1||j.installerIdentity.pid!==j.installerPid||Object.hasOwn(j,'installerToken')||process.env.ZYLOS_UPGRADE_INSTALLER_TOKEN!==undefined||process.env.ZYLOS_PROTECTED_INSTALL!=='1'||process.env.ZYLOS_SKIP_POSTINSTALL!=='1'||process.env.ZYLOS_UPGRADE_FROM_VERSION!=='0.9.3')process.exit(9);process.stdout.write(JSON.stringify({node:process.execPath,args:process.argv.slice(2),stage:j.installerStage,ci:process.env.CI}));`);
 const output=runInstaller(f.ctx,{stage:'pack',npmCli:f.npmCli,args:[f.dir],cwd:f.root});const seen=JSON.parse(output);assert.equal(seen.node,process.execPath);assert.equal(seen.stage,'pack');assert.equal(seen.ci,process.env.CI);assert.deepEqual(seen.args,[f.dir]);assert.equal(f.read().installerExitConfirmed,true);assert.equal(f.read().installerExitUnconfirmed,false);
 runInstaller(f.ctx,{stage:'install',npmCli:f.npmCli,args:[f.dir],cwd:f.root});assert.equal(f.read().installerStage,'install');
 const restored=JSON.parse(runInstaller(f.ctx,{stage:'restore-original-package',npmCli:f.npmCli,args:[f.dir],cwd:f.root}));assert.equal(restored.ci,process.env.CI);
});
for(const exitCode of [0,2])test(`all npm exits quiesce descendants before returning (exit=${exitCode})`,t=>{
 const f=fixture(t,`const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();process.stdout.write('fixture.tgz\\n');process.exit(${exitCode});`);
 const invoke=()=>runInstaller(f.ctx,{stage:'install',npmCli:f.npmCli,args:[],cwd:f.root});if(exitCode)assert.throws(invoke,/npm install failed/);else assert.match(invoke(),/fixture.tgz/);const saved=f.read();assert.equal(saved.installerExitConfirmed,true);assert.equal(f.helper.members(saved.installerPid).length,0);
});
test('npm timeout kills and verifies entire installer group before reporting failure',t=>{
 const f=fixture(t,`require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000);`);
 assert.throws(()=>runInstaller(f.ctx,{stage:'install',npmCli:f.npmCli,args:[],cwd:f.root,timeout:1500}),/ETIMEDOUT|timed out/);const saved=f.read();assert.equal(saved.installerExitConfirmed,true);assert.equal(f.helper.members(saved.installerPid).length,0);
});
for (const beforeDescriptor of [false,true]) test(`controller death retains recoverable installer identity (beforeDescriptor=${beforeDescriptor})`,async t=>{
 const f=fixture(t,`require('node:fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`),ready=path.join(f.root,'body-started'),launcher=path.join(f.root,'launcher.mjs');
 if (beforeDescriptor) fs.unlinkSync(path.join(f.dir,'descriptor.json'));
 fs.writeFileSync(launcher,`import {createRequire} from 'node:module';const m=createRequire(import.meta.url)(${JSON.stringify(path.resolve('cli/lib/upgrade-maintenance.cjs'))});m.runInstaller(${JSON.stringify(f.dir)},${JSON.stringify(f.j)},{stage:'install',npmCli:${JSON.stringify(f.npmCli)},args:[${JSON.stringify(ready)}],cwd:${JSON.stringify(f.root)}});`);
 const parent=spawn(process.execPath,[launcher],{stdio:'ignore'});t.after(()=>{try{parent.kill('SIGKILL');}catch{}});const deadline=Date.now()+7000;while(!fs.existsSync(ready)){if(Date.now()>deadline)throw Error('npm body did not start');await new Promise(resolve=>setTimeout(resolve,20));}
 const npmPid=Number(fs.readFileSync(ready,'utf8'));
 const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill('SIGKILL');await exited;const saved=f.read();
 assert.equal(saved.installerStarted,true);assert.ok(saved.installerPid>1);assert.notEqual(saved.installerPid,npmPid);assert.equal(saved.installerIdentity.pid,saved.installerPid);assert.ok(f.helper.members(saved.installerPid).length);
 m.verifyFinalizerExit(f.dir,saved);
 assert.equal(f.read().installerExitConfirmed,true);
 assert.equal(f.helper.members(saved.installerPid).length,0);
});

test('interruption before launcher identity publication stays fail closed without descriptor',t=>{
 const f=fixture(t,'// not launched');fs.unlinkSync(path.join(f.dir,'descriptor.json'));
 m.update(f.dir,f.j,{installerStarted:true,installerPid:null,installerExitConfirmed:false});
 assert.throws(()=>m.verifyFinalizerExit(f.dir,f.j),/interrupted launch/);
 assert.notEqual(f.read().installerExitConfirmed,true);
});

test('dead installer leader with surviving members requires manual recovery without signalling them',async t=>{
 const f=fixture(t,`require('node:fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`),ready=path.join(f.root,'started'),launcher=path.join(f.root,'controller.mjs');
 fs.writeFileSync(launcher,`import {createRequire} from 'node:module';const m=createRequire(import.meta.url)(${JSON.stringify(path.resolve('cli/lib/upgrade-maintenance.cjs'))});m.runInstaller(${JSON.stringify(f.dir)},${JSON.stringify(f.j)},{stage:'install',npmCli:${JSON.stringify(f.npmCli)},args:[${JSON.stringify(ready)}],cwd:${JSON.stringify(f.root)}});`);
 const controller=spawn(process.execPath,[launcher],{stdio:'ignore'});
 t.after(()=>{try{controller.kill('SIGKILL');}catch{}});
 const deadline=Date.now()+7000;
 while(!fs.existsSync(ready)){if(Date.now()>deadline)throw Error('npm did not start');await new Promise(resolve=>setTimeout(resolve,20));}
 const saved=f.read(),npmPid=Number(fs.readFileSync(ready,'utf8'));
 const exited=new Promise(resolve=>controller.once('exit',resolve));controller.kill('SIGKILL');await exited;
 process.kill(saved.installerPid,'SIGKILL');
 while(!m.identity(saved.installerPid).absent && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
 const result=f.helper.quiesce(f.dir,saved,{terminate:true});
 assert.equal(result.confirmed,false);assert.match(result.error,/manual recovery/);
 assert.doesNotThrow(()=>process.kill(npmPid,0));
 assert.throws(()=>m.verifyFinalizerExit(f.dir,saved),/manual recovery/);
 assert.notEqual(f.read().installerExitConfirmed,true);
});

test('pre-descriptor exit verification rejects changed frozen material',t=>{
 const f=fixture(t,'// not launched');fs.unlinkSync(path.join(f.dir,'descriptor.json'));
 m.update(f.dir,f.j,{installerStarted:true,installerPid:null,installerExitConfirmed:false});
 fs.appendFileSync(path.join(f.dir,'finalizer.cjs'),'// changed');
 assert.throws(()=>m.verifyFinalizerExit(f.dir,f.j),/transaction recovery material changed/);
});

test('installer PID reuse is rejected before signalling an unrelated group',t=>{
 const f=fixture(t,'// not launched');
 const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
 t.after(()=>{try{process.kill(-unrelated.pid,'SIGKILL');}catch{}});
 const j={installerStarted:true,installerPid:unrelated.pid,installerIdentity:{pid:unrelated.pid,start:'wrong',boot:'wrong'}};
 assert.equal(f.helper.quiesce(f.dir,j,{kind:'installer',terminate:true}).confirmed,false);
 assert.equal(f.helper.quiesce(f.dir,{...j,installerIdentity:null},{kind:'installer',terminate:true}).confirmed,false);
 assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
});
test('trusted npm resolver accepts readable modes 775 and 644 but rejects wrappers, unreadable and non-files',t=>{
 const f=fixture(t,'// fixture'),bin=path.join(f.root,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'npm'),'#!/bin/sh\nexit 0\n',{mode:0o700});const prior=process.env.PATH;
 try{
  process.env.PATH=bin;
  assert.throws(resolveUpgradeNpmCli,/trusted npm-cli/);
  fs.unlinkSync(path.join(bin,'npm'));fs.symlinkSync(f.npmCli,path.join(bin,'npm'));
  fs.chmodSync(f.npmCli,0o775);assert.equal(resolveUpgradeNpmCli(),f.npmCli);
  fs.chmodSync(f.npmCli,0o644);assert.equal(resolveUpgradeNpmCli(),f.npmCli);
  fs.chmodSync(f.npmCli,0o000);
  if(process.geteuid?.()!==0)assert.throws(resolveUpgradeNpmCli,/trusted npm-cli/);
  fs.unlinkSync(f.npmCli);fs.mkdirSync(f.npmCli);
  assert.throws(resolveUpgradeNpmCli,/trusted npm-cli/);
 }finally{process.env.PATH=prior;}
});

test('npm resolver accepts a readable executable owned by another user',t=>{
 const f=fixture(t,'// fixture'),bin=path.join(f.root,'bin');fs.mkdirSync(bin);fs.symlinkSync(f.npmCli,path.join(bin,'npm'));fs.chmodSync(f.npmCli,0o755);
 const prior=process.env.PATH,statSync=fs.statSync;
 t.mock.method(fs,'statSync',(file,...args)=>{const stat=statSync(file,...args);if(file===f.npmCli)stat.uid=-1;return stat;});
 try{process.env.PATH=bin;assert.equal(resolveUpgradeNpmCli(),f.npmCli);}finally{process.env.PATH=prior;}
});

test('protected installation uses the preflight npm path after its PATH entry changes',t=>{
 const f=fixture(t,"if(process.argv[2]==='pack')process.stdout.write(JSON.stringify([{filename:'fixture.tgz'}]));");
 const bin=path.join(f.root,'bin');fs.mkdirSync(bin);fs.symlinkSync(f.npmCli,path.join(bin,'npm'));fs.chmodSync(f.npmCli,0o644);
 const prior=process.env.PATH;
 try{
  process.env.PATH=bin+path.delimiter+prior;
  f.ctx.protectedNpmCli=resolveUpgradeNpmCli();
  fs.unlinkSync(path.join(bin,'npm'));fs.writeFileSync(path.join(bin,'npm'),'#!/bin/sh\nexit 1\n',{mode:0o700});
  f.ctx.tempDir=f.root;f.ctx.maintenance=m;
  installUpgradeTarget(f.ctx,{markInstallationIntent:()=>{}});
  assert.equal(f.read().installerStage,'install');assert.equal(f.read().installerExitConfirmed,true);
 }finally{process.env.PATH=prior;}
});

test('transaction installer launches through an aliased work directory', t => {
  const f=fixture(t,"process.stdout.write(process.cwd());"),alias=f.root+'-alias';
  fs.symlinkSync(f.root,alias);
  t.after(()=>fs.unlinkSync(alias));
  const output=runInstaller(f.ctx,{stage:'pack',npmCli:f.npmCli,args:[],cwd:alias});
  assert.equal(output,f.root);
  assert.equal(f.read().installerStarted,true);
  assert.equal(f.read().installerExitConfirmed,true);
});

for(const name of ['runner.cjs','maintenance.cjs','finalizer.cjs']) for(const damage of ['missing','changed']) {
 test(`transaction installer rejects ${damage} ${name} before recording launch`,t=>{
  const f=fixture(t,"process.stdout.write('unexpected');");
  const file=path.join(f.dir,name);
  if(damage==='missing')fs.unlinkSync(file);else fs.appendFileSync(file,'// changed');
  assert.throws(()=>runInstaller(f.ctx,{stage:'install',npmCli:f.npmCli,args:[],cwd:f.root}),damage==='missing'?/ENOENT/:/transaction recovery material changed/);
  assert.notEqual(f.read().installerStarted,true);
 });
}
