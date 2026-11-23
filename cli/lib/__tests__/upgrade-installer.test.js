import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {installUpgradeTarget} from '../upgrade-entry.js';
import {step6_installSkillDeps} from '../self-upgrade.js';
const require=createRequire(import.meta.url),m=require('../upgrade-maintenance.cjs');
function fixture(t,body){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-installer-'))),dir=path.join(root,'.backup/self-upgrade/tx');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 for(const [src,dest] of [['../../skills/comm-bridge/scripts/remove-owned-tree.js','remove-owned-tree.mjs'],['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-installer.cjs','installer.cjs']]){fs.copyFileSync(path.resolve('cli/lib',src),path.join(dir,dest));fs.chmodSync(path.join(dir,dest),0o600);}fs.writeFileSync(path.join(dir,'runner.cjs'),'// fixture',{mode:0o600});
 const materialNames=['maintenance.cjs','installer.cjs','runner.cjs','remove-owned-tree.mjs'];
 const closure=path.join(dir,'sqlite-runtime'),files=['package.json','core-db-backup-worker.js','node_modules/better-sqlite3/lib/index.js'];
 const driverClosureHashes=files.map(file=>{const p=path.join(closure,file);fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,'fixture',{mode:0o600});return {file,bytes:fs.statSync(p).size,sha256:m.hash(p)};});
 const d={formatVersion:1,transactionId:'tx',nodePath:process.execPath,runnerPath:path.join(dir,'runner.cjs'),workerPath:path.join(closure,'core-db-backup-worker.js'),driverPath:path.join(closure,'node_modules/better-sqlite3/lib/index.js'),driverClosureRoot:closure,driverClosureHashes,hashes:Object.fromEntries(materialNames.map(file=>[file,m.hash(path.join(dir,file))]))};m.durable(path.join(dir,'descriptor.json'),d);
 const j={formatVersion:1,transactionId:'tx',zylosDir:root,nodePath:process.execPath,from:'0.9.3',recoveryHashes:d.hashes,initialIdentity:{nodePath:process.execPath},phase:'installing',installationIntent:true};m.update(dir,j);
 const npmCli=path.join(root,'npm-cli.js');fs.writeFileSync(npmCli,body,{mode:0o600});const helper=require(path.join(dir,'installer.cjs'));
 t.after(()=>{try{const saved=m.read(path.join(dir,'journal.json'));if(saved.installerPid)process.kill(-saved.installerPid,'SIGKILL');}catch{}fs.rmSync(root,{recursive:true,force:true});});
 return {root,dir,j,npmCli,helper,ctx:{transactionDir:dir,journal:j},read:()=>m.read(path.join(dir,'journal.json'))};
}


test('target and skill installation keep lifecycle scripts enabled',t=>{
 const f=fixture(t,''),log=path.join(f.root,'npm-calls.jsonl');
 const inheritedIgnoreScripts=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()==='npm_config_ignore_scripts'));
 for(const key of Object.keys(inheritedIgnoreScripts))delete process.env[key];
 t.after(()=>Object.assign(process.env,inheritedIgnoreScripts));
 fs.writeFileSync(f.npmCli,`const fs=require('node:fs');const journal=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(f.dir,'journal.json'))}));fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({stage:journal.installerStage,args:process.argv.slice(2),env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase().startsWith('npm_')))})+'\\n');if(process.argv[2]==='pack')process.stdout.write(JSON.stringify([{filename:'target.tgz'}]));`);
 Object.assign(f.ctx,{tempDir:f.root,protectedNpmCli:f.npmCli,maintenance:m,coreManifest:[{name:'example',existedBefore:false}]});
 installUpgradeTarget(f.ctx,{markInstallationIntent:()=>{}});
 const skills=path.join(f.root,'skills'),skill=path.join(skills,'example');
 fs.mkdirSync(skill,{recursive:true});
 fs.writeFileSync(path.join(skill,'package.json'),JSON.stringify({dependencies:{example:'1.0.0'}}));
 assert.equal(step6_installSkillDeps(f.ctx,{skillsDir:skills}).status,'done');
 const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(calls.map(call=>call.stage),['pack-target','install','skill-deps:example']);
 assert.ok(calls[0].args.includes('--ignore-scripts'),'packing deliberately disables lifecycle scripts');
 const expectedArgs=[['install','-g',path.join(f.root,'target.tgz')],['install','--omit=dev']];
 for(const [index,call] of calls.slice(1).entries()){
  assert.deepEqual(call.args,expectedArgs[index],`${call.stage} arguments`);
  assert.ok(!call.args.some(arg=>arg==='--ignore-scripts'||arg.startsWith('--ignore-scripts=')),`${call.stage} must run lifecycle scripts`);
  for(const [key,value] of Object.entries(call.env))if(key.toLowerCase()==='npm_config_ignore_scripts')assert.ok(value===''||value==='false',`${call.stage} must not disable lifecycle scripts via ${key}`);
 }
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
