import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const helper=fileURLToPath(new URL('./locked-jsonl.pl',import.meta.url));
export function appendEvent(file,event) {
 fs.mkdirSync(path.dirname(file),{recursive:true});
 execFileSync('perl',[helper,'append',file],{input:JSON.stringify(event)+'\n',timeout:10000,stdio:['pipe','pipe','pipe'],maxBuffer:1024*1024});
}
export function rotateEventLog(file,{now=Date.now(),maxBytes=10*1024*1024,retentionMs=7*86400000}={}) {
 const directory=path.dirname(file),stem=path.basename(file,'.jsonl');
 let names;try {names=fs.readdirSync(directory);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 const rotated=names.map(name=>({name,stamp:name!==path.basename(file)&&name.startsWith(stem+'.')&&name.endsWith('.jsonl')?Number(name.slice(stem.length+1,-6)):NaN})).filter(x=>Number.isSafeInteger(x.stamp));
 const stamp=Math.max(now,...rotated.map(x=>x.stamp+1));
 let result=null;
 if(fs.existsSync(file))result=execFileSync('perl',[helper,'rotate',file,String(stamp),String(maxBytes)],{encoding:'utf8',timeout:10000}).trim()||null;
 for(const old of rotated)if(old.stamp<now-retentionMs)try{fs.unlinkSync(path.join(directory,old.name));}catch(e){if(e.code!=='ENOENT')throw e;}
 return result;
}

function logFiles(file) {
 const directory=path.dirname(file), stem=path.basename(file,'.jsonl');
 let names;try{names=fs.readdirSync(directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}
 return names.flatMap(name=>{
  if(name===path.basename(file))return [{file,stamp:Infinity}];
  if(!name.startsWith(stem+'.') || !name.endsWith('.jsonl'))return [];
  const stamp=Number(name.slice(stem.length+1,-6));
  return Number.isSafeInteger(stamp)?[{file:path.join(directory,name),stamp}]:[];
 }).sort((a,b)=>a.stamp-b.stamp);
}
function parseLine(line,warn) {
 try{const value=JSON.parse(line);if(!value || typeof value!=='object' || Array.isArray(value))throw new Error();if(value.v>1)warn('event_log_new_version');return value;}
 catch{warn('event_log_invalid_line');return null;}
}
// Bounded block reads, preserving arbitrarily long UTF-8 lines across blocks.
function* reverseLines(fd, size, chunkSize=64*1024) {
 let offset=size, remainder=Buffer.alloc(0), trailing=true;
 while(offset>0){
  const count=Math.min(chunkSize,offset);offset-=count;
  const chunk=Buffer.alloc(count);const n=fs.readSync(fd,chunk,0,count,offset);
  const data=Buffer.concat([chunk.subarray(0,n),remainder]);let end=data.length;
  for(let i=data.length-1;i>=0;i--)if(data[i]===10){
   if(trailing){trailing=false;}else yield data.subarray(i+1,end).toString('utf8');
   end=i;
  }
  remainder=data.subarray(0,end);
 }
 if(!trailing && remainder.length)yield remainder.toString('utf8');
}

/** Retain the old fd across rotations and consume every surviving intermediate file. */
export class EventLogReader {
 constructor(file,{warn=()=>{}}={}){this.file=file;this.warn=warn;this.fd=null;this.offset=0;this.identity=null;this.lastStamp=-1;}
 close(){if(this.fd!==null)fs.closeSync(this.fd);this.fd=null;this.identity=null;this.offset=0;}
 /** First read only: visit newest complete records until the caller's recovery boundary.
  * The newest fd remains at the captured end, including any incomplete trailing line.
  * visit returns {keep, done}; metadata discovery may continue without retaining history.
  */
 recoverTail(visit) {
  if(this.fd!==null)throw new Error('event log recovery already started');
  const files=logFiles(this.file), rows=[];let done=false;
  for(let i=files.length-1;i>=0 && !done;i--){
   let fd;try{fd=fs.openSync(files[i].file,'r');}catch(error){if(error.code==='ENOENT'){this.warn('event_log_gap');continue;}throw error;}
   const stat=fs.fstatSync(fd);
   const retained=this.fd===null;
   if(retained){
    this.fd=fd;this.identity=`${stat.dev}:${stat.ino}`;this.lastStamp=files[i].stamp;
    // Find the last complete line without allocating the whole file.
    this.offset=0;
    for(let end=stat.size;end>0;){const count=Math.min(end,64*1024),buffer=Buffer.alloc(count);end-=count;const n=fs.readSync(fd,buffer,0,count,end);const newline=buffer.subarray(0,n).lastIndexOf(10);if(newline>=0){this.offset=end+newline+1;break;}}
   }
   try{for(const line of reverseLines(fd,stat.size)){
    const row=parseLine(line,this.warn);if(!row)continue;
    const result=visit(row) || {};if(result.keep)rows.push(row);if(result.done){done=true;break;}
   }}finally{if(!retained)fs.closeSync(fd);}
  }
  return rows.reverse();
 }

 readFd(){
  const stat=fs.fstatSync(this.fd);if(stat.size<this.offset){this.warn('event_log_truncated');this.offset=0;}
  const size=stat.size-this.offset;if(!size)return [];
  const buffer=Buffer.alloc(size);const n=fs.readSync(this.fd,buffer,0,size,this.offset);const complete=buffer.subarray(0,n).lastIndexOf(10);if(complete<0)return [];
  this.offset+=complete+1;
  return buffer.subarray(0,complete).toString('utf8').split('\n').flatMap(line=>{const value=parseLine(line,this.warn);return value?[value]:[];});
 }
 read(){
  const files=logFiles(this.file).flatMap(item=>{try{const s=fs.statSync(item.file);return [{...item,identity:`${s.dev}:${s.ino}`}];}catch(e){if(e.code==='ENOENT')return [];throw e;}});
  if(!files.length && !fs.existsSync(path.dirname(this.file))){const rows=this.fd===null?[]:this.readFd();this.close();return rows;}
  const rows=this.fd===null?[]:this.readFd();let start=0;
  if(this.fd!==null){const index=files.findIndex(x=>x.identity===this.identity);if(index>=0){this.lastStamp=files[index].stamp;start=index+1;}else{this.warn('event_log_gap');start=0;}}
  for(let i=start;i<files.length;i++){
   const item=files[i];if(item.identity===this.identity)continue;
   this.close();try{this.fd=fs.openSync(item.file,'r');}catch(e){if(e.code==='ENOENT')continue;throw e;}
   const stat=fs.fstatSync(this.fd);this.identity=`${stat.dev}:${stat.ino}`;this.lastStamp=item.stamp;rows.push(...this.readFd());
  }
  return rows;
 }
}
