import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {step6_installSkillDeps} from '../self-upgrade.js';
test('protected dependency install does not touch component or user skill packages',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-core-deps-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const name of ['core-old','core-new','component','user-skill']){fs.mkdirSync(path.join(root,name));fs.writeFileSync(path.join(root,name,'package.json'),JSON.stringify({dependencies:{dependency:'1'}}));fs.writeFileSync(path.join(root,name,'package-lock.json'),'untouched');}
 const installs=[];
 const journal={skillsDir:root};
 const result=step6_installSkillDeps({upgradeProtected:true,transactionDir:'/private/tx',journal,protectedNpmCli:'/trusted/npm-cli.js',maintenance:{runInstaller:(dir,j,options)=>{assert.equal(dir,'/private/tx');assert.equal(j,journal);assert.equal(options.npmCli,'/trusted/npm-cli.js');assert.equal(options.stage,'skill-deps:'+path.basename(options.cwd));assert.equal(options.timeout,180000);assert.deepEqual(options.args,['install','--omit=dev']);installs.push(path.basename(options.cwd));}},coreManifest:[{name:'core-old'},{name:'core-new'}]}, {skillsDir:root});
 assert.equal(result.status,'done');assert.deepEqual(installs.sort(),['core-new','core-old']);
 for(const name of ['component','user-skill'])assert.equal(fs.readFileSync(path.join(root,name,'package-lock.json'),'utf8'),'untouched');
});
