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
test('directory disappearance drains retained fd without fabricating events',t=>{
 const file=fixture(t),reader=new EventLogReader(file);t.after(()=>reader.close());appendEvent(file,{n:1});reader.read();appendEvent(file,{n:2});
 fs.rmSync(path.dirname(file),{recursive:true});assert.deepEqual(reader.read(),[{n:2}]);assert.deepEqual(reader.read(),[]);
});
test('append and rename preserve complete long records and monotonic names',t=>{
 const file=fixture(t),reader=new EventLogReader(file);t.after(()=>reader.close());const payload='多'.repeat(50000);
 appendEvent(file,{n:1,payload});const first=rotateEventLog(file,{maxBytes:1,now:200});appendEvent(file,{n:2,payload});const second=rotateEventLog(file,{maxBytes:1,now:100});
 assert.match(first,/events\.200\.jsonl$/);assert.match(second,/events\.201\.jsonl$/);assert.deepEqual(reader.read(),[{n:1,payload},{n:2,payload}]);
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

test('regression: maintenance never treats current filename as rotation timestamp zero',t=>{
 const file=fixture(t);appendEvent(file,{n:1});rotateEventLog(file,{maxBytes:1024,now:1700000000000});assert.equal(fs.existsSync(file),true);
 const reader=new EventLogReader(file);t.after(()=>reader.close());assert.deepEqual(reader.read(),[{n:1}]);
});

test('recovery: backward UTF-8 chunk scan stops at boundary and resumes partial/current rotation once',t=>{
 const file=fixture(t),reader=new EventLogReader(file);t.after(()=>reader.close());
 appendEvent(file,{n:0});rotateEventLog(file,{maxBytes:0,now:100});
 appendEvent(file,{n:1});appendEvent(file,{n:2,payload:'多'.repeat(30000)});fs.appendFileSync(file,'{"n":');
 let visited=0;const rows=reader.recoverTail(row=>{visited++;return {keep:true,done:row.n===1};});
 assert.deepEqual(rows.map(row=>row.n),[1,2]);assert.equal(rows[1].payload,'多'.repeat(30000));assert.equal(visited,2);
 fs.appendFileSync(file,'3}\n');rotateEventLog(file,{maxBytes:0,now:101});appendEvent(file,{n:4});
 assert.deepEqual(reader.read().map(row=>row.n),[3,4]);assert.deepEqual(reader.read(),[]);
});

// the writer can finish after the handoff read has returned.
test('next read drains a late append on the renamed inode exactly once',t=>{
 const file=fixture(t),reader=new EventLogReader(file);t.after(()=>reader.close());
 appendEvent(file,{n:1});assert.deepEqual(reader.read(),[{n:1}]);
 const writer=fs.openSync(file,'a');t.after(()=>fs.closeSync(writer));
 rotateEventLog(file,{maxBytes:0,now:100});appendEvent(file,{n:3});
 assert.deepEqual(reader.read(),[{n:3}]);
 fs.appendFileSync(writer,'{"n":2}\n');appendEvent(file,{n:4});
 assert.deepEqual(reader.read(),[{n:2},{n:4}]);assert.deepEqual(reader.read(),[]);
});

test('partial old-inode write can finish before the next read without warning',t=>{
 const file=fixture(t),warnings=[],reader=new EventLogReader(file,{warn:x=>warnings.push(x)});t.after(()=>reader.close());
 appendEvent(file,{n:1});assert.deepEqual(reader.read(),[{n:1}]);
 const writer=fs.openSync(file,'a');t.after(()=>fs.closeSync(writer));
 rotateEventLog(file,{maxBytes:0,now:100});appendEvent(file,{n:3});fs.appendFileSync(writer,'{"n":');
 assert.deepEqual(reader.read(),[{n:3}]);assert.deepEqual(warnings,[]);
 fs.appendFileSync(writer,'2}\n');
 assert.deepEqual(reader.read(),[{n:2}]);assert.deepEqual(reader.read(),[]);assert.deepEqual(warnings,[]);
});

test('abandoned partial line warns only at next-read final drain',t=>{
 const file=fixture(t),warnings=[],reader=new EventLogReader(file,{warn:x=>warnings.push(x)});t.after(()=>reader.close());
 appendEvent(file,{n:1});assert.deepEqual(reader.read(),[{n:1}]);fs.appendFileSync(file,'{"n":');
 assert.deepEqual(reader.read(),[]);assert.deepEqual(warnings,[]);
 rotateEventLog(file,{maxBytes:0,now:100});appendEvent(file,{n:2});
 assert.deepEqual(reader.read(),[{n:2}]);assert.deepEqual(warnings,[]);
 assert.deepEqual(reader.read(),[]);assert.deepEqual(warnings,['event_log_invalid_line']);
 assert.deepEqual(reader.read(),[]);assert.deepEqual(warnings,['event_log_invalid_line']);
});

test('close releases current and deferred old descriptors',t=>{
 const file=fixture(t),reader=new EventLogReader(file);t.after(()=>reader.close());
 appendEvent(file,{n:1});reader.read();const old=reader.fd;
 rotateEventLog(file,{maxBytes:0,now:100});appendEvent(file,{n:2});reader.read();const current=reader.fd;
 assert.doesNotThrow(()=>fs.fstatSync(old));reader.close();
 for(const fd of [old,current])assert.throws(()=>fs.fstatSync(fd),{code:'EBADF'});
});

test('appendEvent surfaces a real write failure and later complete writes remain readable',t=>{
 const file=fixture(t),reader=new EventLogReader(file);t.after(()=>reader.close());
 appendEvent(file,{n:1});
 // /dev/full opens normally but its actual write fails with ENOSPC on Linux.
 if(process.platform!=='linux' || !fs.existsSync('/dev/full')){t.skip('/dev/full write-failure device is unavailable');return;}
 assert.throws(()=>appendEvent('/dev/full',{n:2}),{code:'ENOSPC'});
 appendEvent(file,{n:3});assert.deepEqual(reader.read(),[{n:1},{n:3}]);
});

// Multiple rotations in one reader round each retain their own outstanding writer.
test('next read drains every deferred rotation and closes all old descriptors',t=>{
 const file=fixture(t),reader=new EventLogReader(file);t.after(()=>reader.close());
 appendEvent(file,{n:1});reader.read();const firstReader=reader.fd;
 const firstWriter=fs.openSync(file,'a');t.after(()=>fs.closeSync(firstWriter));
 rotateEventLog(file,{maxBytes:0,now:100});appendEvent(file,{n:2});
 const secondWriter=fs.openSync(file,'a');t.after(()=>fs.closeSync(secondWriter));
 rotateEventLog(file,{maxBytes:0,now:101});appendEvent(file,{n:3});
 assert.deepEqual(reader.read(),[{n:2},{n:3}]);
 const deferred=reader.previous.map(cursor=>cursor.fd);assert.ok(deferred.includes(firstReader));assert.equal(deferred.length,2);
 fs.appendFileSync(firstWriter,'{"n":4}\n');fs.appendFileSync(secondWriter,'{"n":5}\n');appendEvent(file,{n:6});
 assert.deepEqual(reader.read(),[{n:4},{n:5},{n:6}]);assert.deepEqual(reader.read(),[]);
 for(const fd of deferred)assert.throws(()=>fs.fstatSync(fd),{code:'EBADF'});
});
