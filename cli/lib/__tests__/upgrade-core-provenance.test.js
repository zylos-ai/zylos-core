import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url),m=require('../upgrade-maintenance.cjs');
test('core restore preserves relative symlink text and existing node_modules',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-links-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const src=path.join(root,'backup'),dest=path.join(root,'core');fs.mkdirSync(src);fs.mkdirSync(path.join(dest,'node_modules'),{recursive:true});
 fs.writeFileSync(path.join(src,'target'),'original');fs.symlinkSync('target',path.join(src,'alias'));fs.writeFileSync(path.join(dest,'node_modules','cached'),'keep');fs.writeFileSync(path.join(dest,'changed'),'new');
 m.sync(src,dest);assert.equal(fs.readlinkSync(path.join(dest,'alias')),'target');assert.equal(m.treeHash(dest),m.treeHash(src));assert.equal(fs.readFileSync(path.join(dest,'node_modules','cached'),'utf8'),'keep');
});
for(const dangling of [false,true])test(`new core ownership rejects ${dangling?'dangling':'resolved'} metadata symlink without writing outside transaction`,t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-owner-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const incoming=path.join(root,'incoming'),outside=path.join(root,'outside'),dir=path.join(root,'tx'),skills=path.join(root,'.claude/skills');
 fs.mkdirSync(path.join(incoming,'new-core'),{recursive:true});fs.mkdirSync(dir);fs.mkdirSync(skills,{recursive:true});if(!dangling)fs.mkdirSync(outside);
 fs.symlinkSync(outside,path.join(incoming,'new-core','.zylos'));m.durable(path.join(dir,'journal.json'),{transactionId:'tx'});
 const source=new URL('../self-upgrade.js',import.meta.url).href;
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {syncCoreSkills} from ${JSON.stringify(source)};console.log(JSON.stringify(syncCoreSkills(${JSON.stringify(incoming)},null,{transactionId:'tx',transactionDir:${JSON.stringify(dir)}})));`],{encoding:'utf8',env:{...process.env,ZYLOS_DIR:root}});
 assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).errors.length,1);assert.equal(fs.existsSync(path.join(outside,'upgrade-owner.json')),false);assert.equal(fs.existsSync(path.join(skills,'new-core')),false);
});
