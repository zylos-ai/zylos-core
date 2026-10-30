import { loadCoreModule } from './core-modules.js';
import path from 'node:path';
import { SupervisorLoop } from './supervisor-loop.js';
import { SupervisorAdmission } from './supervisor-admission.js';
import { ModeSwitchCoordinator } from './mode-switch.js';
import { createModeSwitchConverter } from './mode-switch-convert.js';
import { SupervisorLifecycle } from './supervisor-lifecycle.js';
import { RuntimeHealthCoordinator, aggregateRuntimeDemand } from './runtime-health.js';
import { SupervisorHealthObserver } from './supervisor-health-observer.js';
import { MessageRouter } from './message-router.js';
import { SupervisorExits } from './supervisor-exits.js';
import { SessionActivity } from './session-activity.js';
import { publishSessionStatus } from './status-writer.js';
import { createSupervisorConnectionHandler } from './router-socket.js';
const { appendEvent, rotateEventLog } = await loadCoreModule('event-log.js');
const { writeSessionModeAtCutover } = await loadCoreModule('config.js');
const { supervisorDiagnosticPath, poolMetricsPath } = await loadCoreModule('session-group-paths.js');

export const AUTH_DEMAND_RETRY_MS = 60000;

/** Compose observation, runtime health and the single lifecycle queue. */
export function createSupervisor(deps) {
  const { db, scenes, readConfiguration, readMode, readSyncMarker, prompts, now=Date.now, log=()=>{} }=deps;
  const activities=new Map();let configuration;let lastMetrics=null;let lastMaintenance=0;
  let observer,router,admission,lifecycle,modeSwitch,stopping=false,stopPromise,roundContext;
  const authChecks=new Set(),authFlights=new Map(),authRetryAt=new Map();
  const missingDependencies=deps.missingDependencies ?? new Set();
  const reportError=(error,context={})=>{
    if(['ERR_MODULE_NOT_FOUND','DEPENDENCY_UNAVAILABLE'].includes(error.code)) {
      const dependency=error.dependency ?? error.message;
      if(missingDependencies.has(dependency))return;
      missingDependencies.add(dependency);
      log({error:error.code,dependency,...context});return;
    }
    log({error:error.code || error.message,...context});
  };
  const diagnostic=event=>{try{appendEvent(supervisorDiagnosticPath(deps.env),{v:1,ts:now(),session_group:event.sessionGroup ?? null,conversation_id:null,decision:event.decision ?? event.event,reason:event.reason ?? '',...event});}catch(error){reportError(error,{phase:'diagnostic'});}};
  const readActivity=scene=>{
    let activity=activities.get(scene.sessionGroup);
    if(!activity || activity.runId!==scene.runId || activity.sessionId!==scene.sessionId) {
      activity?.close();activity=new SessionActivity({runDir:scene.runDir,runId:scene.runId,sessionId:scene.sessionId,runtime:scene.runtime,startedAt:scene.currentSessionTs ?? scene.createdAt,warn:log});activities.set(scene.sessionGroup,activity);
    }
    return activity.read(now());
  };
  const listScenes=()=>scenes.observe({configuration});
  const stopScene=async scene=>{
    await scenes.stop(scene);
    const group=value=>roundContext?.configuration?.mode==='single' && value===null?'origin':value;
    const sampled=roundContext?.scenes?.find(current=>group(current.sessionGroup)===group(scene.sessionGroup) && current.runId===scene.runId);
    if(sampled)Object.assign(sampled,{present:false,ready:false,processRunning:false});
  };
  const health=new RuntimeHealthCoordinator({zylosDir:deps.zylosDir,now,readMode:async()=>(await readMode()).mode,
    resolveTargetRuntime:deps.resolveTargetRuntime,listScenes,probeInFlight:runtime=>observer.probeInFlight(runtime),
    readNegativeCache:(runtime,state)=>router.readNegativeCache(runtime,state.health,state.reason),clearNegativeCache:runtime=>router.clearCache(runtime),freezeNotice:deps.freezeNotice,log});
  const manualPending=()=>admission.readRequests().some(row=>row.reason==='manual_restart');
  const guardedAction=(scene,action)=>admission.serialize(async()=>{
    if(stopping || await db.getModeTransition() || (scene.sessionGroup==='origin' && manualPending()))return false;
    const current=await scenes.readIdentity(scene.sessionGroup);
    if(!current.present || !current.ready || current.runId!==scene.runId || current.runtime!==scene.runtime)return false;
    await action(current);return true;
  });
  const checkAuth=(runtime,{background=false}={})=>{
    if(stopping)return Promise.resolve({status:'uncertain',reason:'supervisor_stopping'});
    // Router, pane checks and pending demand share one actual adapter call.
    if(authFlights.has(runtime))return authFlights.get(runtime);
    // Real incoming messages may retry immediately; the 1 s loop
    // must not turn retained pending demand into repeated expensive CLI pings.
    if(background && now()<(authRetryAt.get(runtime) ?? 0))return Promise.resolve({status:'uncertain',reason:'auth_retry_backoff'});
    const task=Promise.resolve().then(async()=>{
      const result=await deps.checkAuth(runtime);
      if(!stopping && (result.status==='success' || result.result==='success'))await health.beginAuthRecovery(runtime,result,await listScenes());
      return result;
    });
    authFlights.set(runtime,task);authChecks.add(task);
    task.finally(()=>{
      authRetryAt.set(runtime,now()+AUTH_DEMAND_RETRY_MS);
      authFlights.delete(runtime);authChecks.delete(task);
    }).catch(()=>{});return task;
  };
  observer=new SupervisorHealthObserver({coordinator:health,listScenes,readIdentity:group=>scenes.readIdentity(group),readState:scene=>({...readActivity(scene),healthIdentity:scene.healthIdentity,contextSwitches:scene.contextSwitches}),
    readScreen:scene=>scenes.readScreen(scene),matchScreen:deps.matchScreen,insertControl:db.insertControl,getControlById:db.getControlById,
    buildTargetBinding:scene=>scenes.bindTarget(scene),stop:scene=>guardedAction(scene,current=>stopScene(current)),
    readMode:async()=>(await readMode()).mode,getModeTransition:db.getModeTransition,getDrainFence:db.getDrainFence,manualPending,
    resolveToolRule:deps.resolveToolRule,interrupt:async(scene,key)=>({ok:await guardedAction(scene,async current=>{
      const mode=(await readMode()).mode;db.insertControl(`[KEYSTROKE]${key}`,{sessionGroup:mode==='single'?null:current.sessionGroup,
        targetBinding:await scenes.bindTarget(current),priority:0,bypassState:true,appendAckSuffix:false});
    })}),checkAuth,diagnostic,now,log});
  router=new MessageRouter({healthCoordinator:health,resolveTargetRuntime:deps.resolveTargetRuntime,getModeTransition:db.getModeTransition,
    cacheDirectory:path.join(deps.zylosDir,'activity-monitor','message-router-probe-cache'),
    checkAuth,requestProbe:runtime=>observer.requestProbe(runtime),log,now});
  admission=new SupervisorAdmission({db,store:deps.requestStore,readMode,listRuns:()=>scenes.listRuns(),readRun:group=>scenes.readRun(group),
    resolveLaunchConfig:async group=>db.resolveSessionLaunchConfig({sessionGroup:group,sessionMode:(await readMode()).mode}),
    preflightReclaim:(scene,context)=>lifecycle.checkReclaimDependencies(scene,context),
    modeSwitch:request=>modeSwitch.handle(request),startAttempt:request=>health.registerStartAttempt(request),diagnostic,now});
  lifecycle=new SupervisorLifecycle({db,observeGroup:group=>scenes.observeGroup(group),observe:listScenes,stop:stopScene,readSyncMarker,prompts,
    requests:admission.store,alert:deps.alert,bindTarget:scene=>scenes.bindTarget(scene),diagnostic,reportError},{now});
  modeSwitch=new ModeSwitchCoordinator({db,readMode,readConfiguration,readRequests:()=>admission.readRequests(),
    legacyPresent:deps.legacyPresent,observe:context=>scenes.observe(context),lifecycle,serialize:operation=>admission.serialize(operation),
    convert:deps.convertModeTransition ?? createModeSwitchConverter({db,zylosDir:deps.zylosDir}),
    writeMode:deps.writeMode ?? writeSessionModeAtCutover,restart:deps.restartDispatcherConfirmation,diagnostic,now});
  const exits=new SupervisorExits({scenes:{observeGroup:group=>scenes.observeGroup(group),stop:stopScene},db,serialize:operation=>admission.serialize(operation),readMode,diagnostic,reportError,env:deps.env});
  const lifecycleMethods=Object.fromEntries(['advanceManual','advanceRestarts','reconcileConfiguration','advanceReclaim','checkRotation','checkTtl','checkEviction','checkSync'].map(name=>[name,(...args)=>lifecycle[name](...args)]));
  const loop=new SupervisorLoop({
    readConfiguration:async transition=>{
      roundContext=null;
      try {configuration=await readConfiguration();modeSwitch.recordConfigurationRead();return configuration;}
      catch(error) {
        if(transition===null)modeSwitch.recordConfigurationRead(error);
        throw error;
      }
    },
    restore:async()=>{
      try{admission.restore();}catch(error){if(error.code!=='requests_unreadable')throw error;reportError(error,{phase:'requests'});}
      for(const runtime of ['claude','codex'])await health.restore(runtime);
      router.clearLegacyCache(path.join(deps.zylosDir,'activity-monitor','message-router-probe-cache.json'));await deps.restoreTransition?.();
    },openAdmission:()=>admission.openEntry(),reportError,getModeTransition:db.getModeTransition,listDrainFences:db.listDrainFences,readRestartRequests:()=>admission.readRequests(),
    advanceAutomaticMigration:()=>modeSwitch.automatic(),
    advanceTransition:()=>modeSwitch.advance(),
    lifecycleSerial:operation=>admission.serialize(operation),checkManualFences:context=>lifecycle.checkManualFences(context),...lifecycleMethods,observe:context=>{roundContext=context;return listScenes();},
    observeExits:current=>exits.advance(current),
    afterRound:()=>deps.afterRound?.({health,lifecycle,admission,context:roundContext}),
    probeAndPublish:async(scene,context)=>{
      if(!scene.ready || scene.processRunning!==true || !scene.runId || !scene.sessionId)return;
      const matches=current=>current.present && current.ready && current.runId===scene.runId && current.sessionId===scene.sessionId && current.runtime===scene.runtime;
      // The round owns the process sample. Recheck only run/session identity at
      // publication boundaries; do not resample every read-only health check.
      if(!matches(await scenes.readIdentity(scene.sessionGroup)))return;
      const activity=readActivity(scene);
      await deps.consumeHealthEvents?.(scene,health);
      if(!matches(await scenes.readIdentity(scene.sessionGroup)))return;
      publishSessionStatus({statusFile:path.join(scene.runDir,'agent-status.json'),scene,activity,health:health.store(scene.runtime).read(),proc:scene.proc,now:now()});
      await observer.observeScene(scene);
    },
    writeMetricsAndMaintain:async context=>{
      const current=context.scenes.filter(scene=>scene.present!==false);
      for(const probe of [...observer.probes.values()]) {
        try { await observer.pollProbe(probe); }
        catch(error) { reportError(error,{phase:'recovery-probe',runtime:probe.runtime}); }
      }
      const pendingGroups=await db.listPendingSessionGroups();
      const demand=await aggregateRuntimeDemand({mode:configuration.mode,pendingGroups,fences:context.fences,resolveTargetRuntime:deps.resolveTargetRuntime,baselineRuntime:configuration.runtime});
      for(const runtime of demand.keys())observer.driveDemand(runtime);
      const metrics={ready:current.filter(s=>s.sessionGroup!=='origin' && s.ready).length,starting:current.filter(s=>s.sessionGroup!=='origin' && !s.ready).length,
        reclaiming:context.fences.filter(f=>f.sessionGroup!=='*').length,waiting:pendingGroups.filter(g=>!current.some(s=>s.sessionGroup===g.sessionGroup)).length};
      if(JSON.stringify(metrics)!==lastMetrics) {
        try { appendEvent(poolMetricsPath(deps.env),{v:1,ts:now(),...metrics});lastMetrics=JSON.stringify(metrics); }
        catch(error) { reportError(error,{phase:'pool-metrics'}); }
      }
      if(now()-lastMaintenance>=60000) {
        for(const file of [supervisorDiagnosticPath(deps.env),poolMetricsPath(deps.env),...current.map(s=>path.join(s.runDir,'events.jsonl'))]) {
          try { rotateEventLog(file,{now:now()}); }
          catch(error) { reportError(error,{phase:'log-maintenance'}); }
        }
        lastMaintenance=now();
      }
      for(const runtime of ['claude','codex']) {
        if(health.store(runtime).read().health!=='auth_failed')continue;
        if(!health.authRecoveries.has(runtime)) {
          if(!demand.has(runtime))continue;
          const result=await checkAuth(runtime,{background:true});
          if(result.status!=='success')continue;
        }
        const targets=health.authTargets(runtime);
        await admission.serialize(async()=>{
          const fresh={configuration:await readConfiguration(),transition:await db.getModeTransition(),
            fences:await db.listDrainFences(),restartRequests:admission.readRequests()};
          if(fresh.transition)return;
          fresh.scenes=await scenes.observe({configuration:fresh.configuration});
          for(const target of targets) {
            if((target.sessionGroup==='origin' || target.sessionGroup===null) && fresh.restartRequests.some(row=>row.reason==='manual_restart'))continue;
            const observed=fresh.scenes.find(scene=>scene.sessionGroup===target.sessionGroup || (scene.sessionGroup==='origin' && target.sessionGroup===null));
            if(!observed?.present || observed.runId!==target.runId || !observed.ready)continue;
            if(fresh.configuration.mode==='single')await lifecycle.advanceReclaim({sessionGroup:null,reason:'auth',runId:target.runId},fresh,{unfenced:true,singleAuth:true});
            else await lifecycle.beginReclaim(observed,'auth',fresh);
          }
        });
        await health.completeAuthRecovery(runtime,{isGone:async target=>{
          const observed=await scenes.readIdentity(target.sessionGroup);
          return observed.present===false || (typeof observed.runId==='string' && observed.runId!==target.runId);
        },hasAuthFence:async target=>configuration.mode==='multi' && (await db.getDrainFence(target.sessionGroup))?.reason==='auth'});
      }

    },
  },deps.loopOptions);
  const connectionHandler=createSupervisorConnectionHandler({admission,router,isOpen:()=>admission.open && !stopping,readRun:group=>scenes.readRun(group),readMode,
    onDelivered:notification=>observer.notifyDelivered({...notification,sessionGroup:notification.sessionGroup ?? 'origin'}),onHealthEvents:()=>{void loop.tick();},log});
  const drainHealthWrites=async()=>{
    while(health.queues.size)await Promise.allSettled([...health.queues.values()]);
  };
  return {loop,health,observer,router,admission,lifecycle,modeSwitch,connectionHandler,readActivity,drainHealthWrites,
    stop(){
      if(stopPromise)return stopPromise;
      stopping=true;admission.closeEntry();
      const observerStopping=observer.shutdown();
      stopPromise=(async()=>{
        await loop.stop();await observerStopping;
        await Promise.allSettled([...authChecks]);
        await connectionHandler.drain?.();await admission.tail;await drainHealthWrites();
        for(const activity of activities.values())activity.close();
      })();
      return stopPromise;
    }};
}
