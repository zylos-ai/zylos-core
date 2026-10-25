import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as defaultDb from '../../comm-bridge/scripts/c4-db.js';
import { freezeFirstFailureNotice, drainFirstFailureNotices } from '../../comm-bridge/scripts/first-failure-notice.js';
import { loadCoreModule } from './core-modules.js';
import { createSupervisor } from './supervisor.js';
import { SupervisorServerHealth } from './supervisor-server-health.js';
import { SupervisorServerObservation, parseServerAlertTarget } from './supervisor-server-observation.js';
import { SupervisorLegacyStatus } from './supervisor-legacy-status.js';
import { SupervisorScenes } from './supervisor-scenes.js';
import { SupervisorMachineTasks } from './supervisor-machine-tasks.js';
import { readScopedHealthQuota } from './health-quota.js';
import { HealthEventReader } from './health-event-reader.js';
import { RestartRequestStore } from './restart-request-store.js';
import { findMatchingToolRule } from './tool-rules.js';
const { readSessionMode, readZylosConfigOrThrow } = await loadCoreModule('config.js');
const { getSessionAdapter } = await loadCoreModule('runtime/index.js');
const { zylosRoot } = await loadCoreModule('session-group-paths.js');
const { createSessionReader } = await loadCoreModule('session-state-reader-async.js');
const { matchClaudeScreen } = await loadCoreModule('heartbeat/claude-probe.js');
const { matchCodexScreen } = await loadCoreModule('heartbeat/codex-probe.js');
const unavailable = name => Object.assign(new Error(`${name} is unavailable on this code baseline`),{code:'DEPENDENCY_UNAVAILABLE'});

/** Entry construction performs no launch, installation or configuration repair. */
export async function startSupervisor({ env=process.env, log=message=>console.error(typeof message==='string'?message:JSON.stringify(message)), ...overrides }={}) {
  const root=zylosRoot(env), directory=path.join(root,'activity-monitor');
  fs.mkdirSync(directory,{recursive:true});
  const db=overrides.db ?? defaultDb, readMode=overrides.readMode ?? readSessionMode, readConfig=overrides.readConfig ?? readZylosConfigOrThrow;
  let supervisor,events,configuration,machineTasks,legacy;
  const pendingAlerts=new Set(),pendingNotices=new Set();
  const sendAlert=overrides.sendAlert ?? ((target,message)=>new Promise((resolve,reject)=>{
    const child=execFile(process.execPath,[fileURLToPath(new URL('../../comm-bridge/scripts/c4-send.js',import.meta.url)),target.channel,target.endpoint],
      {env,timeout:30000,maxBuffer:1024*1024},error=>error?reject(error):resolve(true));
    child.stdin.on('error',reject);child.stdin.end(message+'\n');
  }));
  const guard=new SupervisorServerHealth({getModeTransition:()=> db.getModeTransition(),
    lifecycleSerial:operation=>supervisor.admission.serialize(operation),
    readAlertTarget:()=>parseServerAlertTarget(configuration?.alert_target),sendAlert,log});
  const baseScenes=overrides.scenes ?? new SupervisorScenes({env,readMode:readMode,readActivity:scene=>supervisor.readActivity(scene)});
  const scenes=overrides.scenes ?? new SupervisorServerObservation(baseScenes,{guard});
  const targetReader=createSessionReader({env,connectionOptions:baseScenes.connectionOptions ?? {},resolveConfig:input=>db.resolveSessionLaunchConfig(input)});
  const alert=event=>{
    const pending=guard.notify(null,`Supervisor: ${event.event ?? event.reason ?? 'lifecycle requires attention'} (${event.sessionGroup ?? 'global'}).`);
    pendingAlerts.add(pending);pending.finally(()=>pendingAlerts.delete(pending)).catch(log);return pending;
  };
  const prompts={
    ROTATION_PROMPT:()=> 'Context usage has reached the session threshold. Complete required handoff and use the new-session skill to continue in a fresh session.',
    CONFIG_RECLAIM_PROMPT:()=> 'The launch configuration changed. Complete required background work and the session handoff, then submit ready_for_config_reclaim through the supervisor. After acceptance, finish this control and the current turn.',
  };
  let syncReader;
  try {
    const module=await import(new URL('../../zylos-memory/scripts/sync-lock.js',import.meta.url));syncReader=module.readSyncMarker;
    Object.assign(prompts,await import(new URL('../../zylos-memory/scripts/sync-prompts.js',import.meta.url)));
    if(typeof syncReader!=='function')throw unavailable('P07 Sync marker reader');
  }catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;log('P07 Sync dependencies are unavailable; affected actions will retain their state.');}
  const healthIdentity=scene=>Number.isSafeInteger(scene.runtimePid)?{runtime:scene.runtime,session_id:scene.sessionId,claude_pid:scene.runtimePid}:null;
  supervisor=createSupervisor({env,zylosDir:root,db,scenes,readMode,requestStore:new RestartRequestStore({file:path.join(directory,'restart-requests.json')}),
    readConfiguration:async()=>{
      const raw=await readConfig(), mode=(await readMode()).mode;
      if(!mode)throw Object.assign(new Error('Session mode requires the migration owner'),{code:'CONFIG_UNREADABLE'});
      configuration={...raw,mode};
      try {
        const pool=await loadCoreModule('session-pool-config.js');
        if(typeof pool.resolveSessionPoolSize!=='function')throw unavailable('P04 pool configuration reader');
        configuration.capacity=pool.resolveSessionPoolSize({env,config:raw});
      }catch(error){if(!['ERR_MODULE_NOT_FOUND','DEPENDENCY_UNAVAILABLE'].includes(error.code))throw error;delete configuration.capacity;log({error:'DEPENDENCY_UNAVAILABLE',dependency:'P04 pool configuration reader',affected:'eviction'});}
      return configuration;
    },
    resolveTargetRuntime:async group=>targetReader.resolveTargetRuntime(group==='origin' && (await readMode()).mode==='single'?null:group),
    checkAuth:runtime=>getSessionAdapter(runtime).checkAuth(),
    matchScreen:(runtime,screen)=>(runtime==='claude'?matchClaudeScreen:matchCodexScreen)(screen),
    resolveToolRule:(runtime,tool)=>findMatchingToolRule({runtimeId:runtime,toolName:tool.name,toolInput:tool.input,config:configuration}),
    readSyncMarker:options=>{if(!syncReader)throw unavailable('P07 Sync marker reader');return syncReader(options);},prompts,
    freezeNotice:options=>{
      const mode=configuration?.mode ?? readMode().mode;
      if(!['single','multi'].includes(mode))throw Object.assign(new Error('Notice mode is unavailable'),{code:'CONFIG_UNREADABLE'});
      return freezeFirstFailureNotice(db.getDb(),{...options,sessionGroup:mode==='single'?null:options.sessionGroup});
    },
    consumeHealthEvents:async(scene,coordinator)=>{
      const identity=healthIdentity(scene);if(!identity)return;
      events ??= new HealthEventReader({coordinator,zylosDir:root,warn:log,quota:(identity,current)=>readScopedHealthQuota({runDir:current.runDir,runId:current.runId,identity})});
      const results=await events.processScene(scene,identity);
      if(results.some(result=>result?.verify))void supervisor.observer.requestVerification(scene.runtime);
      const pending=drainFirstFailureNotices({store:coordinator.store(scene.runtime),sessionGroup:scene.sessionGroup ?? 'origin',
        identity:async()=>{const current=await scenes.observeGroup(scene.sessionGroup);return current.runId===scene.runId?healthIdentity(current):null;},
        quota:current=>readScopedHealthQuota({runDir:scene.runDir,runId:scene.runId,identity:current}),mutate:fn=>coordinator.serial(scene.runtime,fn),database:db.getDb(),zylosDir:root});
      pendingNotices.add(pending);pending.finally(()=>pendingNotices.delete(pending)).catch(log);
    },alert,log,...overrides,scenes,afterRound:async()=>{await scenes.advance?.();try{await legacy.tick();}catch(error){log({error:error.code ?? error.message,phase:'legacy-status'});}await machineTasks.tick();await overrides.afterRound?.();},
  });
  legacy=overrides.legacyStatus ?? new SupervisorLegacyStatus({env,connectionOptions:baseScenes.connectionOptions ?? {},readHealth:runtime=>supervisor.health.store(runtime).read(),log});
  machineTasks=overrides.machineTasks ?? new SupervisorMachineTasks({zylosDir:root,readMode,readConfig,readOriginState:async()=>scenes.observeGroup((await readMode()).mode==='single'?null:'origin'),readHealth:runtime=>supervisor.health.store(runtime).read(),log});
  const socketPath=path.join(directory,'am.sock');
  const sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
    supervisor.connectionHandler(socket);
  });
  let stopping;
  const stop=()=>stopping ??= (async()=>{
    // Reject new work before draining accepted work. Idle or partial-line peers
    // must not keep shutdown alive indefinitely.
    supervisor.admission.closeEntry();
    const closing=server.listening ? new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())) : Promise.resolve();
    for(const socket of sockets)socket.destroy();
    const stoppingSupervisor=supervisor.stop();stoppingSupervisor.catch(()=>{});
    await supervisor.loop.stop();await supervisor.connectionHandler.drain();
    await machineTasks.stop();
    while(pendingNotices.size)await Promise.allSettled([...pendingNotices]);
    await stoppingSupervisor;await supervisor.drainHealthWrites?.();
    events?.close();legacy.close();
    await Promise.allSettled([...pendingAlerts]);await closing;
  })();
  try {
    // A stale socket may be removed only after proving no listener accepts it.
    if(fs.existsSync(socketPath)) {
      const stat=fs.lstatSync(socketPath);
      if(!stat.isSocket())throw Object.assign(new Error('Supervisor socket path is not a socket'),{code:'EADDRINUSE'});
      const active=await new Promise((resolve,reject)=>{
        const socket=net.createConnection(socketPath);
        socket.setTimeout(3000,()=>{socket.destroy();reject(Object.assign(new Error('Existing Supervisor listener check timed out'),{code:'ETIMEDOUT'}));});
        socket.once('connect',()=>{socket.destroy();resolve(true);});
        socket.once('error',error=>{if(['ECONNREFUSED','ENOENT'].includes(error.code))resolve(false);else reject(error);});
      });
      if(active)throw Object.assign(new Error('Supervisor socket already has a listener'),{code:'EADDRINUSE'});
      fs.unlinkSync(socketPath);
    }
    await new Promise((resolve,reject)=>{
      const failed=error=>{server.off('listening',listening);reject(error);};
      const listening=()=>{server.off('error',failed);resolve();};
      server.once('error',failed);server.once('listening',listening);server.listen(socketPath);
    });
    server.on('error',error=>log({error:error.code ?? error.message,phase:'socket'}));
    fs.chmodSync(socketPath,0o600);
    await supervisor.loop.start();
  } catch(error) {
    try{await stop();}catch(cleanupError){log({error:cleanupError.code ?? cleanupError.message,phase:'startup-cleanup'});}
    throw error;
  }
  return {supervisor,server,stop};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const service=await startSupervisor();
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void service.stop().then(()=>process.exit(0),error=>{console.error(error.code ?? error.message);process.exit(1);});});
}
