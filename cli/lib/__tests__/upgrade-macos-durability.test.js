import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url),modulePath=require.resolve('../upgrade-maintenance.cjs'),m=require(modulePath);
const mac={skip:process.platform!=='darwin'};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mac-durability-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('macOS fullsync failure cannot publish a new journal',mac,t=>{
 const dir=fixture(t),file=path.join(dir,'journal.json');fs.writeFileSync(file,'original');
 const result=spawnSync(process.execPath,['-e',`
 const cp=require('node:child_process'),spawn=cp.spawnSync;
 cp.spawnSync=(bin,args,...rest)=>args[0]==='fullsync'?{status:1,stderr:'injected fullsync failure'}:spawn(bin,args,...rest);
 require(${JSON.stringify(modulePath)}).durable(${JSON.stringify(file)},{phase:'installed'});
 `],{encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/injected fullsync failure/);assert.equal(fs.readFileSync(file,'utf8'),'original');
});
test('macOS directory publication sync failure propagates after rename',mac,t=>{
 const dir=fixture(t),file=path.join(dir,'journal.json');
 const result=spawnSync(process.execPath,['-e',`
 const cp=require('node:child_process'),spawn=cp.spawnSync;let calls=0;
 cp.spawnSync=(bin,args,...rest)=>args[0]==='fullsync'&&++calls===2?{status:1,stderr:'injected directory sync failure'}:spawn(bin,args,...rest);
 require(${JSON.stringify(modulePath)}).durable(${JSON.stringify(file)},{phase:'prepared'});
 `],{encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/injected directory sync failure/);
 assert.equal(JSON.parse(fs.readFileSync(file)).phase,'prepared');
});
test('frozen maintenance never falls back to the installed native helper',mac,t=>{
 const dir=fixture(t),saved=path.join(dir,'maintenance.cjs');fs.copyFileSync(modulePath,saved);
 const result=spawnSync(process.execPath,['-e',`require(${JSON.stringify(saved)}).fsyncDir(${JSON.stringify(dir)});`],{encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/ENOENT/);
});
test('macOS native identity query failure cannot authorize takeover',mac,t=>{
 const dir=fixture(t),lock=path.join(dir,'controller.json');m.durable(lock,m.identity());const before=fs.readFileSync(lock,'utf8');
 const result=spawnSync(process.execPath,['-e',`
 const cp=require('node:child_process'),spawn=cp.spawnSync;
 cp.spawnSync=(bin,args,...rest)=>args[0]==='identity'?{status:1,stderr:'query denied'}:spawn(bin,args,...rest);
 require(${JSON.stringify(modulePath)}).acquire(${JSON.stringify(dir)});
 `],{encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/identity verification unsupported/);assert.equal(fs.readFileSync(lock,'utf8'),before);
});

test('macOS old-owner query failure under the kernel lock cannot replace its controller',mac,t=>{
 const dir=fixture(t),lock=path.join(dir,'controller.json');m.durable(lock,m.identity());
 const before=fs.readFileSync(lock,'utf8'),hook=path.join(dir,'query-fault.cjs');
 fs.writeFileSync(hook,`
 const cp=require('node:child_process'),spawn=cp.spawnSync;
 cp.spawnSync=(bin,args,...rest)=>args[0]==='identity'&&args[1]===${JSON.stringify(String(process.pid))}
   ?{status:1,stderr:'old owner query denied'}:spawn(bin,args,...rest);
 `);
 const result=spawnSync(process.execPath,['-e',`require(${JSON.stringify(modulePath)}).acquire(${JSON.stringify(dir)});`],{
   encoding:'utf8',env:{...process.env,NODE_OPTIONS:`--require=${hook}`}
 });
 assert.notEqual(result.status,0);assert.match(result.stderr,/controller process identity query failed/);
 assert.equal(fs.readFileSync(lock,'utf8'),before);
});
