import path from 'node:path';
import { loadCoreModule } from './core-modules.js';
const { EventLogReader } = await loadCoreModule('event-log.js');
const { RUN_FILES } = await loadCoreModule('session-group-paths.js');
import { readScopedHealthQuota } from './health-quota.js';

/** Keep an uncommitted batch in memory; process restart replays F6 against F10 markers. */
export class HealthEventReader {
  constructor({coordinator,zylosDir,now=Date.now,warn=()=>{},createReader=file=>new EventLogReader(file,{warn}),quota,getControl=()=>null,expireControl=()=>{}}={}) {
    Object.assign(this,{coordinator,zylosDir,now,createReader,getControl,expireControl});this.streams=new Map();
    this.quota=quota??((identity,scene)=>readScopedHealthQuota({identity,runDir:scene.runDir,runId:scene.runId,nowMs:now()}));
  }
  async consumeScene(scene,identity) {
    if(!scene.runDir || !identity)return [];
    const file=path.join(scene.runDir,RUN_FILES.EVENTS);
    let stream=this.streams.get(scene.sessionGroup);
    if(!stream || stream.file!==file) {
      stream?.reader.close();stream={file,reader:this.createReader(file),pending:[]};this.streams.set(scene.sessionGroup,stream);
    }
    stream.pending.push(...stream.reader.read());
    const results=[];
    while(stream.pending.length) {
      const event=stream.pending[0];
      const auth = stream.auth;
      if (auth && (auth.runId !== scene.runId || auth.sessionId !== identity.session_id || auth.pid !== identity.claude_pid)) {
        // This result was requested by the discarded run, even if the next
        // run reused the same file and native session identity.
        stream.pending.shift();
        delete stream.auth;
        continue;
      }
      if (auth && auth.confirmed === undefined) {
        results.push({status:'awaiting_auth'});
        break;
      }
      if(event.type==='runtime_health' && event.runtime===scene.runtime) {
        const retry=scene.runtime==='claude' && ['stop','stop_failure'].includes(event.event)
          ? this.coordinator.store?.(scene.runtime).read(scene.sessionGroup).failure_retry : null;
        const control=retry?.controlId ? this.getControl(retry.controlId) : null;
        // A claimed control can still be before paste. Keep this terminal hook
        // at the queue head until delivery settles, including across AM restart.
        if (control?.status === 'running') {
          if (auth) results.push({status:'awaiting_auth'});
          break;
        }
        const result=await this.coordinator.consumeHook(scene.runtime,event,{identity,sessionGroup:scene.sessionGroup,quota:this.quota(identity,scene),runId:scene.runId,
          retryControl:control,expireControl:this.expireControl,confirmAuth:confirm=>{
            if (!stream.auth) {
              const auth = {runId:scene.runId,sessionId:identity.session_id,pid:identity.claude_pid,confirmed:undefined};
              stream.auth = auth;
              void confirm().then(confirmed=>{auth.confirmed=confirmed;});
            }
            return stream.auth.confirmed;
          }});
        results.push(result);
        if (result.status === 'awaiting_auth') break;
      }
      // A throwing atomic publication leaves this exact event at the head for retry.
      stream.pending.shift();
      delete stream.auth;
    }
    return results;
  }
  close(){for(const stream of this.streams.values())stream.reader.close();this.streams.clear();}
}
