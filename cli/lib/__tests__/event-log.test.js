import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appendEvent, rotateEventLog, EventLogReader } from '../event-log.js';
function fixture(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'event-log-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'events.jsonl');}
test('reader finishes old inode, intermediate rotations, then current exactly once',t=>{
 const file=fixture(t), reader=new EventLogReader(file);t.after(()=>reader.close());
 appendEvent(file,{v:1,n:1});assert.deepEqual(reader.read().map(x=>x.n),[1]);
 appendEvent(file,{v:1,n:2});rotateEventLog(file,{maxBytes:0,now:100});
 appendEvent(file,{v:1,n:3});rotateEventLog(file,{maxBytes:0,now:100});
 appendEvent(file,{v:1,n:4});assert.deepEqual(reader.read().map(x=>x.n),[2,3,4]);assert.deepEqual(reader.read(),[]);
});
test('incomplete lines wait, malformed complete lines warn, future fields survive',t=>{
 const file=fixture(t),warnings=[],reader=new EventLogReader(file,{warn:x=>warnings.push(x)});t.after(()=>reader.close());
 fs.writeFileSync(file,'{"v":1,"n":');assert.deepEqual(reader.read(),[]);
 fs.appendFileSync(file,'1}\nBAD\n{"v":2,"n":2,"future":true}\n');assert.deepEqual(reader.read().map(x=>x.n),[1,2]);assert.deepEqual(warnings,['event_log_invalid_line','event_log_new_version']);
});

test('two real writers each append 200 complete lines during rotations',async t=>{
 const file=fixture(t);
 const worker=`import {appendEvent} from ${JSON.stringify(new URL('../event-log.js',import.meta.url).href)};
 await new Promise(resolve=>{process.once('message',resolve);process.send('ready');});
 for(let n=0;n<200;n++)appendEvent(process.argv[1],{writer:process.argv[2],n,payload:'x'.repeat(100*1024)});
 process.disconnect();`;
 const run=writer=>{
  const child=spawn(process.execPath,['--input-type=module','-e',worker,file,writer],{stdio:['ignore','ignore','pipe','ipc']});
  t.after(()=>{if(child.exitCode===null && child.signalCode===null)child.kill();});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  const ready=new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('writer exited before ready')));});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(stderr)));});
  return {child,ready,done};
 };
 const writers=[run('a'),run('b')];
 await Promise.all(writers.map(writer=>writer.ready));
 const timer=setInterval(()=>rotateEventLog(file,{maxBytes:1024*1024}),10);
 try{for(const writer of writers)writer.child.send('start');await Promise.all(writers.map(writer=>writer.done));}finally{clearInterval(timer);}
 const warnings=[],reader=new EventLogReader(file,{warn:x=>warnings.push(x)});t.after(()=>reader.close());const rows=reader.read();
 assert.equal(rows.length,400,JSON.stringify(fs.readdirSync(path.dirname(file)).map(name=>({name,size:fs.statSync(path.join(path.dirname(file),name)).size}))) );assert.equal(new Set(rows.map(row=>`${row.writer}:${row.n}`)).size,400);assert.deepEqual(warnings,[]);
 for(const row of rows){assert.ok(['a','b'].includes(row.writer));assert.ok(Number.isInteger(row.n) && row.n>=0 && row.n<200);assert.equal(row.payload,'x'.repeat(100*1024));}
});
