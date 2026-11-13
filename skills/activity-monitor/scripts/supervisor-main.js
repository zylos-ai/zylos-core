import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as defaultDb from '../../comm-bridge/scripts/c4-db.js';
import { freezeFirstFailureNotice, drainFirstFailureNotices } from '../../comm-bridge/scripts/first-failure-notice.js';
import { loadCoreModule } from './core-modules.js';
import { createSupervisor } from './supervisor.js';
import { prepareReferenceReorg } from './reference-reorg-proposal.js';
import { SupervisorServerHealth } from './supervisor-server-health.js';
import { SupervisorServerObservation, parseServerAlertTarget } from './supervisor-server-observation.js';
import { SupervisorLegacyStatus } from './supervisor-legacy-status.js';
import { SupervisorScenes } from './supervisor-scenes.js';
import { SupervisorMachineTasks } from './supervisor-machine-tasks.js';
import { parseSupervisorConfiguration } from './supervisor-configuration.js';
import { readScopedHealthQuota } from './health-quota.js';
import { HealthEventReader } from './health-event-reader.js';
import { RestartRequestStore } from './restart-request-store.js';
import { findMatchingToolRule } from './tool-rules.js';
import { PoolCapacity } from './pool-capacity.js';
import { messageForStatus } from '../../comm-bridge/scripts/status-notice-templates.js';
import { systemSendEnvironment } from '../../comm-bridge/scripts/c4-system-send-env.js';
import { CONFIG_RECLAIM_PROMPT, PRE_RECLAIM_CHECK_PROMPT, UPGRADE_RESTART_CHECK_PROMPT } from './reclaim-prompts.js';
const { readSessionMode, readZylosConfigOrThrow } = await loadCoreModule('config.js');
const { getSessionAdapter } = await loadCoreModule('runtime/index.js');
const { openTmuxConnection } = await loadCoreModule('runtime/tmux-connection.js');
const { observeSessionTarget } = await loadCoreModule('runtime/session-target.js');
const { zylosRoot, LEGACY_TMUX_NAMES } = await loadCoreModule('session-group-paths.js');
const { readDefaultModels, readCodexModelWindows } = await loadCoreModule('model-rotation-thresholds.js');
const { resolveSessionHotTtl } = await loadCoreModule('session-hot-ttl.js');
const { createSessionReader } = await loadCoreModule('session-state-reader-async.js');
const { matchClaudeScreen } = await loadCoreModule('heartbeat/claude-probe.js');
const { matchCodexScreen } = await loadCoreModule('heartbeat/codex-probe.js');
const unavailable = name => Object.assign(new Error(`${name} is unavailable on this code baseline`),{code:'DEPENDENCY_UNAVAILABLE',dependency:name});

/** Entry construction performs no launch, installation or configuration repair. */
export async function startSupervisor({ env=process.env, log=message=>console.error(typeof message==='string'?message:JSON.stringify(message)), ...overrides }={}) {
  const root=zylosRoot(env), directory=path.join(root,'activity-monitor');
  fs.mkdirSync(directory,{recursive:true});
  const db=overrides.db ?? defaultDb, readModeSource=overrides.readMode ?? readSessionMode, readConfig=overrides.readConfig ?? readZylosConfigOrThrow;
  const normalizeMode=result=>{
    if(result?.keyPresent===false && result.mode===null)return {...result,mode:'single',legacy:true};
    if(!['single','multi'].includes(result?.mode))throw Object.assign(new Error('Session mode is unavailable'),{code:'CONFIG_UNREADABLE'});
    return {...result,legacy:false};
  };
  const readMode=()=>{const result=readModeSource();return result?.then?result.then(normalizeMode):normalizeMode(result);};
  let supervisor,events,configuration,machineTasks,legacy,lifecycleConfiguration,stopping;
  let poolReader,capacityController;
  const capacityWork=new Set(),clock=overrides.now ?? Date.now;
  const applyPublishedCapacity=()=>{
    const result=poolReader.readPoolCapacity({env,record:capacityController.lastPublished,
      baseline:()=>poolReader.resolveSessionPoolBaseline({env,config:configuration}),now:clock()});
    configuration.capacity=result.k;configuration.capacitySource=result.source;
  };
  const updateCapacity=context=>{
    if(!capacityController)return;
    // Memory commands run independently of the one-second lifecycle loop.
    const work=capacityController.tick({mode:context.configuration.mode,
      scenes:context.scenes.map(scene=>({...scene})),transitioning:Boolean(context.transition),now:clock()});
    capacityWork.add(work);
    work.catch(error=>log({error:error.code ?? error.message,phase:'capacity'}))
      .finally(()=>capacityWork.delete(work));
  };
  const pendingAlerts=new Set(),pendingNotices=new Set();
  const sendAlert=overrides.sendAlert ?? ((target,message)=>new Promise((resolve,reject)=>{
    const child=execFile(process.execPath,[fileURLToPath(new URL('../../comm-bridge/scripts/c4-send.js',import.meta.url)),target.channel,target.endpoint],
      {env:systemSendEnvironment(env,{notice:true}),timeout:30000,maxBuffer:1024*1024},error=>error?reject(error):resolve(true));
    child.stdin.on('error',reject);child.stdin.end(message+'\n');
  }));
  const guard=new SupervisorServerHealth({readAlertTarget:()=>parseServerAlertTarget(configuration?.alert_target),sendAlert,log});
  const capacityAlert=()=>{
    const options={context:'capacity',noticeCode:'memory_low'};
    const pending=(async()=>{
      const message=messageForStatus(options,configuration?.statusNotices ?? {});
      await guard.notify(message);
    })();
    pendingAlerts.add(pending);pending.finally(()=>pendingAlerts.delete(pending)).catch(log);
  };
  const baseScenes=overrides.scenes ?? new SupervisorScenes({env,readMode:readMode,readActivity:scene=>supervisor.readActivity(scene)});
  const scenes=overrides.scenes ?? new SupervisorServerObservation(baseScenes,{guard});
  const reclaimCapacity=()=>supervisor.admission.serialize(async()=>{
    // Re-read configuration without applying another capacity refresh. A bad
    // configuration still blocks lifecycle mutations, including pressure reclaim.
    const raw=await readConfig(), {mode}=await readMode();
    if(mode!=='multi' || poolReader.resolveSessionPoolBaseline({env,config:raw}).fixed)return null;
    const latest = parseSupervisorConfiguration(raw,env);
    const context={configuration:{...configuration,...raw,...lifecycleConfiguration,
      reclaimDeferMaxSeconds:latest.reclaimDeferMaxSeconds,reclaimDeferAlertSeconds:latest.reclaimDeferAlertSeconds,mode,rotationPolicy:raw},
      transition:await db.getModeTransition(),fences:await db.listDrainFences(),restartRequests:supervisor.admission.readRequests()};
    context.scenes=await scenes.observe(context);
    if(stopping)return null;
    return supervisor.lifecycle.checkCapacityPressure(context);
  });
  const targetReader=createSessionReader({env,connectionOptions:baseScenes.connectionOptions ?? {},resolveConfig:input=>db.resolveSessionLaunchConfig(input)});
  const resolveTargetRuntime=async group=>targetReader.resolveTargetRuntime(group==='origin' && (await readMode()).mode==='single'?null:group);
  const alert=event=>{
    const details=[event.requestId && `requestId=${event.requestId}`,event.reason && `reason=${event.reason}`,
      event.runtime && `runtime=${event.runtime}`,event.oldest_at!==undefined && `oldest_at=${event.oldest_at}`,event.message].filter(Boolean).join(' ');
    const message=event.event==='repeated_unexpected_run_end'
      ? messageForStatus({context:'repeated_failure',noticeCode:'ended_unexpectedly',group:event.sessionGroup ?? event.session_group,count:event.count},configuration?.statusNotices ?? {})
      : `Supervisor: ${event.event ?? 'lifecycle requires attention'} (${event.sessionGroup ?? event.session_group ?? 'global'}). ${details}`.trim();
    const pending=guard.notify(message);
    pendingAlerts.add(pending);pending.finally(()=>pendingAlerts.delete(pending)).catch(log);return pending;
  };
  const prompts={
    ROTATION_PROMPT:()=> 'Context usage has reached the session threshold. Complete required handoff and use the new-session skill to continue in a fresh session.',
    CONFIG_RECLAIM_PROMPT,
    PRE_RECLAIM_CHECK_PROMPT,
    UPGRADE_RESTART_CHECK_PROMPT,
  };
  const missingDependencies=new Set();
  const dependencyMissing=(dependency,affected)=>{if(missingDependencies.has(dependency))return;missingDependencies.add(dependency);log({error:'DEPENDENCY_UNAVAILABLE',dependency,affected});};
  let syncReader;
  try {
    const module=await import(new URL('../../zylos-memory/scripts/sync-lock.js',import.meta.url));syncReader=module.readSyncMarker;
    Object.assign(prompts,await import(new URL('../../zylos-memory/scripts/sync-prompts.js',import.meta.url)));
    if(typeof syncReader!=='function')throw unavailable('Sync marker reader');
  }catch(error){if(!['ERR_MODULE_NOT_FOUND','DEPENDENCY_UNAVAILABLE'].includes(error.code))throw error;dependencyMissing('Sync marker reader','Sync actions retain their state');}
  const healthIdentity=scene=>Number.isSafeInteger(scene.runtimePid)?{runtime:scene.runtime,session_id:scene.sessionId,claude_pid:scene.runtimePid}:null;
  supervisor=createSupervisor({env,zylosDir:root,db,scenes,readMode,missingDependencies,requestStore:new RestartRequestStore({file:path.join(directory,'restart-requests.json')}),
    readConfiguration:async()=>{
      const raw=await readConfig(), {mode,legacy}=await readMode();
      lifecycleConfiguration ??= parseSupervisorConfiguration(raw,env);
      const deferConfiguration = parseSupervisorConfiguration(raw,env);
      configuration={...raw,...lifecycleConfiguration,mode,legacy,capacityUnavailable:false,
        hotTtlSeconds:resolveSessionHotTtl(raw,env).seconds,
        reclaimDeferMaxSeconds:deferConfiguration.reclaimDeferMaxSeconds,
        reclaimDeferAlertSeconds:deferConfiguration.reclaimDeferAlertSeconds,
        rotationPolicy: raw, defaultModels: readDefaultModels({zylosDir:root,home:env.HOME,codexHome:env.CODEX_HOME}),
        codexModels: readCodexModelWindows({home:env.HOME,codexHome:env.CODEX_HOME})};
      if(mode!=='multi') {
        if(capacityController)updateCapacity({configuration,scenes:[]});
        return configuration;
      }
      try {
        const pool=await loadCoreModule('session-pool-config.js');
        if(!['readMemoryInputs','resolveSessionPoolBaseline','readPoolCapacity'].every(name=>typeof pool[name]==='function'))throw unavailable('Session pool configuration reader');
        poolReader=pool;
        capacityController ??=new PoolCapacity({directory,now:clock,log:event=>supervisor.diagnostic(event),
          readMemory:overrides.readMemoryInputs ?? (()=>poolReader.readMemoryInputs({env})),
          resolveBaseline:()=>poolReader.resolveSessionPoolBaseline({env,config:configuration}),
          notify:capacityAlert,reclaim:reclaimCapacity});
        applyPublishedCapacity();
      }catch(error){if(!['ERR_MODULE_NOT_FOUND','DEPENDENCY_UNAVAILABLE'].includes(error.code))throw error;delete configuration.capacity;configuration.capacityUnavailable=true;dependencyMissing('Session pool configuration reader','eviction');}
      return configuration;
    },
    legacyPresent:async()=>{
      let connection;
      try {
        connection=await openTmuxConnection(baseScenes.connectionOptions ?? {});
        for(const tmuxName of LEGACY_TMUX_NAMES) {
          const target=await observeSessionTarget({sessionGroup:null,tmuxName,connection});
          if(target.present)return true;
        }
        return false;
      } catch(error) { if(error.code==='TMUX_NO_SERVER')return false;throw error; }
      finally {await connection?.close();}
    },
    resolveTargetRuntime,
    checkAuth:runtime=>getSessionAdapter(runtime).checkAuth(),
    matchScreen:(runtime,screen)=>(runtime==='claude'?matchClaudeScreen:matchCodexScreen)(screen),
    resolveToolRule:(runtime,tool)=>findMatchingToolRule({runtimeId:runtime,toolName:tool.name,toolInput:tool.input,config:configuration}),
    prepareReferenceReorg:()=>prepareReferenceReorg({root,now:clock()}),
    readSyncMarker:options=>{if(!syncReader)throw unavailable('Sync marker reader');return syncReader(options);},prompts,
    freezeNotice:options=>{
      const mode=configuration?.mode ?? readMode().mode;
      if(!['single','multi'].includes(mode))throw Object.assign(new Error('Notice mode is unavailable'),{code:'CONFIG_UNREADABLE'});
      return freezeFirstFailureNotice(db.getDb(),{...options,sessionGroup:mode==='single'?null:options.sessionGroup});
    },
    consumeHealthEvents:async(scene,coordinator)=>{
      const identity=healthIdentity(scene);if(!identity)return;
      events ??= new HealthEventReader({coordinator,zylosDir:root,warn:log,quota:(identity,current)=>readScopedHealthQuota({runDir:current.runDir,runId:current.runId,identity})});
      const results=await events.consumeScene(scene,identity);
      if(results.some(result=>result?.verify))void supervisor.observer.requestVerification(scene.runtime);
      const pending=drainFirstFailureNotices({store:coordinator.store(scene.runtime),sessionGroup:scene.sessionGroup ?? 'origin',
        identity:async()=>{const current=await scenes.readIdentity(scene.sessionGroup);return current.present && current.ready && current.runId===scene.runId && current.sessionId===scene.sessionId && current.runtime===scene.runtime?identity:null;},
        quota:current=>readScopedHealthQuota({runDir:scene.runDir,runId:scene.runId,identity:current}),mutate:fn=>coordinator.serial(scene.runtime,fn),database:db.getDb(),zylosDir:root});
      pendingNotices.add(pending);pending.finally(()=>pendingNotices.delete(pending)).catch(log);
    },alert,log,...overrides,readMode,scenes,updateCapacity,afterRound:async({context})=>{await scenes.advance?.();try{await legacy.tick();}catch(error){log({error:error.code ?? error.message,phase:'legacy-status'});}await machineTasks.tick(context);await overrides.afterRound?.();},
  });
  legacy=overrides.legacyStatus ?? new SupervisorLegacyStatus({env,connectionOptions:baseScenes.connectionOptions ?? {},readHealth:runtime=>supervisor.health.store(runtime).read(),log});
  machineTasks=overrides.machineTasks ?? new SupervisorMachineTasks({zylosDir:root,readMode,readConfig,resolveTargetRuntime,readHealth:runtime=>supervisor.health.store(runtime).read(),log});
  const socketPath=path.join(directory,'am.sock');
  const sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
    supervisor.connectionHandler(socket);
  });
  const stop=()=>stopping ??= (async()=>{
    // Reject new work before draining accepted work. Idle or partial-line peers
    // must not keep shutdown alive indefinitely.
    supervisor.admission.closeEntry();
    const closing=server.listening ? new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())) : Promise.resolve();
    for(const socket of sockets)socket.destroy();
    const stoppingSupervisor=supervisor.stop();stoppingSupervisor.catch(()=>{});
    await supervisor.loop.stop();await supervisor.connectionHandler.drain();
    await Promise.allSettled([...capacityWork]);
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
