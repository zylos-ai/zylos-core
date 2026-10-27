import { loadCoreModule } from './core-modules.js';
import fs from 'node:fs';
import path from 'node:path';
const { EventLogReader } = await loadCoreModule('event-log.js');

/** One current run/session, with no global latest-transcript fallback. */
export class SessionActivity {
  constructor({runDir, runId, sessionId, runtime, startedAt=0, warn=()=>{}}) {
    Object.assign(this,{runDir,runId,sessionId,runtime,startedAt,warn});
    this.reader=new EventLogReader(path.join(runDir,'events.jsonl'),{warn});
    this.tools=new Map();this.completed=new Set();this.results=new Set();
    this.recovered=false;this.lastActivityAt=startedAt;this.closedThrough=-Infinity;this.transcriptPath=null;
    this.transcriptFd=null;this.transcriptOffset=0;this.transcriptIdentity=null;this.turn=false;this.idleSince=null;
  }
  close(){this.reader.close();if(this.transcriptFd!==null)fs.closeSync(this.transcriptFd);this.transcriptFd=null;}
  matches(row) {
    return row.run_id===this.runId && row.session_id===this.sessionId && row.runtime===this.runtime && !row.agent_id && row.type!=='runtime_health';
  }
  associateTranscript(row) {
    if(row.event==='session_start' && typeof row.transcript_path==='string' && path.isAbsolute(row.transcript_path))this.transcriptPath=row.transcript_path;
  }
  recover() {
    let boundary=false;
    return this.reader.recoverTail(row=>{
      if(!this.matches(row))return {};
      if(!this.transcriptPath)this.associateTranscript(row);
      const keep=!boundary && Number.isFinite(row.ts) && row.ts>=this.startedAt;
      if(Number.isFinite(row.ts) && (row.ts<=this.startedAt || ['prompt','stop'].includes(row.event)))boundary=true;
      return {keep,done:boundary && this.transcriptPath!==null};
    });
  }
  consume(rows) {
    for(const row of rows) {
      if(!this.matches(row))continue;
      this.associateTranscript(row);
      if(!Number.isFinite(row.ts) || row.ts<this.startedAt)continue;
      this.lastActivityAt=Math.max(this.lastActivityAt,row.ts);
      if(row.event==='prompt')this.turn=true;
      const nativeId=typeof row.tool_use_id==='string' && row.tool_use_id.length>0 ? row.tool_use_id : null;
      const id=nativeId ?? (row.event==='pre_tool' ? Symbol('unidentified tool') : null);
      if(row.event==='pre_tool' && id!==null && !this.completed.has(id) && !this.results.has(id) && row.ts>this.closedThrough) {
        this.tools.set(id,{id,name:row.tool,startedAt:row.ts,input:row.tool_input});
      }
      if(['post_tool','post_tool_failure'].includes(row.event) && typeof id==='string') {this.completed.add(id);this.tools.delete(id);}
      if(row.event==='stop' || (this.runtime==='claude' && row.event==='idle')) {
        this.turn=false;this.closedThrough=Math.max(this.closedThrough,row.ts);
        for(const [key,tool] of this.tools)if(tool.startedAt<=row.ts){this.completed.add(key);this.tools.delete(key);}
      }
    }
  }
  readTranscript() {
    if(!this.transcriptPath)return null;
    let stat;try{stat=fs.statSync(this.transcriptPath);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    const identity=`${stat.dev}:${stat.ino}`;
    if(this.runtime!=='claude' || !this.tools.size)return stat.mtimeMs;
    if(this.transcriptFd===null || identity!==this.transcriptIdentity || stat.size<this.transcriptOffset) {
      if(this.transcriptFd!==null)fs.closeSync(this.transcriptFd);
      this.transcriptFd=fs.openSync(this.transcriptPath,'r');this.transcriptOffset=0;this.transcriptIdentity=identity;
    }
    const size=fs.fstatSync(this.transcriptFd).size-this.transcriptOffset;
    if(size>0) {
      const buffer=Buffer.alloc(size);const count=fs.readSync(this.transcriptFd,buffer,0,size,this.transcriptOffset);const end=buffer.subarray(0,count).lastIndexOf(10);
      if(end>=0){this.transcriptOffset+=end+1;
        for(const line of buffer.subarray(0,end).toString('utf8').split('\n'))try{
          const value=JSON.parse(line);const content=value.message?.content ?? value.content;
          if(Array.isArray(content))for(const block of content)if(block.type==='tool_result' && typeof block.tool_use_id==='string')this.results.add(block.tool_use_id);
        }catch{this.warn('transcript_invalid_line');}
      }
    }
    for(const id of this.results)this.tools.delete(id);
    return stat.mtimeMs;
  }
  read(now=Date.now()) {
    const events=this.recovered?this.reader.read():this.recover();this.recovered=true;this.consume(events);
    const transcriptMtimeMs=this.readTranscript();
    if(Number.isFinite(transcriptMtimeMs))this.lastActivityAt=Math.max(this.lastActivityAt,transcriptMtimeMs);
    const busy=this.tools.size>0 || now-this.lastActivityAt<3000;
    if(busy)this.idleSince=null;else if(this.idleSince===null)this.idleSince=now;
    return {sessionId:this.sessionId,state:busy?'busy':'idle',tools:[...this.tools.values()],lastActivityAt:this.lastActivityAt,transcriptMtimeMs,idleSince:this.idleSince,events};
  }
}
