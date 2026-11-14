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
    this.subagents=new Map();this.lastSubagentActivityAt=null;
    this.recovered=false;this.lastActivityAt=startedAt;this.closedThrough=-Infinity;this.transcriptPath=null;
    this.transcriptFd=null;this.transcriptOffset=0;this.transcriptIdentity=null;this.turn=false;this.idleSince=null;
    this.busySince=null;this.lastIdleAt=null;this.lastCompletedAt=null;
    this.lastStartedAt=null;this.lastMainWorkAt=null;
  }
  close(){this.reader.close();if(this.transcriptFd!==null)fs.closeSync(this.transcriptFd);this.transcriptFd=null;}
  matches(row) {
    return row.run_id===this.runId && row.session_id===this.sessionId && row.runtime===this.runtime && !row.agent_id && row.type!=='runtime_health';
  }
  consumeSubagent(row, reverse=false) {
    if(row.run_id!==this.runId || row.session_id!==this.sessionId || row.runtime!==this.runtime ||
       row.type==='runtime_health' || typeof row.agent_id!=='string' || !row.agent_id ||
       !Number.isFinite(row.ts) || row.ts<this.startedAt)return;
    const agent=this.subagents.get(row.agent_id) ?? {lastActivityAt:row.ts,active:false,transitionAt:-Infinity};
    agent.lastActivityAt=Math.max(agent.lastActivityAt,row.ts);
    if(['subagent_start','subagent_stop'].includes(row.event) &&
       (row.ts>agent.transitionAt || (!reverse && row.ts===agent.transitionAt))) {
      agent.active=row.event==='subagent_start';agent.transitionAt=row.ts;
    }
    this.subagents.set(row.agent_id,agent);
    this.lastSubagentActivityAt=Math.max(this.lastSubagentActivityAt ?? 0,row.ts);
  }
  recoverSubagents() {
    // Child lifetimes can cross main-agent turn boundaries. Recover compact
    // per-child facts independently, without retaining the session's event list.
    const reader=new EventLogReader(path.join(this.runDir,'events.jsonl'),{warn:this.warn});
    try {reader.recoverTail(row=>{
      this.consumeSubagent(row,true);
      const current=row.run_id===this.runId && row.session_id===this.sessionId && row.runtime===this.runtime;
      return {done:current && !row.agent_id && (row.event==='session_start' || Number.isFinite(row.ts) && row.ts<this.startedAt)};
    });} finally {reader.close();}
  }
  associateTranscript(row) {
    if(row.event==='session_start' && typeof row.transcript_path==='string' && path.isAbsolute(row.transcript_path))this.transcriptPath=row.transcript_path;
  }
  isCompletion(row) {
    return row.event==='stop' || (this.runtime==='claude' && row.event==='idle');
  }
  recordCompletion(row) {
    this.lastCompletedAt=Math.max(this.lastCompletedAt ?? -Infinity,row.ts);
  }
  recordMainWork(row) {
    if(!['prompt','pre_tool','post_tool','post_tool_failure','permission_request'].includes(row.event))return;
    this.lastMainWorkAt=Math.max(this.lastMainWorkAt ?? -Infinity,row.ts);
    if(row.event==='prompt')this.lastStartedAt=Math.max(this.lastStartedAt ?? -Infinity,row.ts);
  }
  recover() {
    let boundary=false,completionBoundary=false,startBoundary=false;
    return this.reader.recoverTail(row=>{
      if(!this.matches(row))return {};
      if(!this.transcriptPath)this.associateTranscript(row);
      if(Number.isFinite(row.ts) && row.ts>=this.startedAt)this.recordMainWork(row);
      if(row.event==='prompt' || row.event==='session_start' || Number.isFinite(row.ts) && row.ts<=this.startedAt)startBoundary=true;
      // The latest prompt bounds live tool recovery, but an earlier factual
      // completion must survive that prompt and subsequent quiet samples.
      if(Number.isFinite(row.ts) && row.ts>=this.startedAt && this.isCompletion(row)) {
        this.recordCompletion(row);completionBoundary=true;
      }
      if(row.event==='session_start' || Number.isFinite(row.ts) && row.ts<=this.startedAt)completionBoundary=true;
      const keep=!boundary && Number.isFinite(row.ts) && row.ts>=this.startedAt;
      if(Number.isFinite(row.ts) && (row.ts<=this.startedAt || ['prompt','stop'].includes(row.event)))boundary=true;
      return {keep,done:boundary && completionBoundary && startBoundary && this.transcriptPath!==null};
    });
  }
  consume(rows) {
    for(const row of rows) {
      this.consumeSubagent(row);
      if(!this.matches(row))continue;
      this.associateTranscript(row);
      if(!Number.isFinite(row.ts) || row.ts<this.startedAt)continue;
      this.lastActivityAt=Math.max(this.lastActivityAt,row.ts);
      this.recordMainWork(row);
      if(['prompt','pre_tool'].includes(row.event) && this.busySince===null) {
        // A recovered tool can be midway through a turn whose prompt is gone.
        this.busySince=row.event==='prompt' || this.lastIdleAt!==null ? row.ts : this.startedAt;
      }
      if(row.event==='prompt')this.turn=true;
      const nativeId=typeof row.tool_use_id==='string' && row.tool_use_id.length>0 ? row.tool_use_id : null;
      const id=nativeId ?? (row.event==='pre_tool' ? Symbol('unidentified tool') : null);
      if(row.event==='pre_tool' && id!==null && !this.completed.has(id) && !this.results.has(id) && row.ts>this.closedThrough) {
        this.tools.set(id,{id,name:row.tool,startedAt:row.ts,input:row.tool_input});
      }
      if(['post_tool','post_tool_failure'].includes(row.event) && typeof id==='string') {this.completed.add(id);this.tools.delete(id);}
      if(this.isCompletion(row)) {
        this.recordCompletion(row);
        this.turn=false;this.closedThrough=Math.max(this.closedThrough,row.ts);
        for(const [key,tool] of this.tools)if(tool.startedAt<=row.ts){this.completed.add(key);this.tools.delete(key);}
      }
    }
  }
  readTranscript() {
    if(!this.transcriptPath)return null;
    let stat;try{stat=fs.statSync(this.transcriptPath);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    const identity=`${stat.dev}:${stat.ino}`;
    // Claude's queued prompts can begin without another prompt hook. Parse the
    // associated transcript even with no tools; Codex has no verified dequeue
    // record contract, so its starts come only from native prompt hooks.
    if(this.runtime!=='claude')return stat.mtimeMs;
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
          const ts=typeof value.timestamp==='string' ? Date.parse(value.timestamp) : NaN;
          if(value.sessionId===this.sessionId && !value.isSidechain && !value.agent_id &&
             Number.isFinite(ts) && ts>=this.startedAt) {
            const dequeued=value.type==='queue-operation' && value.operation==='dequeue';
            if(dequeued)this.lastStartedAt=Math.max(this.lastStartedAt ?? -Infinity,ts);
            if(dequeued || ['user','assistant'].includes(value.type))this.lastMainWorkAt=Math.max(this.lastMainWorkAt ?? -Infinity,ts);
          }
          if(Array.isArray(content))for(const block of content)if(block.type==='tool_result' && typeof block.tool_use_id==='string')this.results.add(block.tool_use_id);
        }catch{this.warn('transcript_invalid_line');}
      }
    }
    for(const id of this.results)this.tools.delete(id);
    return stat.mtimeMs;
  }
  read(now=Date.now(), {subagentTtlMs=1800000}={}) {
    const events=this.recovered?this.reader.read():this.recover();
    // Capture the incremental cursor first, so child events appended during
    // independent recovery are still seen by the next tail read.
    if(!this.recovered)this.recoverSubagents();
    this.recovered=true;this.consume(events);
    const transcriptMtimeMs=this.readTranscript();
    if(Number.isFinite(transcriptMtimeMs))this.lastActivityAt=Math.max(this.lastActivityAt,transcriptMtimeMs);
    const busy=this.tools.size>0 || now-this.lastActivityAt<3000;
    if(busy){
      this.idleSince=null;
      // Transcript-only activity has no precise turn boundary. The last idle
      // observation (or run start after recovery) is a conservative lower bound.
      this.busySince ??= this.lastIdleAt ?? this.startedAt;
    }else{
      // A quiet activity sample does not close a prompt's turn. Keep its
      // original cutoff until a stop/idle hook actually closes the turn.
      if(!this.turn){this.busySince=null;this.lastIdleAt=now;}
      if(this.idleSince===null)this.idleSince=now;
    }
    const activeSubagents=[...this.subagents].filter(([,agent])=>agent.active && now-agent.lastActivityAt<subagentTtlMs)
      .map(([agentId,agent])=>({agentId,lastActivityAt:agent.lastActivityAt}));
    return {sessionId:this.sessionId,state:busy?'busy':'idle',busySince:this.busySince,turnOpen:this.turn,lastCompletedAt:this.lastCompletedAt,lastStartedAt:this.lastStartedAt,lastMainWorkAt:this.lastMainWorkAt,tools:[...this.tools.values()],lastActivityAt:this.lastActivityAt,transcriptMtimeMs,idleSince:this.idleSince,events,
      activeSubagents,lastSubagentActivityAt:this.lastSubagentActivityAt};
  }
}
