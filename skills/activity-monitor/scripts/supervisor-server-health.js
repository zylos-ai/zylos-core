import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
const sameIdentity=(a,b)=>a?.present===true && b?.present===true && a.pid===b.pid && a.created===b.created;

/** OS process identity is deliberately independent of tmux's start_time clock. */
export async function readServerProcessIdentity(pid,{platform=process.platform,readFile=fs.readFile,execFileAsync=exec}={}) {
  if(!Number.isSafeInteger(pid)||pid<=0)return {present:null};
  try {
    if(platform==='linux') {
      const stat=await readFile(`/proc/${pid}/stat`,'utf8');
      const end=stat.lastIndexOf(')');
      const fields=stat.slice(end+2).trim().split(/\s+/);
      if(end<0 || !/^\d+$/.test(fields[19]??''))return {present:null};
      if(fields[0]==='Z'||fields[0]==='X')return {present:false,pid};
      return {present:true,pid,created:fields[19]};
    }
    if(platform==='darwin') {
      try {
        const {stdout}=await execFileAsync('ps',['-p',String(pid),'-o','lstart='],{timeout:3000,env:{...process.env,LC_ALL:'C'}});
        const created=stdout.trim();
        return created ? {present:true,pid,created} : {present:false,pid};
      } catch(error) {
        if(error.code===1 && !error.killed && !String(error.stderr??'').trim())return {present:false,pid};
        return {present:null,pid};
      }
    }
  } catch(error) {
    if(error.code==='ENOENT'||error.code==='ESRCH')return {present:false,pid};
  }
  return {present:null,pid};
}

export class SupervisorServerHealth {
  constructor({now=Date.now,readProcessIdentity=readServerProcessIdentity,
    signalProcess=(pid)=>process.kill(pid,'SIGKILL'),getModeTransition=()=>null,
    lifecycleSerial=operation=>operation(),readAlertTarget=()=>null,sendAlert,
    log=()=>{}}={}) {
    Object.assign(this,{now,readProcessIdentity,signalProcess,getModeTransition,lifecycleSerial,readAlertTarget,sendAlert,log});
    this.servers=new Map();this.queues=new Map();
  }
  serial(socketKey,operation) {
    const prior=this.queues.get(socketKey)??Promise.resolve(),pending=prior.catch(()=>{}).then(operation);
    this.queues.set(socketKey,pending);pending.finally(()=>{if(this.queues.get(socketKey)===pending)this.queues.delete(socketKey);}).catch(()=>{});return pending;
  }
  record(socketKey) {
    if(!this.servers.has(socketKey))this.servers.set(socketKey,{cache:null,episode:null});return this.servers.get(socketKey);
  }
  observeSuccess({socketKey='default',readGeneration}) {
    return this.serial(socketKey,async()=>{
      const record=this.record(socketKey);
      const before=await readGeneration();
      record.episode=null;
      const match=typeof before==='string' && before.match(/^(\d+):\d+$/);
      if(!match){record.cache=null;return {status:'observable',cached:false};}
      let identity;
      try{identity=await this.readProcessIdentity(Number(match[1]));}catch{identity={present:null};}
      const after=await readGeneration();
      if(before!==after) {
        record.cache=null;return {status:'observable',cached:false};
      }
      if(identity?.present!==true || identity.pid!==Number(match[1]) || typeof identity.created!=='string' || !identity.created) {
        record.cache=null;return {status:'observable',cached:false,generation:before};
      }
      record.cache={generation:before,identity};return {status:'observable',cached:true,generation:before};
    });
  }
  observeNoServer({socketKey='default'}={}) {
    return this.serial(socketKey,()=>{
      const record=this.record(socketKey);
      record.cache=null;record.episode=null;
      return {status:'observable',cached:false};
    });
  }
  async notify(record,message) {
    let target;
    try{target=await this.readAlertTarget();}catch{target=null;}
    const valid=target && typeof target.channel==='string' && target.channel && typeof target.endpoint==='string' && target.endpoint;
    if(valid) {
      try{if(await this.sendAlert(target,message)!==false)return;}catch(error){this.log(error);}
    }
    if(valid && target.channel==='web-console' && target.endpoint==='console')return;
    try{await this.sendAlert({channel:'web-console',endpoint:'console'},message);}catch(error){this.log(error);}
  }
  async inspect(cache) {
    if(!cache)return 'unknown';
    let current;try{current=await this.readProcessIdentity(cache.identity.pid);}catch{return 'unknown';}
    if(current?.present===false)return 'gone';
    if(current?.present!==true)return 'unknown';
    return sameIdentity(cache.identity,current)?'present':'gone';
  }
  async observeFailure({socketKey='default',error,deferTermination=false}) {
    if(error?.code!=='TMUX_UNAVAILABLE')throw error;
    const result=await this.serial(socketKey,async()=>{
      const record=this.record(socketKey),now=this.now();
      record.episode??={since:now,allTimeout:true,alerted:false,terminationAttempted:false};
      if(error.cause!=='timeout')record.episode.allTimeout=false;
      const status=await this.inspect(record.cache);
      if(status==='gone')return {status:'old_server_gone',generation:record.cache.generation};
      return {status:'unavailable'};
    });
    // Callers may already own the lifecycle queue. Observation only records facts;
    // maintenance is explicitly scheduled by the outer loop in that case.
    if(deferTermination || result.status==='old_server_gone')return result;
    return this.advance({socketKey});
  }
  async advance({socketKey='default'}={}) {
    const record=this.record(socketKey),episode=record.episode,old=record.cache;
    if(!episode)return {status:'observable'};
    const now=this.now();
    const status=await this.inspect(old);
    if(status==='gone')return {status:'old_server_gone',generation:old.generation};
    if(now-episode.since>=60000 && !episode.alerted) {
      episode.alerted=true;
      await this.notify(record,`tmux observation has been unavailable for ${Math.floor((now-episode.since)/1000)} seconds. Sessions remain unconfirmed.`);
    }
    if(now-episode.since<600000 || !episode.allTimeout || status!=='present' || episode.terminationAttempted)return {status:'unavailable'};
    // Never hold the socket observation queue while waiting for lifecycleSerial:
    // lifecycle operations themselves perform socket observations.
    const result=await this.lifecycleSerial(async()=>{
      if(record.episode!==episode || record.cache!==old || !episode.allTimeout || episode.terminationAttempted)return null;
      if(await this.getModeTransition())return null;
      const fresh=await this.inspect(old);
      if(fresh==='gone')return {status:'old_server_gone',generation:old.generation};
      if(fresh!=='present')return {status:'unavailable'};
      // Recheck after awaited OS/config reads: successful observation cancels this episode.
      if(record.episode!==episode || record.cache!==old || !episode.allTimeout || episode.terminationAttempted)return null;
      episode.terminationAttempted=true;
      try{await this.signalProcess(old.identity.pid,old.identity);}catch(error){this.log(error);}
      const observed=await this.inspect(old);
      const outcome=observed==='gone'?'ended':observed==='present'?'not_ended':'unknown';
      return observed==='gone'?{status:'old_server_gone',generation:old.generation,termination:outcome}:{status:'unavailable',termination:outcome};
    });
    if(result?.termination)await this.notify(record,`tmux server termination result: ${result.termination}. Session recovery has not been verified.`);
    return result??{status:'unavailable'};
  }
}
