import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {runProtectedInstaller,resolveProtectedNpmCli} from '../self-upgrade.js';
const require=createRequire(import.meta.url),m=require('../upgrade-maintenance.cjs');
function fixture(t,body){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-installer-')),dir=path.join(root,'.backup/self-upgrade/tx');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 for(const [src,dest] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-finalizer.cjs','finalizer.cjs']]){fs.copyFileSync(path.resolve('cli/lib',src),path.join(dir,dest));fs.chmodSync(path.join(dir,dest),0o600);}fs.writeFileSync(path.join(dir,'runner.cjs'),'// fixture',{mode:0o600});
 const closure=path.join(dir,'sqlite-runtime'),files=['package.json','core-db-backup-worker.js','node_modules/better-sqlite3/lib/index.js'];
 const driverClosureHashes=files.map(file=>{const p=path.join(closure,file);fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,'fixture',{mode:0o600});return {file,bytes:fs.statSync(p).size,sha256:m.hash(p)};});
 const d={formatVersion:1,transactionId:'tx',nodePath:process.execPath,runnerPath:path.join(dir,'runner.cjs'),workerPath:path.join(closure,'core-db-backup-worker.js'),driverPath:path.join(closure,'node_modules/better-sqlite3/lib/index.js'),driverClosureRoot:closure,driverClosureHashes,hashes:Object.fromEntries(['maintenance.cjs','finalizer.cjs','runner.cjs'].map(file=>[file,m.hash(path.join(dir,file))]))};m.durable(path.join(dir,'descriptor.json'),d);
 const j={formatVersion:1,transactionId:'tx',zylosDir:root,nodePath:process.execPath,initialIdentity:{nodePath:process.execPath},phase:'installing',installationIntent:true};m.update(dir,j);
 const npmCli=path.join(root,'npm-cli.js');fs.writeFileSync(npmCli,body,{mode:0o600});const helper=require(path.join(dir,'finalizer.cjs'));
 t.after(()=>{try{const saved=m.read(path.join(dir,'journal.json'));if(saved.installerExecution)process.kill(-saved.installerExecution.pid,'SIGKILL');}catch{}fs.rmSync(root,{recursive:true,force:true});});
 return {root,dir,j,npmCli,helper,ctx:{transactionDir:dir,journal:j},read:()=>m.read(path.join(dir,'journal.json'))};
}
test('protected npm script runs under original Node and records identity before body',t=>{
 const f=fixture(t,`const fs=require('node:fs');const dir=process.argv[2];const j=JSON.parse(fs.readFileSync(dir+'/journal.json'));if(!j.installerExecution||j.installerExecution.pid!==process.pid)process.exit(9);process.stdout.write(JSON.stringify({node:process.execPath,args:process.argv.slice(2),stage:j.installerExecution.stage}));`);
 const output=runProtectedInstaller(f.ctx,{stage:'pack',npmCli:f.npmCli,args:[f.dir],cwd:f.root});const seen=JSON.parse(output);assert.equal(seen.node,process.execPath);assert.equal(seen.stage,'pack');assert.deepEqual(seen.args,[f.dir]);assert.equal(f.read().installerExitConfirmed,true);assert.equal(f.read().installerExitUnconfirmed,false);
 runProtectedInstaller(f.ctx,{stage:'install',npmCli:f.npmCli,args:[f.dir],cwd:f.root});assert.equal(f.read().installerHistory.length,1);assert.equal(f.read().installerHistory[0].launch.stage,'pack');
});
for(const exitCode of [0,2])test(`all npm exits quiesce descendants before returning (exit=${exitCode})`,t=>{
 const f=fixture(t,`const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();process.stdout.write('fixture.tgz\\n');process.exit(${exitCode});`);
 const invoke=()=>runProtectedInstaller(f.ctx,{stage:'install',npmCli:f.npmCli,args:[],cwd:f.root});if(exitCode)assert.throws(invoke,/exited 2/);else assert.match(invoke(),/fixture.tgz/);const saved=f.read();assert.equal(saved.installerExitConfirmed,true);assert.equal(f.helper.members(saved.installerExecution.pid).length,0);
});
test('npm timeout kills and verifies entire installer group before reporting failure',t=>{
 const f=fixture(t,`require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000);`);
 assert.throws(()=>runProtectedInstaller(f.ctx,{stage:'install',npmCli:f.npmCli,args:[],cwd:f.root,timeout:1500}),/ETIMEDOUT|timed out/);const saved=f.read();assert.equal(saved.installerExitConfirmed,true);assert.equal(f.helper.members(saved.installerExecution.pid).length,0);
});
test('runtime-only launcher death leaves installer identifiable and blocks until verified quiescence',async t=>{
 const f=fixture(t,`require('node:fs').writeFileSync(process.argv[2],'body-started');setInterval(()=>{},1000);`),ready=path.join(f.root,'body-started'),launcher=path.join(f.root,'launcher.mjs');
 fs.writeFileSync(launcher,`import {runProtectedInstaller} from ${JSON.stringify(pathToFileURL(path.resolve('cli/lib/self-upgrade.js')).href)};runProtectedInstaller({transactionDir:${JSON.stringify(f.dir)},journal:${JSON.stringify(f.j)}},{stage:'install',npmCli:${JSON.stringify(f.npmCli)},args:[${JSON.stringify(ready)}],cwd:${JSON.stringify(f.root)}});`);
 const parent=spawn(process.execPath,[launcher],{stdio:'ignore'});t.after(()=>{try{parent.kill('SIGKILL');}catch{}});const deadline=Date.now()+7000;while(!fs.existsSync(ready)){if(Date.now()>deadline)throw Error('npm body did not start');await new Promise(resolve=>setTimeout(resolve,20));}
 const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill('SIGKILL');await exited;const saved=f.read();assert.equal(m.alive(saved.installerLaunchIntent.parent),false);assert.equal(m.alive(saved.installerExecution),true);assert.equal(f.helper.quiesce(f.dir,saved,{kind:'installer'}).confirmed,false);
 assert.equal(f.helper.quiesce(f.dir,saved,{kind:'installer',terminate:true}).confirmed,true);assert.equal(f.helper.members(saved.installerExecution.pid).length,0);
});
test('trusted npm resolver rejects a writable or arbitrary shell wrapper',t=>{
 const f=fixture(t,'// fixture'),bin=path.join(f.root,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'npm'),'#!/bin/sh\nexit 0\n',{mode:0o700});const prior=process.env.PATH;try{process.env.PATH=bin;assert.throws(resolveProtectedNpmCli,/trusted npm-cli/);fs.unlinkSync(path.join(bin,'npm'));fs.symlinkSync(f.npmCli,path.join(bin,'npm'));assert.equal(resolveProtectedNpmCli(),f.npmCli);fs.chmodSync(f.npmCli,0o666);assert.throws(resolveProtectedNpmCli,/trusted npm-cli/);}finally{process.env.PATH=prior;}
});

test('protected installer canonicalizes a symlinked work directory before launch intent', t => {
  const f=fixture(t,"process.stdout.write(process.cwd());"),alias=f.root+'-alias';
  fs.symlinkSync(f.root,alias);
  t.after(()=>fs.unlinkSync(alias));
  const output=runProtectedInstaller(f.ctx,{stage:'pack',npmCli:f.npmCli,args:[],cwd:alias});
  assert.equal(output,f.root);
  assert.equal(f.read().installerLaunchIntent.cwd,f.root);
  assert.equal(f.read().installerExitConfirmed,true);
});
