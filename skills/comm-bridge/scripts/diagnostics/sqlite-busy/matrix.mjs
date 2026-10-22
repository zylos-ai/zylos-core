import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import Database from '../../../node_modules/better-sqlite3/lib/index.js';
import {guardDatabase} from '../../sqlite-schema.js';
import * as owner from '../../c4-schema.js';
const stamp=()=>Number(process.hrtime.bigint())/1e6;
const [role,dir,mode,budget,operation]=process.argv.slice(2);
if(role==='holder') {
 const db=new Database(path.join(dir,'comm-bridge/c4.db'));
 db.pragma('locking_mode='+mode);
 db.exec('BEGIN IMMEDIATE; UPDATE probe SET n=2');
 const acquired=stamp();process.send({event:'locked',at:acquired});
 setTimeout(()=>{const releaseStart=stamp();db.exec('ROLLBACK');db.close();process.send({event:'released',at:stamp(),releaseStart,heldMs:stamp()-acquired});process.disconnect();},Number(budget));
} else if(role==='reader') {
 process.env.ZYLOS_DIR=dir;
 const api=await import('../../c4-db.js');
 const options=budget==='none'?{}:{deadlineAt:Date.now()+Number(budget)};
 const start=stamp();let value,error;
 try { value=operation==='transition'?api.getModeTransition({},options):api.auditCheckpoints(options); }
 catch(e){error={code:e.code??null,message:e.message,cause:e.cause?.code??null};}
 const end=stamp();api.close();
 console.log(JSON.stringify({operation,budget,start,end,elapsedMs:end-start,value,error}));
} else {
 const scenarios=[['baseline',null,0,1000],['normal','NORMAL',8000,1000],['one-second','EXCLUSIVE',8000,1000],['ordinary-cap','EXCLUSIVE',8000,'none'],['seven-second','EXCLUSIVE',8000,7000],['release-two','EXCLUSIVE',2000,10000]];
 for(const op of ['transition','audit']) for(const [name,lockMode,hold,remaining] of scenarios){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'if65-public-'));fs.mkdirSync(path.join(temp,'comm-bridge'));
  const db=new Database(path.join(temp,'comm-bridge/c4.db'));guardDatabase(db,owner);db.pragma('journal_mode=WAL');db.exec('CREATE TABLE probe(n);INSERT INTO probe VALUES(1)');db.close();
  let holder,done;const locks=[];
  try {
   if(lockMode){holder=spawn(process.execPath,[import.meta.filename,'holder',temp,lockMode,String(hold)],{stdio:['ignore','ignore','pipe','ipc']});done=once(holder,'exit');holder.on('message',m=>locks.push(m));await Promise.race([once(holder,'message'),done.then(()=>{throw Error('holder failed')})]);}
   const reader=spawn(process.execPath,[import.meta.filename,'reader',temp,'',String(remaining),op],{stdio:['ignore','pipe','pipe']});let out='',err='';reader.stdout.on('data',b=>out+=b);reader.stderr.on('data',b=>err+=b);const [exit]=await once(reader,'exit');
   if(holder)await done;
   console.log(JSON.stringify({name,op,locks,exit,reader:out.trim()?JSON.parse(out):null,stderr:err}));
  }finally{if(holder&&holder.exitCode===null){holder.kill();await done;}fs.rmSync(temp,{recursive:true,force:true});}
 }
}
