import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('DM-38: actual write-limit error truncates partial append back to locked length',async t=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 const file=fixture(t);appendEvent(file,{n:1});const before=fs.readFileSync(file);
 const helper=fileURLToPath(new URL('../locked-jsonl.pl',import.meta.url));
 const result=await new Promise(resolve=>{
  const child=spawn('bash',['-c',"trap '' XFSZ; ulimit -f 1; exec perl \"$1\" append \"$2\"",'write-limit',helper,file],{stdio:['pipe','ignore','pipe']});let error='';
  child.stderr.on('data',chunk=>{error+=chunk;});child.stdin.on('error',()=>{});child.on('close',code=>resolve({code,error}));child.stdin.end(JSON.stringify({payload:'x'.repeat(32768)})+'\n');
 });
 assert.notEqual(result.code,0);assert.match(result.error,/write:/);assert.deepEqual(fs.readFileSync(file),before);
});

test('DM-38: two real writers each append 10000 long lines during rotations',async t=>{
 const {spawn}=await import('node:child_process');const file=fixture(t);
 const worker=`import {appendEvent} from ${JSON.stringify(new URL('../event-log.js',import.meta.url).href)};for(let n=0;n<10000;n++)appendEvent(process.argv[1],{writer:process.argv[2],n,payload:'x'.repeat(8192)});`;
 const run=writer=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',worker,file,writer],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(stderr)));});
 const timer=setInterval(()=>rotateEventLog(file,{maxBytes:1024*1024}),100);
 try{await Promise.all([run('a'),run('b')]);}finally{clearInterval(timer);}
 const warnings=[],reader=new EventLogReader(file,{warn:x=>warnings.push(x)});t.after(()=>reader.close());const rows=reader.read();
 assert.equal(rows.length,20000,JSON.stringify(fs.readdirSync(path.dirname(file)).map(name=>({name,size:fs.statSync(path.join(path.dirname(file),name)).size}))) );assert.equal(new Set(rows.map(row=>`${row.writer}:${row.n}`)).size,20000);assert.deepEqual(warnings,[]);
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

test('IF-31 negative control: removing append lock exposes interleaved long records',async t=>{
 const {spawn}=await import('node:child_process');const file=fixture(t);
 // Both intentionally broken writers pause mid-record. The parent releases them
 // only after both first halves reached the same append-only file.
 const source=`import fs from 'node:fs';const line=JSON.stringify({writer:process.argv[2],payload:'x'.repeat(65536)})+'\\n';const fd=fs.openSync(process.argv[1],'a');fs.writeSync(fd,line.slice(0,32768));process.send('half');process.on('message',()=>{fs.writeSync(fd,line.slice(32768));fs.closeSync(fd);process.disconnect();});`;
 const children=['a','b'].map(writer=>spawn(process.execPath,['--input-type=module','-e',source,file,writer],{stdio:['ignore','ignore','pipe','ipc']}));
 const exits=children.map(child=>new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`mutant exited ${code}`)));}));
 await Promise.all(children.map(child=>new Promise(resolve=>child.once('message',resolve))));
 children.forEach(child=>child.send('finish'));await Promise.all(exits);
 const warnings=[],reader=new EventLogReader(file,{warn:value=>warnings.push(value)});t.after(()=>reader.close());
 const rows=reader.read();assert.notEqual(rows.length,2);assert.ok(warnings.includes('event_log_invalid_line'));
});
