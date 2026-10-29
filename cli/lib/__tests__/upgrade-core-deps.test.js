import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {step6_installSkillDeps} from '../self-upgrade.js';
import {saveProtectedCode} from '../upgrade-protection.js';
const require=createRequire(import.meta.url),m=require('../upgrade-maintenance.cjs');
test('protected dependency install does not touch component or user skill packages',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-core-deps-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const name of ['core-old','core-new','component','user-skill']){fs.mkdirSync(path.join(root,name));fs.writeFileSync(path.join(root,name,'package.json'),JSON.stringify({dependencies:{dependency:'1'}}));fs.writeFileSync(path.join(root,name,'package-lock.json'),'untouched');}
 const installs=[];
 const journal={skillsDir:root};
 const result=step6_installSkillDeps({upgradeProtected:true,transactionDir:'/private/tx',journal,protectedNpmCli:'/trusted/npm-cli.js',maintenance:{runInstaller:(dir,j,options)=>{assert.equal(dir,'/private/tx');assert.equal(j,journal);assert.equal(options.npmCli,'/trusted/npm-cli.js');assert.equal(options.stage,'skill-deps:'+path.basename(options.cwd));assert.equal(options.timeout,180000);assert.deepEqual(options.args,['install','--omit=dev']);installs.push(path.basename(options.cwd));}},coreManifest:[{name:'core-old'},{name:'core-new'}]}, {skillsDir:root});
 assert.equal(result.status,'done');assert.deepEqual(installs.sort(),['core-new','core-old']);
 for(const name of ['component','user-skill'])assert.equal(fs.readFileSync(path.join(root,name,'package-lock.json'),'utf8'),'untouched');
});

function fixture(t,{dependency='directory',body='process.stdout.write("installed");'}={}) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-dependency-'))),dir=path.join(root,'.backup/self-upgrade/tx'),skillsDir=path.join(root,'.claude/skills'),skill=path.join(skillsDir,'core');
 fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.mkdirSync(skill,{recursive:true});
 fs.writeFileSync(path.join(skill,'package.json'),JSON.stringify({dependencies:{dep:'v1'}}));fs.writeFileSync(path.join(skill,'code.js'),'original code');fs.chmodSync(path.join(skill,'code.js'),0o755);
 fs.mkdirSync(path.join(skill,'.zylos'));fs.writeFileSync(path.join(skill,'.zylos','state.json'),'{"source":"original"}\n');
 const outside=path.join(root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'untouched'),'outside original');
 if(dependency==='directory') {fs.mkdirSync(path.join(skill,'node_modules/dep'),{recursive:true});fs.writeFileSync(path.join(skill,'node_modules/dep/index.js'),'module.exports="v1";');fs.mkdirSync(path.join(skill,'node_modules/.bin'));fs.symlinkSync('../dep/index.js',path.join(skill,'node_modules/.bin/dep'));}
 for(const [src,dest] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-installer.cjs','installer.cjs'],['upgrade-recovery.cjs','runner.cjs']])fs.copyFileSync(path.resolve('cli/lib',src),path.join(dir,dest));
 const npmCli=path.join(root,'npm-cli.js');fs.writeFileSync(npmCli,body);
 const j={formatVersion:1,transactionId:'tx',zylosDir:root,skillsDir,nodePath:process.execPath,from:'0.9.3',phase:'preparing',installationIntent:true,initialIdentity:{ecosystemHash:null},originalServices:[],coreManifest:[{name:'core',existedBefore:true,backedUp:false,originalHash:m.treeHash(skill,{excludeNodeModules:false})}],recoveryHashes:Object.fromEntries(['maintenance.cjs','installer.cjs','runner.cjs'].map(name=>[name,m.hash(path.join(dir,name))]))};
 m.update(dir,j);
 const ctx={upgradeProtected:true,transactionDir:dir,journal:j,coreManifest:j.coreManifest,maintenance:m,protectedNpmCli:npmCli,backupDir:path.join(dir,'code')};
 saveProtectedCode(ctx);
 const recovery=require(path.join(dir,'runner.cjs')),helper=require(path.join(dir,'installer.cjs'));
 t.after(()=>{try{const saved=m.read(path.join(dir,'journal.json'));if(saved.installerPid)process.kill(-saved.installerPid,'SIGKILL');}catch{}fs.rmSync(root,{recursive:true,force:true});});
 return {root,dir,skill,j,ctx,recovery,helper,outside,read:()=>m.read(path.join(dir,'journal.json'))};
}

test('skill dependency installer is contained and cutoff-before restore returns old code and v1 dependencies',t=>{
 const f=fixture(t,{body:`const fs=require('node:fs');fs.writeFileSync('node_modules/dep/index.js','module.exports="v2";');const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();process.stdout.write('done');`});
 fs.writeFileSync(path.join(f.skill,'code.js'),'target code');
 const result=step6_installSkillDeps(f.ctx);
 assert.equal(result.status,'done',result.error);const installed=f.read();assert.equal(installed.installerStage,'skill-deps:core');assert.equal(installed.installerExitConfirmed,true);assert.equal(f.helper.members(installed.installerPid).length,0);
 assert.equal(fs.readFileSync(path.join(f.skill,'node_modules/dep/index.js'),'utf8'),'module.exports="v2";');
 f.recovery.restoreCore(f.dir,f.j);
 assert.equal(fs.readFileSync(path.join(f.skill,'code.js'),'utf8'),'original code');assert.equal(fs.readFileSync(path.join(f.skill,'node_modules/dep/index.js'),'utf8'),'module.exports="v1";');assert.equal(fs.readlinkSync(path.join(f.skill,'node_modules/.bin/dep')),'../dep/index.js');
 assert.doesNotThrow(()=>f.recovery.restoreCore(f.dir,f.j));
 fs.writeFileSync(path.join(f.skill,'node_modules/dep/index.js'),'changed after completed restore');assert.throws(()=>f.recovery.restoreCore(f.dir,f.j),/completed core restore changed/);
});

test('originally missing dependencies remove target-installed modules during compensation',t=>{
 const f=fixture(t,{dependency:'missing',body:`const fs=require('node:fs');fs.mkdirSync('node_modules/dep',{recursive:true});fs.writeFileSync('node_modules/dep/index.js','target');`});
 assert.equal(step6_installSkillDeps(f.ctx).status,'done');assert.equal(fs.existsSync(path.join(f.skill,'node_modules/dep/index.js')),true);
 f.recovery.restoreCore(f.dir,f.j);assert.equal(fs.existsSync(path.join(f.skill,'node_modules')),false);assert.doesNotThrow(()=>f.recovery.restoreCore(f.dir,f.j));
});

test('whole-skill backup includes dependencies and preserves modes and relative symlink text',t=>{
 const f=fixture(t),backup=path.join(f.dir,'code/skills/core');
 assert.equal(fs.readFileSync(path.join(backup,'node_modules/dep/index.js'),'utf8'),'module.exports="v1";');
 assert.equal(fs.readlinkSync(path.join(backup,'node_modules/.bin/dep')),'../dep/index.js');
 assert.equal(fs.statSync(path.join(backup,'code.js')).mode&0o777,0o755);
 fs.writeFileSync(path.join(f.skill,'node_modules/dep/index.js'),'target dependency');
 fs.writeFileSync(path.join(f.skill,'.zylos/state.json'),'{"source":"target"}\n');
 fs.chmodSync(path.join(f.skill,'code.js'),0o644);
 f.recovery.restoreCore(f.dir,f.j);
 assert.equal(fs.readFileSync(path.join(f.skill,'node_modules/dep/index.js'),'utf8'),'module.exports="v1";');
 assert.equal(fs.readFileSync(path.join(f.skill,'.zylos/state.json'),'utf8'),'{"source":"original"}\n');
 assert.equal(fs.readlinkSync(path.join(f.skill,'node_modules/.bin/dep')),'../dep/index.js');
 assert.equal(fs.statSync(path.join(f.skill,'code.js')).mode&0o777,0o755);
});

test('whole-skill hash covers nested node_modules but excludes mode changes',t=>{
 const f=fixture(t),backup=path.join(f.dir,'code/skills/core');
 fs.writeFileSync(path.join(backup,'node_modules/dep/index.js'),'tampered backup');
 fs.writeFileSync(path.join(f.skill,'code.js'),'target code');
 assert.throws(()=>f.recovery.restoreCore(f.dir,f.j),/invalid core backup/);
 assert.equal(fs.readFileSync(path.join(f.skill,'code.js'),'utf8'),'target code');
 const fresh=fixture(t),saved=path.join(fresh.dir,'code/skills/core/code.js');
 fs.chmodSync(saved,0o600);
 assert.doesNotThrow(()=>fresh.recovery.restoreCore(fresh.dir,fresh.j));
});

test('failed dependency installer retains its stage and stops before another launch',t=>{
 const f=fixture(t,{body:'process.exit(8);'}),second=path.join(f.j.skillsDir,'later');fs.mkdirSync(second);fs.writeFileSync(path.join(second,'package.json'),'{"dependencies":{"dep":"2"}}');f.ctx.coreManifest.push({name:'later'});
 const result=step6_installSkillDeps(f.ctx);assert.equal(result.status,'failed');assert.match(result.error,/core/);assert.equal(f.read().installerStage,'skill-deps:core');assert.equal(f.read().installerExitConfirmed,true);
});

test('dependency timeout verifies descendants exited before compensation can proceed',t=>{
 const f=fixture(t,{body:`require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000);`});
 f.ctx.maintenance={...m,runInstaller:(dir,j,options)=>{assert.equal(options.timeout,180000);return m.runInstaller(dir,j,{...options,timeout:1500});}};
 const result=step6_installSkillDeps(f.ctx);assert.equal(result.status,'failed');assert.equal(f.read().installerExitConfirmed,true);assert.equal(f.helper.members(f.read().installerPid).length,0);assert.doesNotThrow(()=>f.recovery.restoreCore(f.dir,f.j));
});
