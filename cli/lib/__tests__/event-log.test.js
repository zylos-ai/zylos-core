import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appendEvent, rotateEventLog, EventLogReader } from '../event-log.js';
function fixture(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'event-log-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'events.jsonl');}
test('IF-31: reader finishes old inode, intermediate rotations, then current exactly once',t=>{
 const file=fixture(t), reader=new EventLogReader(file);t.after(()=>reader.close());
 appendEvent(file,{v:1,n:1});assert.deepEqual(reader.read().map(x=>x.n),[1]);
 appendEvent(file,{v:1,n:2});rotateEventLog(file,{maxBytes:0,now:100});
 appendEvent(file,{v:1,n:3});rotateEventLog(file,{maxBytes:0,now:100});
 appendEvent(file,{v:1,n:4});assert.deepEqual(reader.read().map(x=>x.n),[2,3,4]);assert.deepEqual(reader.read(),[]);
});
test('IF-31: incomplete lines wait, malformed complete lines warn, future fields survive',t=>{
 const file=fixture(t),warnings=[],reader=new EventLogReader(file,{warn:x=>warnings.push(x)});t.after(()=>reader.close());
 fs.writeFileSync(file,'{"v":1,"n":');assert.deepEqual(reader.read(),[]);
 fs.appendFileSync(file,'1}\nBAD\n{"v":2,"n":2,"future":true}\n');assert.deepEqual(reader.read().map(x=>x.n),[1,2]);assert.deepEqual(warnings,['event_log_invalid_line','event_log_new_version']);
});
test('IF-31: directory disappearance drains retained fd without fabricating events',t=>{
 const file=fixture(t),reader=new EventLogReader(file);t.after(()=>reader.close());appendEvent(file,{n:1});reader.read();appendEvent(file,{n:2});
 fs.rmSync(path.dirname(file),{recursive:true});assert.deepEqual(reader.read(),[{n:2}]);assert.deepEqual(reader.read(),[]);
});
test('DM-38: append and rename preserve complete long records and monotonic names',t=>{
 const file=fixture(t),reader=new EventLogReader(file);t.after(()=>reader.close());const payload='多'.repeat(50000);
 appendEvent(file,{n:1,payload});const first=rotateEventLog(file,{maxBytes:1,now:200});appendEvent(file,{n:2,payload});const second=rotateEventLog(file,{maxBytes:1,now:100});
 assert.match(first,/events\.200\.jsonl$/);assert.match(second,/events\.201\.jsonl$/);assert.deepEqual(reader.read(),[{n:1,payload},{n:2,payload}]);
});

test('DM-38: two real writers each append 200 complete lines during rotations',async t=>{
 const file=fixture(t);
 const worker=`import {appendEvent} from ${JSON.stringify(new URL('../event-log.js',import.meta.url).href)};for(let n=0;n<200;n++)appendEvent(process.argv[1],{writer:process.argv[2],n,payload:'x'.repeat(8192)});`;
 const run=writer=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',worker,file,writer],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(stderr)));});
 const timer=setInterval(()=>rotateEventLog(file,{maxBytes:1024*1024}),10);
 try{await Promise.all([run('a'),run('b')]);}finally{clearInterval(timer);}
 const warnings=[],reader=new EventLogReader(file,{warn:x=>warnings.push(x)});t.after(()=>reader.close());const rows=reader.read();
 assert.equal(rows.length,400,JSON.stringify(fs.readdirSync(path.dirname(file)).map(name=>({name,size:fs.statSync(path.join(path.dirname(file),name)).size}))) );assert.equal(new Set(rows.map(row=>`${row.writer}:${row.n}`)).size,400);assert.deepEqual(warnings,[]);
 for(const row of rows){assert.ok(['a','b'].includes(row.writer));assert.ok(Number.isInteger(row.n) && row.n>=0 && row.n<200);assert.equal(row.payload,'x'.repeat(8192));}
});

test('DM-38 regression: maintenance never treats current filename as rotation timestamp zero',t=>{
 const file=fixture(t);appendEvent(file,{n:1});rotateEventLog(file,{maxBytes:1024,now:1700000000000});assert.equal(fs.existsSync(file),true);
 const reader=new EventLogReader(file);t.after(()=>reader.close());assert.deepEqual(reader.read(),[{n:1}]);
});

test('T08 recovery: backward UTF-8 chunk scan stops at boundary and resumes partial/current rotation once',t=>{
 const file=fixture(t),reader=new EventLogReader(file);t.after(()=>reader.close());
 appendEvent(file,{n:0});rotateEventLog(file,{maxBytes:0,now:100});
 appendEvent(file,{n:1});appendEvent(file,{n:2,payload:'多'.repeat(30000)});fs.appendFileSync(file,'{"n":');
 let visited=0;const rows=reader.recoverTail(row=>{visited++;return {keep:true,done:row.n===1};});
 assert.deepEqual(rows.map(row=>row.n),[1,2]);assert.equal(rows[1].payload,'多'.repeat(30000));assert.equal(visited,2);
 fs.appendFileSync(file,'3}\n');rotateEventLog(file,{maxBytes:0,now:101});appendEvent(file,{n:4});
 assert.deepEqual(reader.read().map(row=>row.n),[3,4]);assert.deepEqual(reader.read(),[]);
});

// DM-38: force an appender holding the old inode to finish after the reader's
// first size snapshot. The second read at handoff must include this late line.
test('DM-38: reader drains a late append on the renamed inode before switching',t=>{
 const file=fixture(t),reader=new EventLogReader(file);t.after(()=>reader.close());
 appendEvent(file,{n:1});assert.deepEqual(reader.read(),[{n:1}]);
 const writer=fs.openSync(file,'a');t.after(()=>fs.closeSync(writer));
 rotateEventLog(file,{maxBytes:0,now:100});appendEvent(file,{n:3});
 const oldFd=reader.fd,stat=fs.fstatSync;let late=true;
 t.mock.method(fs,'fstatSync',fd=>{
  const snapshot=stat(fd);
  if(fd===oldFd && late){late=false;fs.appendFileSync(writer,'{"n":2}\n');}
  return snapshot;
 });
 assert.deepEqual(reader.read(),[{n:2},{n:3}]);assert.equal(late,false);
 assert.deepEqual(reader.read(),[]);
});

test('DM-38: a failed partial line is skipped with warning at rotation handoff',t=>{
 const file=fixture(t),warnings=[],reader=new EventLogReader(file,{warn:x=>warnings.push(x)});t.after(()=>reader.close());
 appendEvent(file,{n:1});assert.deepEqual(reader.read(),[{n:1}]);
 fs.appendFileSync(file,'{"n":');
 assert.deepEqual(reader.read(),[]);assert.deepEqual(warnings,[]);
 rotateEventLog(file,{maxBytes:0,now:100});appendEvent(file,{n:2});
 assert.deepEqual(reader.read(),[{n:2}]);assert.deepEqual(warnings,['event_log_invalid_line']);
 assert.deepEqual(reader.read(),[]);
});
