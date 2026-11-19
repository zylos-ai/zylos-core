import { loadCoreModule } from './core-modules.js';
import fs from 'node:fs';
import path from 'node:path';
import { inputAfterStop, STOP_HOOK_LAG_MS } from '../../dashboard/src/lib/workbench/working.js';
const { EventLogReader } = await loadCoreModule('event-log.js');
export const TRANSCRIPT_READ_BUDGET_BYTES=256*1024;
export const TRANSCRIPT_LINE_LIMIT_BYTES=1024*1024;
export const RECENT_TOOL_RESULTS_LIMIT=256;
export const OPEN_TURN_INACTIVITY_TIMEOUT_MS=20*60*1000;
/** One current run/session, with no global latest-transcript fallback. */
export class SessionActivity {
  constructor({runDir, runId, sessionId, runtime, startedAt=0, warn=()=>{}}) {
    Object.assign(this,{runDir,runId,sessionId,runtime,startedAt,warn});
    this.reader=new EventLogReader(path.join(runDir,'events.jsonl'),{warn});
    this.tools=new Map();this.completed=new Set();this.results=new Set();
    this.subagents=new Map();this.lastSubagentActivityAt=null;
    this.recovered=false;this.lastActivityAt=startedAt;this.closedThrough=-Infinity;this.transcriptPath=null;
    this.transcriptFd=null;this.transcriptOffset=0;this.transcriptIdentity=null;this.turn=false;this.idleSince=null;
    this.busySince=null;this.lastIdleAt=null;this.lastResponseAt=null;
    this.transcriptPartial=Buffer.alloc(0);this.transcriptSkippingLine=false;this.transcriptPending=false;
    this.codexTranscriptMatches=false;
    this.agyIdleSince=null;this.agyTasksRunning=false;
    this.quietTurnAttemptAt=null;
    this.turnStartedAt=null;this.lastNativeActivityAt=startedAt;this.pendingQuietTurnClose=null;
    this.lastTurnStop=null;this.lastDequeue=null;this.recentTurnStops=[];
    this.lastMainActionAt=-Infinity;this.lastHookStartAt=null;
  }
  mainAction(ts) {
    this.lastMainActionAt=Math.max(this.lastMainActionAt,ts);
    for(const stop of this.recentTurnStops)if(stop && ts<=stop.ts)
      stop.actionAt=Math.max(stop.actionAt,ts);
  }
  dequeueTime() {
    if(this.lastDequeue===null)return -Infinity;
    const queue={type:'input_dequeue',ts:this.lastDequeue};
    const facts=[queue,...this.recentTurnStops.flatMap(stop=>[
      ...(Number.isFinite(stop.actionAt)?[{type:'pre_tool_use',ts:stop.actionAt}]:[]),
      {type:'stop',ts:stop.ts}])].sort((a,b)=>a.ts-b.ts);
    return inputAfterStop(facts,{type:row=>row.type,at:row=>row.ts,child:()=>false})(queue);
  }
  applyDequeue() {
    if(this.runtime!=='claude')return;
    const ts=this.dequeueTime();
    if(ts>this.closedThrough && ts>(this.turnStartedAt ?? -Infinity)) {
      this.turn=true;this.turnStartedAt=ts;this.busySince=ts;this.quietTurnAttemptAt=null;this.pendingQuietTurnClose=null;
      this.lastActivityAt=Math.max(this.lastActivityAt,ts);this.lastNativeActivityAt=Math.max(this.lastNativeActivityAt,ts);
    }
  }
  forgetDequeue() {
    const startedAt=this.dequeueTime();this.lastDequeue=null;
    if(this.runtime==='claude' && this.turn && this.turnStartedAt===startedAt) {
      this.turn=this.lastHookStartAt!==null && this.lastHookStartAt>this.closedThrough;
      if(this.turn){this.turnStartedAt=this.lastHookStartAt;this.busySince=this.lastHookStartAt;}
    }
  }
  close(){this.reader.close();if(this.transcriptFd!==null)fs.closeSync(this.transcriptFd);this.transcriptFd=null;}
  quietTurnDue(now) {
    return this.turn && this.tools.size===0 && !this.agyTasksRunning && !this.transcriptPending &&
      now-this.lastActivityAt>=OPEN_TURN_INACTIVITY_TIMEOUT_MS;
  }
  claimQuietTurn(expectedLastActivityAt,now) {
    if(this.lastActivityAt!==expectedLastActivityAt || !this.quietTurnDue(now) ||
       this.quietTurnAttemptAt===this.turnStartedAt)return false;
    // An unknown enqueue result must not cause another Escape for this silence.
    this.quietTurnAttemptAt=this.turnStartedAt;
    return true;
  }
  applyQuietTurnClose() {
    const fact=this.pendingQuietTurnClose;
    if(!fact)return;
    if(this.turnStartedAt!==fact.turn_started_at || this.lastNativeActivityAt>fact.last_native_activity_at ||
       (this.lastResponseAt ?? -Infinity)>(fact.last_response_at ?? -Infinity)) {
      this.pendingQuietTurnClose=null;return;
    }
    // Old tools may finish only in transcript tool_result records. Finish that
    // bounded read before restoring the supervisor's admitted close decision.
    if(this.transcriptPending)return;
    this.pendingQuietTurnClose=null;
    if(this.tools.size===0) {
      this.turn=false;this.closedThrough=Math.max(this.closedThrough,fact.ts);
      if(this.runtime==='agy')this.agyIdleSince=fact.ts;
      this.lastActivityAt=Math.max(this.lastActivityAt,fact.last_activity_at);
    }
  }
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
    if(row.event==='pre_tool')this.lastResponseAt=Math.max(this.lastResponseAt ?? -Infinity,row.ts);
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
    if(row.event==='session_start' && typeof row.transcript_path==='string' && path.isAbsolute(row.transcript_path)) {
      this.transcriptPath=row.transcript_path;
    }
  }
  recover() {
    let boundary=false,responseBoundary=false,claudeCutoff=null;
    return this.reader.recoverTail(row=>{
      if(!this.matches(row))return {};
      if(!this.transcriptPath)this.associateTranscript(row);
      if(Number.isFinite(row.ts) && row.ts>=this.startedAt && row.event==='pre_tool')this.lastResponseAt=Math.max(this.lastResponseAt ?? -Infinity,row.ts);
      // Recover response history across newer prompt/stop boundaries without
      // replaying older turns into the current tool and busy/idle state.
      if(row.event==='session_start' || Number.isFinite(row.ts) && row.ts<=this.startedAt)responseBoundary=true;
      if(this.runtime==='claude' && row.event==='stop' && Number.isFinite(row.ts))claudeCutoff ??= row.ts-STOP_HOOK_LAG_MS;
      const keep=Number.isFinite(row.ts) && row.ts>=this.startedAt && (this.runtime==='claude'?
        claudeCutoff===null || row.ts>=claudeCutoff:!boundary);
      if(Number.isFinite(row.ts) && (row.ts<=this.startedAt ||
         this.runtime!=='claude' && ['prompt','stop'].includes(row.event)))boundary=true;
      return {keep,done:boundary && responseBoundary && this.transcriptPath!==null};
    });
  }
  consume(rows) {
    for(const row of rows) {
      this.consumeSubagent(row);
      if(!this.matches(row))continue;
      this.associateTranscript(row);
      if(!Number.isFinite(row.ts) || row.ts<this.startedAt)continue;
      if(['quiet_turn_interrupt_attempt','quiet_turn_interrupt'].includes(row.event)) {
        const activityAt=row.last_activity_at;
        if(!Number.isFinite(activityAt) || activityAt<this.startedAt || activityAt>row.ts ||
           !Number.isFinite(row.turn_started_at))continue;
        // AGY statusLine and Claude dequeue can open a turn without a prompt
        // hook. Restore the same durable attempt/admission boundary before
        // reading native samples; newer prompt/Stop boundaries take priority.
        if(['agy','claude'].includes(this.runtime) && Number.isFinite(row.last_native_activity_at) &&
           row.turn_started_at>=this.startedAt && row.turn_started_at<=row.last_native_activity_at && row.last_native_activity_at<=activityAt &&
           (row.last_response_at===null || Number.isFinite(row.last_response_at)) &&
           (row.event==='quiet_turn_interrupt_attempt' || Number.isSafeInteger(row.control_id) && row.control_id>0) &&
           row.turn_started_at>this.closedThrough && row.turn_started_at>(this.turnStartedAt ?? -Infinity)) {
          this.turn=true;this.turnStartedAt=row.turn_started_at;this.pendingQuietTurnClose=null;
        }
        if(row.turn_started_at!==this.turnStartedAt)continue;
        this.quietTurnAttemptAt=row.turn_started_at;
        // These are supervisor queue facts, not native activity or AI responses.
        // Retain preceding native facts during recovery so a stale admission
        // cannot close a prompt/tool that arrived while insertion was running.
        if(row.event==='quiet_turn_interrupt' && Number.isSafeInteger(row.control_id) && row.control_id>0 &&
           Number.isFinite(row.last_native_activity_at) && row.last_native_activity_at<=activityAt &&
           (row.last_response_at===null || Number.isFinite(row.last_response_at)))this.pendingQuietTurnClose=row;
        continue;
      }
      if(this.runtime==='claude' && row.event==='idle')continue;
      const startsPrompt=row.event==='prompt' && (this.runtime!=='claude' || !this.turn);
      if(this.runtime==='claude' && !row.agent_id &&
         ['prompt','pre_tool','post_tool','post_tool_failure','permission_request'].includes(row.event))this.mainAction(row.ts);
      this.lastActivityAt=Math.max(this.lastActivityAt,row.ts);
      this.lastNativeActivityAt=Math.max(this.lastNativeActivityAt,row.ts);
      if(row.event==='pre_tool')this.lastResponseAt=Math.max(this.lastResponseAt ?? -Infinity,row.ts);
      if(['prompt','pre_tool'].includes(row.event) && this.busySince===null) {
        // A recovered tool can be midway through a turn whose prompt is gone.
        this.busySince=row.event==='prompt' || this.lastIdleAt!==null ? row.ts : this.startedAt;
      }
      if(startsPrompt) {
        if(this.runtime==='claude'){this.busySince=row.ts;this.lastHookStartAt=row.ts;}
        this.turn=true;this.turnStartedAt=row.ts;this.quietTurnAttemptAt=null;this.pendingQuietTurnClose=null;
        if(this.runtime==='agy') {this.agyIdleSince=null;this.lastResponseAt=Math.max(this.lastResponseAt ?? -Infinity,row.ts);}
      }
      const nativeId=typeof row.tool_use_id==='string' && row.tool_use_id.length>0 ? row.tool_use_id : null;
      const id=nativeId ?? (row.event==='pre_tool' ? Symbol('unidentified tool') : null);
      if(row.event==='pre_tool' && id!==null && !this.completed.has(id) && !this.results.has(id) && row.ts>this.closedThrough) {
        this.tools.set(id,{id,name:row.tool,startedAt:row.ts,input:row.tool_input});
      }
      if(['post_tool','post_tool_failure'].includes(row.event) && typeof id==='string') {this.completed.add(id);this.tools.delete(id);}
      if(row.event==='stop') {
        if(this.runtime==='claude') {
          this.lastTurnStop={ts:row.ts,actionAt:this.lastMainActionAt<=row.ts?this.lastMainActionAt:-Infinity};
          this.recentTurnStops=this.recentTurnStops.filter(stop=>stop.ts>=row.ts-STOP_HOOK_LAG_MS);
          this.recentTurnStops.push(this.lastTurnStop);
        }
        if(this.runtime==='agy')this.agyIdleSince=row.ts;
        this.turn=false;this.closedThrough=Math.max(this.closedThrough,row.ts);
        for(const [key,tool] of this.tools)if(tool.startedAt<=row.ts){this.completed.add(key);this.tools.delete(key);}
      }
    }
  }
  recordTranscript(value,{trackResults=false}={}) {
    const ts=typeof value.timestamp==='string' ? Date.parse(value.timestamp) : NaN;
    if(this.runtime==='claude' && value.type==='queue-operation' && value.operation==='dequeue' &&
       (!value.sessionId || value.sessionId===this.sessionId) && !value.isSidechain && !value.agent_id && !value.agentId &&
       Number.isFinite(ts) && ts>=this.startedAt)this.lastDequeue=Math.max(this.lastDequeue ?? -Infinity,ts);
    if(this.runtime==='codex') {
      if(value.type==='session_meta')this.codexTranscriptMatches=value.payload?.id===this.sessionId;
      const payload=value.payload;
      if(!this.codexTranscriptMatches || !Number.isFinite(ts) || ts<this.startedAt || value.isMeta || payload?.isMeta)return;
      const output=value.type==='response_item' && payload?.type==='message' && payload.role==='assistant' &&
        Array.isArray(payload.content) && payload.content.some(block=>block.type==='output_text' && typeof block.text==='string' && block.text.length>0);
      const call=value.type==='response_item' && ['function_call','custom_tool_call'].includes(payload?.type) && typeof payload.name==='string';
      if(output || call) {
        this.lastResponseAt=Math.max(this.lastResponseAt ?? -Infinity,ts);
      }
      return;
    }
    const main=value.sessionId===this.sessionId && !value.isSidechain && !value.agent_id && !value.agentId &&
      Number.isFinite(ts) && ts>=this.startedAt;
    if(main) {
      const message=value.message;
      const output=value.type==='assistant' && !value.isMeta && !message?.isMeta && !value.isApiErrorMessage && !value.error &&
        message?.role==='assistant' && typeof message.model==='string' && message.model.length>0 && message.model!=='<synthetic>' &&
        Array.isArray(message.content) && message.content.some(block=>
          (block.type==='text' && typeof block.text==='string' && block.text.length>0) ||
          (block.type==='thinking' && typeof block.thinking==='string' && block.thinking.length>0) || block.type==='tool_use');
      if(output) {
        this.lastResponseAt=Math.max(this.lastResponseAt ?? -Infinity,ts);
        if(this.runtime==='claude')this.mainAction(ts);
      }
    }
    // Remember only a bounded recent window, including gaps before tool hooks. This
    // also covers a result arriving before its delayed pre-tool hook.
    if(trackResults) {
      const content=value.message?.content ?? value.content;
      if(Array.isArray(content))for(const block of content)if(block.type==='tool_result' && typeof block.tool_use_id==='string') {
        this.tools.delete(block.tool_use_id);
        this.results.delete(block.tool_use_id);this.results.add(block.tool_use_id);
        if(this.results.size>RECENT_TOOL_RESULTS_LIMIT)this.results.delete(this.results.values().next().value);
      }
    }
  }
  readTranscript() {
    this.transcriptPending=false;
    if(!this.transcriptPath){this.forgetDequeue();return null;}
    let stat;try{stat=fs.statSync(this.transcriptPath);}catch(error){if(this.runtime!=='claude' && error.code!=='ENOENT')throw error;this.forgetDequeue();return null;}
    const identity=`${stat.dev}:${stat.ino}`;
    if(this.transcriptFd===null || identity!==this.transcriptIdentity || stat.size<this.transcriptOffset) {
      this.forgetDequeue();
      if(this.transcriptFd!==null)fs.closeSync(this.transcriptFd);
      this.transcriptFd=null;
      try{this.transcriptFd=fs.openSync(this.transcriptPath,'r');}catch(error){if(this.runtime!=='claude')throw error;this.forgetDequeue();return null;}
      this.transcriptOffset=0;this.transcriptIdentity=identity;
      this.transcriptPartial=Buffer.alloc(0);this.transcriptSkippingLine=false;
      this.codexTranscriptMatches=false;
    }
    const readOffset=this.transcriptOffset;
    let remaining=Math.min(TRANSCRIPT_READ_BUDGET_BYTES,stat.size-this.transcriptOffset);
    // Nonblocking hooks can arrive after a result was parsed while no tool was visible.
    const trackResults=true;
    const buffer=Buffer.alloc(Math.min(64*1024,remaining));
    while(remaining>0) {
      let count;try{count=fs.readSync(this.transcriptFd,buffer,0,Math.min(buffer.length,remaining),this.transcriptOffset);}
      catch(error){if(this.runtime!=='claude')throw error;this.forgetDequeue();return null;}
      if(!count)break;
      this.transcriptOffset+=count;remaining-=count;
      let start=0;
      while(start<count) {
        const newline=buffer.subarray(0,count).indexOf(10,start);
        const end=newline<0?count:newline;
        if(!this.transcriptSkippingLine) {
          const piece=buffer.subarray(start,end);
          if(this.transcriptPartial.length+piece.length>TRANSCRIPT_LINE_LIMIT_BYTES) {
            this.transcriptPartial=Buffer.alloc(0);this.transcriptSkippingLine=true;this.warn('transcript_line_too_large');
          } else this.transcriptPartial=Buffer.concat([this.transcriptPartial,piece]);
        }
        if(newline<0)break;
        if(!this.transcriptSkippingLine && this.transcriptPartial.length) {
          try{this.recordTranscript(JSON.parse(this.transcriptPartial.toString('utf8')),{trackResults});}catch{this.warn('transcript_invalid_line');}
        }
        this.transcriptPartial=Buffer.alloc(0);this.transcriptSkippingLine=false;start=newline+1;
      }
    }
    // An unfinished EOF record is not evidence of continued AI work. Keep its
    // bounded carry for the next append without indefinitely fencing recovery.
    this.transcriptPending=this.transcriptOffset<stat.size;
    // Timestamp-only touches are not activity; count only newly read bytes.
    return this.transcriptOffset>readOffset?stat.mtimeMs:null;
  }
  agyBusy(now) {
    // AGY publishes statusLine only on changes, with no heartbeat. A run/session
    // bound task sample remains authoritative until turn close or replacement.
    // Turn reopening and native freshness still require a post-activity sample.
    // Idle samples also close Esc-interrupted turns, which emit no Stop.
    let sample;
    try {sample=JSON.parse(fs.readFileSync(path.join(this.runDir,'statusline.json'),'utf8'));} catch {}
    const captured=sample?.zylos?.capturedAt;
    const valid=sample?.zylos?.v===1 && sample.zylos.runId===this.runId && sample.session_id===this.sessionId &&
      Number.isFinite(captured) && captured>=this.startedAt && captured<=now;
    const current=valid && captured>=this.lastActivityAt;
    if(current) {
      // New statusLine samples are native activity; rereading one is not.
      this.lastNativeActivityAt=Math.max(this.lastNativeActivityAt,captured);
    }
    const runningSubagent=Array.isArray(sample?.subagents) && sample.subagents.some(agent=>agent?.status==='running');
    this.applyQuietTurnClose();
    this.agyTasksRunning=Boolean(valid && captured>this.closedThrough && (sample.task_count>0 || runningSubagent));
    // An admitted interrupt fences the preceding non-idle sample. Only a
    // newer native sample can reopen it; idle stability still takes 500ms.
    if(current && captured>this.closedThrough) {
      if(sample.agent_state==='idle' && !this.agyTasksRunning) {
        this.agyIdleSince ??= captured;
        if(now-this.agyIdleSince>=500) {
          this.turn=false;this.tools.clear();return false;
        }
        return true;
      }
      this.agyIdleSince=null;
      if(!this.turn) {this.turnStartedAt=captured;this.quietTurnAttemptAt=null;}
      this.turn=true;
      this.lastActivityAt=Math.max(this.lastActivityAt,captured);
      return true;
    }
    // Fully-idle Stop hooks are authoritative after a short stability interval,
    // longer than AGY's approximately 240ms gap between queued requests.
    return this.turn || this.tools.size>0 || this.agyIdleSince===null || now-this.agyIdleSince<500;
  }
  read(now=Date.now(), {subagentTtlMs=1800000}={}) {
    const events=this.recovered?this.reader.read():this.recover();
    // Capture the incremental cursor first, so child events appended during
    // independent recovery are still seen by the next tail read.
    if(!this.recovered)this.recoverSubagents();
    this.consume(events);this.recovered=true;
    const transcriptMtimeMs=this.runtime==='agy'?null:this.readTranscript();
    this.applyDequeue();
    if(this.runtime!=='agy')this.applyQuietTurnClose();
    if(Number.isFinite(transcriptMtimeMs))this.lastActivityAt=Math.max(this.lastActivityAt,transcriptMtimeMs);
    // Open API/model waits remain busy until the supervisor admits Escape.
    const busy=this.runtime==='agy'?this.agyBusy(now):this.turn || this.tools.size>0 || this.runtime==='claude' && this.transcriptPending || now-this.lastActivityAt<3000;
    if(busy){
      this.idleSince=null;
      // Transcript-only activity has no precise turn boundary. The last idle
      // observation (or run start after recovery) is a conservative lower bound.
      this.busySince ??= this.lastIdleAt ?? this.startedAt;
    }else{
      // A closing hook or the supervisor's queued interrupt ends an open turn.
      if(!this.turn){this.busySince=null;this.lastIdleAt=now;}
      if(this.idleSince===null)this.idleSince=now;
    }
    const activeSubagents=[...this.subagents].filter(([,agent])=>agent.active && now-agent.lastActivityAt<subagentTtlMs)
      .map(([agentId,agent])=>({agentId,lastActivityAt:agent.lastActivityAt}));
    return {sessionId:this.sessionId,state:busy?'busy':'idle',busySince:this.busySince,turnOpen:this.turn,turnStartedAt:this.turnStartedAt,lastNativeActivityAt:this.lastNativeActivityAt,quietTurnDue:this.quietTurnDue(now),lastResponseAt:this.lastResponseAt,transcriptPending:this.transcriptPending,tools:[...this.tools.values()],lastActivityAt:this.lastActivityAt,transcriptMtimeMs,idleSince:this.idleSince,events,
      activeSubagents,lastSubagentActivityAt:this.lastSubagentActivityAt};
  }
}
