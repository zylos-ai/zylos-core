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
 const result=step6_installSkillDeps({preInstallProtection:true,coreManifest:[{name:'core-old'},{name:'core-new'}]}, {skillsDir:root,execSync:(_command,{cwd})=>installs.push(path.basename(cwd))});
 assert.equal(result.status,'done');assert.deepEqual(installs.sort(),['core-new','core-old']);
 for(const name of ['component','user-skill'])assert.equal(fs.readFileSync(path.join(root,name,'package-lock.json'),'utf8'),'untouched');
});
