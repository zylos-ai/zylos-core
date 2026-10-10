import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url),modulePath=require.resolve('../upgrade-maintenance.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'node-durability-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('Node file sync failure cannot publish a new journal',t=>{
 const dir=fixture(t),file=path.join(dir,'journal.json');fs.writeFileSync(file,'original');
 const result=spawnSync(process.execPath,['-e',`
 const fs=require('node:fs');
 fs.fsyncSync=()=>{throw Error('injected file sync failure');};
 require(${JSON.stringify(modulePath)}).durable(${JSON.stringify(file)},{phase:'installed'});
 `],{encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/injected file sync failure/);assert.equal(fs.readFileSync(file,'utf8'),'original');
});
test('Node directory publication sync failure propagates after rename',t=>{
 const dir=fixture(t),file=path.join(dir,'journal.json');
 const result=spawnSync(process.execPath,['-e',`
 const fs=require('node:fs'),sync=fs.fsyncSync;
 fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory())throw Error('injected directory sync failure');return sync(fd);};
 require(${JSON.stringify(modulePath)}).durable(${JSON.stringify(file)},{phase:'prepared'});
 `],{encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/injected directory sync failure/);
 assert.equal(JSON.parse(fs.readFileSync(file)).phase,'prepared');
});
test('frozen maintenance publishes file then directory using only Node sync',t=>{
 const dir=fixture(t),saved=path.join(dir,'maintenance.cjs'),file=path.join(dir,'journal.json');fs.copyFileSync(modulePath,saved);
 const result=spawnSync(process.execPath,['-e',`
 const fs=require('node:fs'),cp=require('node:child_process'),sync=fs.fsyncSync,events=[];
 cp.spawnSync=()=>{throw Error('unexpected external helper');};
 fs.fsyncSync=fd=>{events.push({kind:fs.fstatSync(fd).isDirectory()?'directory':'file',published:fs.existsSync(${JSON.stringify(file)})});return sync(fd);};
 require(${JSON.stringify(saved)}).durable(${JSON.stringify(file)},{phase:'prepared'});
 process.stdout.write(JSON.stringify(events));
 `],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout),[{kind:'file',published:false},{kind:'directory',published:true}]);
 assert.equal(JSON.parse(fs.readFileSync(file)).phase,'prepared');
});
