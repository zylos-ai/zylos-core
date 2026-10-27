import path from 'node:path';
import { loadCoreModule } from './core-modules.js';
const { EventLogReader } = await loadCoreModule('event-log.js');
const { RUN_FILES } = await loadCoreModule('session-group-paths.js');
import { readScopedHealthQuota } from './health-quota.js';

/** Keep an uncommitted batch in memory; process restart replays F6 against F10 markers. */
export class HealthEventReader {
  constructor({coordinator,zylosDir,now=Date.now,warn=()=>{},createReader=file=>new EventLogReader(file,{warn}),quota}={}) {
    Object.assign(this,{coordinator,zylosDir,now,createReader});this.streams=new Map();
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
      if(event.type==='runtime_health' && event.runtime===scene.runtime) {
        const result=await this.coordinator.consumeHook(scene.runtime,event,{identity,sessionGroup:scene.sessionGroup,quota:this.quota(identity,scene)});
        results.push(result);
      }
      // A throwing atomic publication leaves this exact event at the head for retry.
      stream.pending.shift();
    }
    return results;
  }
  close(){for(const stream of this.streams.values())stream.reader.close();this.streams.clear();}
}
