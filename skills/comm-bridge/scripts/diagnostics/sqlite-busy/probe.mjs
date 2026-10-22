import { fork } from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const __filename=fileURLToPath(import.meta.url);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const driver=process.env.PROBE_DRIVER;
if(!driver)throw new Error('Set PROBE_DRIVER to an absolute better-sqlite3 package directory compatible with this Node');
const {default: Database}=await import(pathToFileURL(path.join(driver,'lib/index.js')).href);
const mono=()=>Number(process.hrtime.bigint())/1e6;
function log(event,extra={}) { console.log(JSON.stringify({pid:process.pid,mono_ms:mono(),event,...extra})); }
function step(name,fn,allowError=false) {const start=mono();try {const value=fn();log(name,{elapsed_ms:mono()-start,value});return value;}catch(e){log(name,{elapsed_ms:mono()-start,error:{code:e.code,message:e.message}});if(!allowError)throw e;return null;}}
if(process.argv[2]==='holder') {
 const [file,mode,hold]=process.argv.slice(3); const db=new Database(file);
 step('holder.mode',()=>db.pragma('locking_mode='+mode));
 step('holder.begin_update',()=>db.exec('BEGIN IMMEDIATE; UPDATE probe SET value=2')&&'ok');
 const acquired=mono(); log('holder.acquired',{acquired,hold_ms:+hold}); process.send({locked:true,acquired});
 setTimeout(()=>{step('holder.rollback',()=>db.exec('ROLLBACK')&&'ok');step('holder.close',()=>db.close()&&'ok');log('holder.released',{actual_hold_ms:mono()-acquired});process.disconnect();},+hold);
} else (async()=>{
 const ver=new Database(':memory:');log('versions',{node:process.version,exec:process.execPath,driver,driverVersion:JSON.parse(fs.readFileSync(path.join(driver,'package.json'),'utf8')).version,sqlite:ver.prepare('SELECT sqlite_version()').get(),compileOptions:ver.pragma('compile_options')});ver.close();
 const cases=process.argv[2]==='smoke'?[['no-lock',null,false,0]]:process.argv[2]==='qualification'?[['exclusive-post-60s','EXCLUSIVE',false,60000]]:[['no-lock',null,false,0],['wal-normal','NORMAL',false,8000],['exclusive-pre','EXCLUSIVE',true,8000],['exclusive-post','EXCLUSIVE',false,8000]];
 for(const [name,mode,pre,hold] of cases) {
 log('case.start',{name,mode,pre,hold}); const dir=fs.mkdtempSync(path.join(os.tmpdir(),'if65-native-')),file=path.join(dir,'probe.db');log('fixture',{file});
 const setup=new Database(file);setup.pragma('journal_mode=WAL');setup.exec('CREATE TABLE probe(value); INSERT INTO probe VALUES(1)');setup.close();
 let db; const open=()=>db=step('reader.open',()=>new Database(file,{readonly:true,fileMustExist:true,timeout:5000}));
 // Avoid serializing connection internals in timings.
 if(pre)open();
 let child,ended;
 if(mode) {child=fork(__filename,['holder',file,mode,String(hold)],{stdio:['ignore','inherit','inherit','ipc']}); ended=new Promise((r,j)=>child.once('exit',(c,s)=>c===0?r():j(Error(`holder exit ${c}/${s}`))));await Promise.race([new Promise((r,j)=>{child.once('message',m=>{if(!m.locked)return j(Error('holder not locked'));log('parent.lock_ready',m);r();});child.once('error',j);}),ended.then(()=>{throw Error('holder exited before lock-ready');})]);}
 if(!pre)open();
 step('reader.set_busy_timeout',()=>db.pragma('busy_timeout=5000'));
 step('reader.read_busy_timeout',()=>db.pragma('busy_timeout',{simple:true}));
 if(process.env.PROBE_TRACE)step('reader.load_trace',()=>db.loadExtension(process.env.PROBE_TRACE)&&'ok');
 const stmt=step('reader.prepare',()=>db.prepare('SELECT value FROM probe'),true);
 if(stmt)step('reader.get',()=>stmt.get());
 step('reader.close',()=>db.close()&&'ok');
 if(ended)await ended;
 log('case.end',{name});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
