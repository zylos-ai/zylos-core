import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
const require=createRequire(import.meta.url),modulePath=require.resolve('../upgrade-maintenance.cjs'),m=require(modulePath);
const macTest=(name,fn)=>test(name,{skip:process.platform!=='darwin'},fn);
function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mac-admission-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function contender(dir){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',`try{require(${JSON.stringify(modulePath)}).acquire(${JSON.stringify(dir)});process.stdout.write('owner');}catch(e){process.stdout.write('blocked:'+e.message);}`],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',code=>code?reject(Error(err)):resolve(out));});}
macTest('competing Mac processes admit one owner; owner death never reclaims admission',async t=>{const dir=fixture(t);const results=await Promise.all(Array.from({length:6},()=>contender(dir)));assert.equal(results.filter(s=>s==='owner').length,1);assert.equal(results.filter(s=>s.startsWith('blocked:')).length,5);const before=fs.readFileSync(path.join(dir,'controller.json'));assert.throws(()=>m.acquire(dir),/manual recovery/);assert.deepEqual(fs.readFileSync(path.join(dir,'controller.json')),before);});
