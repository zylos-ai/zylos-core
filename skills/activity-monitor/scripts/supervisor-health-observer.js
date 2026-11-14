import { createHash } from 'node:crypto';
import { recoveryEligibility } from './runtime-health.js';

const USER_MESSAGE_CHECK_DELAY_MS = 5000;
export const NO_RESPONSE_SILENCE_MS = 15 * 60 * 1000;
// Use the allowed three-minute upper bound to leave interrupted work time to resume.
export const NO_RESPONSE_GRACE_MS = 3 * 60 * 1000;
export const NO_RESPONSE_RETRY_MS = 60000;
const RECOVERY_IDLE_WAIT_MS = 30 * 60 * 1000;
const TERMINAL = new Set(['done', 'failed', 'timeout', 'cancelled', 'superseded']);
const fingerprint = text => createHash('sha256').update(String(text ?? '')).digest('hex');
const sameRun = (a, b) => Boolean(a && b && a.runtime === b.runtime && a.runId && a.runId === b.runId);

/** Observation owns no process launcher and never waits for an acknowledgement in tick. */
export class SupervisorHealthObserver {
  constructor({ coordinator, listScenes, readIdentity, readState, readScreen, matchScreen,
    insertControl, getControlById, buildTargetBinding, stop, readMode,
    getModeTransition = () => null, getDrainFence = () => null, manualPending = () => false,
    resolveToolRule = () => null, nudge, checkAuth, diagnostic = () => {}, now = Date.now,
    log = () => {}, recoveryDeadlineMs = 120000 } = {}) {
    Object.assign(this, { coordinator, listScenes, readIdentity, readState, readScreen, matchScreen,
      insertControl, getControlById, buildTargetBinding, stop, readMode, getModeTransition,
      getDrainFence, manualPending, resolveToolRule, nudge, checkAuth, diagnostic, now, log, recoveryDeadlineMs });
    this.probes = new Map();
    this.scenes = new Map();
    this.verifications = new Map();
    this.preparations = new Set();
    this.recoveryWaits = new Map();
    this.stopped = false;
  }
  probeInFlight(runtime) { return this.probes.has(runtime); }
  sceneState(scene) {
    let state = this.scenes.get(scene.sessionGroup);
    if (!state || !sameRun(state, scene)) {
      state = { runtime: scene.runtime, runId: scene.runId, delivery: null, rateHits:0, sticky: null, watchdog: null };
      this.scenes.set(scene.sessionGroup, state);
    }
    return state;
  }
  notifyDelivered({ sessionGroup, runId, runtime, pastedAt }, {currentSessionTs} = {}) {
    if (this.stopped || !sessionGroup || !runId || !runtime || !Number.isFinite(pastedAt)) return false;
    const state = this.sceneState({sessionGroup, runId, runtime});
    if (!state.delivery || pastedAt > state.delivery.pastedAt) {
      const previous=state.delivery;
      state.delivery = {pastedAt, silenceSince:previous?.noResponseEligible ? previous.silenceSince : pastedAt, noResponseEligible:!Number.isFinite(currentSessionTs) || pastedAt>=currentSessionTs,
        screenChecked:false, recovery:previous?.recovery ?? null, retryAt:previous?.retryAt ?? 0};
    }
    return true;
  }
  async canAct(scene, { requireReady = false, requireOpen = false } = {}) {
    if (this.stopped || await this.getModeTransition()) return false;
    if (scene.sessionGroup === 'origin' && await this.manualPending()) return false;
    if (requireOpen && (await this.getDrainFence('*') || await this.getDrainFence(scene.sessionGroup))) return false;
    const current = await this.readIdentity(scene.sessionGroup);
    return !this.stopped && sameRun(scene, current) && current.present !== false && (!requireReady || current.ready === true);
  }
  async canRecover(scene) {
    if(!await this.canAct(scene,{requireReady:true,requireOpen:true}))return false;
    const current=await this.readIdentity(scene.sessionGroup);
    return current?.sessionId===scene.sessionId;
  }
  async stopScene(scene, event, validate = null, details = {}) {
    if (!await this.canAct(scene, {requireReady:true})) return false;
    if ((validate && !await validate(scene)) || await this.stop(scene, validate) === false)return false;
    await this.diagnostic({event, sessionGroup:scene.sessionGroup, runId:scene.runId, run_id:scene.runId, runtime:scene.runtime,...details});
    return true;
  }
  async due(runtime, target = null) {
    const state = await this.coordinator.restore(runtime);
    if (state.health === 'ok' || state.health === 'auth_failed') this.recoveryWaits.delete(runtime);
    const cache = await this.coordinator.readNegativeCache(runtime, state);
    const attempt = this.coordinator.registeredAttempt(runtime);
    // Registration already charged this run's attempt. Its confirming probe
    // completes that attempt; only a later attempt waits for the next backoff.
    const continuingAttempt = state.health === 'rate_limited' && attempt && (target ? [target] : await this.listScenes()).some(scene =>
      scene.sessionGroup === attempt.sessionGroup && scene.runId === attempt.runId && scene.runtime === runtime &&
      scene.ready === true && scene.present !== false && scene.processRunning !== false);
    return recoveryEligibility(state, { runtime, cache, nowMs: this.now(), continuingAttempt }).eligible;
  }
  requestProbe(runtime, {force=false,phase='recovery'} = {}) {
    if(this.stopped)return Promise.resolve({recovered:false,stopped:true});
    const existing = this.probes.get(runtime);
    if (existing) return existing.promise;
    let resolve, reject;
    const promise = new Promise((yes,no) => {resolve=yes;reject=no;});
    const pending = {runtime, promise, resolve, reject, preparing:true,force,phase};
    this.probes.set(runtime,pending);
    const preparation=this.prepareProbe(pending).catch(error => {
      // Once C4 accepted the control, a later health-file failure must not permit a duplicate probe.
      if (!pending.controlId) this.finish(pending,{recovered:false,error:error.message});
      this.log(error);
    }).finally(()=>this.preparations.delete(preparation));
    this.preparations.add(preparation);
    return promise;
  }
  requestVerification(runtime) {
    if(this.stopped)return Promise.resolve({recovered:false,stopped:true});
    const last=this.verifications.get(runtime);
    if(last !== undefined && this.now()-last < 60000)return Promise.resolve({recovered:false});
    this.verifications.set(runtime,this.now());
    return this.requestProbe(runtime,{force:true,phase:'hook_evidence_unordered'});
  }
  driveDemand(runtime) {
    // A caller never awaits the eventual control outcome while holding a lifecycle queue.
    void this.requestProbe(runtime);
  }
  finish(probe, result) {
    if (this.probes.get(probe.runtime) === probe) this.probes.delete(probe.runtime);
    probe.resolve(result);
  }
  async recoveryScenes(runtime, scenes, { requireRunning = false } = {}) {
    const eligible = [];
    for (const scene of scenes) {
      if (scene.runtime !== runtime || !scene.runId || scene.ready !== true || scene.present === false ||
          (requireRunning && scene.processRunning === false)) continue;
      if (await this.canAct(scene, {requireReady:true,requireOpen:true})) eligible.push(scene);
    }
    return eligible;
  }
  async reconcileRecoveryWaits(demand, scenes) {
    const multi = await this.readMode() === 'multi';
    for (const runtime of this.recoveryWaits.keys()) {
      const health = this.coordinator.store(runtime).read().health;
      if (!multi || !demand.has(runtime) || health === 'ok' || health === 'auth_failed' ||
          !(await this.recoveryScenes(runtime, scenes, {requireRunning:true})).length) this.recoveryWaits.delete(runtime);
    }
  }
  async prepareProbe(probe) {
    if(this.stopped)return this.finish(probe,{recovered:false,stopped:true});
    if (!probe.force && !await this.due(probe.runtime)) return this.finish(probe,{recovered:false});
    const mode = await this.readMode();
    const idleOnly = mode === 'multi' && probe.phase === 'recovery';
    const scenes = await this.recoveryScenes(probe.runtime, await this.listScenes(), {requireRunning:idleOnly});
    const candidates = [];
    for (const scene of scenes) candidates.push({scene, idle:idleOnly ? (await this.readState(scene))?.state === 'idle' : true});
    candidates.sort((a,b) => Number(b.idle)-Number(a.idle) ||
      (a.scene.sessionGroup === 'origin' ? -1 : b.scene.sessionGroup === 'origin' ? 1 : a.scene.sessionGroup.localeCompare(b.scene.sessionGroup)));
    const waitAt = this.recoveryWaits.get(probe.runtime);
    const forcedBusy = idleOnly && waitAt !== undefined && this.now()-waitAt >= RECOVERY_IDLE_WAIT_MS;
    let busy = false;
    for (const {scene} of candidates) {
      const binding = await this.buildTargetBinding(scene);
      // Binding construction may perform I/O; repeat identity and gates immediately before insertion.
      if (!await this.canAct(scene,{requireReady:true,requireOpen:true}) || this.stopped) continue;
      if (!probe.force && !await this.due(probe.runtime, scene)) continue;
      if (idleOnly && !forcedBusy && (await this.readState(scene))?.state !== 'idle') {busy = true;continue;}
      const sentAt = this.now();
      const deadline = sentAt + (probe.phase === 'recovery' ? this.recoveryDeadlineMs : 300000);
      const control = await this.insertControl(`Heartbeat check. [phase=${probe.phase}]`, {
        sessionGroup:mode === 'single' ? null : scene.sessionGroup, targetBinding:binding,
        priority:0,bypassState:true,ackDeadlineAt:Math.floor(deadline/1000),
      });
      const controlId = control?.id;
      if (!Number.isInteger(controlId) || controlId <= 0) throw new Error('Recovery control was not inserted');
      Object.assign(probe,{scene:{...scene},controlId,deadline,sentAt,idleOnly,forcedBusy,toolsSeen:false,preparing:false});
      if(probe.phase === 'recovery') await this.coordinator.markProbeQueued(probe.runtime);
      return;
    }
    if (idleOnly && busy) {
      if (!this.recoveryWaits.has(probe.runtime)) this.recoveryWaits.set(probe.runtime,this.now());
    } else if (idleOnly) this.recoveryWaits.delete(probe.runtime);
    this.finish(probe,{recovered:false,noTarget:true});
  }
  async pollProbe(probe) {
    if (this.stopped || probe.preparing) return;
    const current = await this.readIdentity(probe.scene.sessionGroup);
    if (!sameRun(probe.scene,current)) return this.finish(probe,{recovered:false,stale:true});
    if (probe.idleOnly && !probe.forcedBusy && this.now() <= probe.deadline) {
      const activity = await this.readState(probe.scene);
      if (activity?.tools?.length) probe.toolsSeen = true;
    }
    const row = await this.getControlById(probe.controlId);
    if (!row || !TERMINAL.has(row.status)) return;
    let screen,screenFingerprint;
    if(row.status === 'done') {try{screen=await this.readScreen(probe.scene);screenFingerprint=fingerprint(screen);}catch{}}
    else {screen=await this.readScreen(probe.scene);screenFingerprint=fingerprint(screen);}
    const matches = row.status === 'done' ? {} : await this.matchScreen(probe.runtime,screen);
    const checked = await this.readIdentity(probe.scene.sessionGroup);
    const result = await this.coordinator.applyProbeResult({runtime:probe.runtime,runId:probe.scene.runId,
      current:checked,terminal:row.last_error === 'STALE_TARGET' ? 'STALE_TARGET' : row.status,matches,
      identity:(await this.readState(probe.scene))?.healthIdentity ?? {session_id:probe.scene.sessionId},screenFingerprint,
      waitForIdle:probe.idleOnly && !probe.forcedBusy && probe.toolsSeen && row.status === 'timeout' && this.now() >= probe.deadline});
    if (result.classification === 'waiting') {
      if (!this.recoveryWaits.has(probe.runtime)) this.recoveryWaits.set(probe.runtime,probe.sentAt);
      return this.finish(probe,{recovered:false,waiting:true});
    }
    if (result.classification !== 'stale') this.recoveryWaits.delete(probe.runtime);
    this.finish(probe,{recovered:result.classification === 'ok',classification:result.classification});
    if (result.classification === 'other') this.sceneState(probe.scene).pendingStop='recovery_failed';
  }
  async checkDeliveredScreen(scene, tracked, delivery, state, now) {
    // Consume this notification before I/O; idle ticks must not resample old text.
    delivery.screenChecked = true;
    const health=this.coordinator.store(scene.runtime).read();
    const screen=health.health==='ok'?await this.readScreen(scene):null;
    const recoveredScreen=screen!==null && health.recovered?.session_id===scene.sessionId && health.recovered?.screen_fingerprint === fingerprint(screen);
    const matches = health.health === 'ok' && !recoveredScreen ? await this.matchScreen(scene.runtime,screen) : {};
    if (tracked.delivery !== delivery) return false;
    const authoritativeFailure=state.healthFailureCurrent || (state.healthIdentity && health.source==='hook' && !health.hook_ok &&
      health.session_id===state.healthIdentity.session_id && health.hook_pid===state.healthIdentity.claude_pid);
    // Accepted current-process failure evidence outranks a pane that may still show older text.
    if (authoritativeFailure) tracked.sticky = null;
    else if (matches.rateLimit?.detected || matches.authFailure?.detected) {
      tracked.sticky = null;
      if(matches.rateLimit?.detected) {tracked.rateHits++;if(tracked.rateHits < 2) return false;}
      else {tracked.rateHits=0;if((await this.checkAuth(scene.runtime))?.status !== 'failure') return false;}
      if (tracked.delivery !== delivery) return false;
      await this.coordinator.applyScreenEvidence({runtime:scene.runtime,runId:scene.runId,
        current:await this.readIdentity(scene.sessionGroup),matches,identity:state.healthIdentity});
      tracked.sticky = null;
    } else if (matches.apiError?.detected) {
      tracked.rateHits=0;
      tracked.sticky ??= {firstAt:now,count:0};tracked.sticky.count++;
      if (tracked.sticky.count >= 2 && now-tracked.sticky.firstAt >= 30000) {
        if (await this.stopScene(scene,'sticky_context_restart')) {if (tracked.delivery === delivery) tracked.delivery=null;tracked.sticky=null;return true;}
      }
    } else {tracked.sticky = null;tracked.rateHits=0;}
    return false;
  }
  async observeScene(scene) {
    if (this.stopped || !scene.ready || !scene.runId) return;
    const tracked = this.sceneState(scene), state = await this.readState(scene), now = this.now();
    if(tracked.pendingStop) {
      if(await this.stopScene(scene,tracked.pendingStop)) tracked.pendingStop=null;
      return;
    }
    if (!state || (state.runId && state.runId !== scene.runId)) return;
    if(tracked.watchdog?.pending)return;
    const tools = state.tools ?? [];
    const delivery = tracked.delivery;
    if (delivery) {
      // A pending pair/grace owns recovery for this scene. Do not run a second
      // screen-triggered recovery or tool watchdog in parallel with it.
      if (await this.observeDelivery(scene, tracked, delivery, state, now)) return;
      if (!delivery.screenChecked && now - delivery.pastedAt >= USER_MESSAGE_CHECK_DELAY_MS && await this.checkDeliveredScreen(scene, tracked, delivery, state, now)) return;
    }
    if (!tools.length) {tracked.watchdog=null;return;}
    if (this.coordinator.store(scene.runtime).read().health !== 'ok') {tracked.watchdog=null;return;}
    const candidates = [];
    for (const tool of tools) {
      const rule = await this.resolveToolRule(scene.runtime,tool);
      if (rule?.watchdog?.enabled && Number.isFinite(tool.startedAt) && now-tool.startedAt >= rule.watchdog.maxRuntimeSec*1000) candidates.push({tool,rule});
    }
    candidates.sort((a,b)=>a.tool.startedAt-b.tool.startedAt);
    const candidate = candidates[0];
    if (!candidate) {tracked.watchdog=null;return;}
    const {tool,rule} = candidate, id = tool.id;
    if (!id) return;
    if (tracked.watchdog?.id !== id || tracked.watchdog.sessionId!==scene.sessionId) tracked.watchdog={id,sessionId:scene.sessionId,retryAt:0,graceUntil:null};
    const watchdog=tracked.watchdog;
    const activityAt=this.activityAt(scene,state,tool.startedAt);
    const valid=async(current,{continuing=false}={})=>{
      if(current.sessionId!==watchdog.sessionId || this.scenes.get(scene.sessionGroup)!==tracked ||
        (watchdog.pending && tracked.delivery!==watchdog.owner) || tracked.watchdog!==watchdog ||
        !await this.canRecover(current))return false;
      if(continuing)return true;
      const fresh=await this.readState(current);
      return fresh?.sessionId===current.sessionId && !fresh.transcriptPending &&
        fresh.tools?.some(value=>value.id===id) &&
        this.activityAt(current,fresh,tool.startedAt)<=watchdog.activityAt;
    };
    if (watchdog.graceUntil !== null) {
      // A still-present timed-out tool retains its original fallback deadline.
      // Fresh activity invalidates a queued action, not the tool timeout itself.
      watchdog.activityAt=activityAt;
      if (now > watchdog.graceUntil) await this.stopScene(scene,'tool_timeout_restart',valid,
        {reason:'tool_timeout_restart',tool:tool.name,silence_ms:Math.max(0,now-activityAt)});
    } else if (!watchdog.pending && now >= watchdog.retryAt && await this.canRecover(scene)) {
      watchdog.pending=true;watchdog.owner=tracked.delivery;watchdog.activityAt=activityAt;
      try {
        const result = await this.nudge(scene,valid);
        const escapeEnqueued=result?.ok || result?.steps?.[0]?.ok;
        await this.diagnostic({event:'tool_timeout_nudge',reason:'tool_timeout_nudge',sessionGroup:scene.sessionGroup,
          runId:scene.runId,run_id:scene.runId,runtime:scene.runtime,tool:tool.name,silence_ms:Math.max(0,this.now()-activityAt),enqueued:result?.ok===true,escape_enqueued:escapeEnqueued===true,
          superseded:tracked.watchdog!==watchdog || tracked.delivery!==watchdog.owner});
        if(tracked.watchdog!==watchdog)return;
        const acceptedAt=result?.ok ? result.enqueuedAt : result?.steps?.[0]?.enqueuedAt;
        const resumeAfter=Number.isFinite(acceptedAt) ? acceptedAt : this.now();
        if (escapeEnqueued) watchdog.graceUntil=resumeAfter+rule.watchdog.interruptGraceSec*1000;
        else watchdog.retryAt=this.now()+rule.watchdog.cooldownSec*1000;
      } catch(error) {
        watchdog.retryAt=this.now()+rule.watchdog.cooldownSec*1000;
        await this.diagnostic({event:'tool_timeout_nudge',reason:'tool_timeout_nudge',sessionGroup:scene.sessionGroup,
          runId:scene.runId,run_id:scene.runId,runtime:scene.runtime,tool:tool.name,
          silence_ms:Math.max(0,this.now()-activityAt),enqueued:false,outcome:'unknown',
          superseded:tracked.watchdog!==watchdog || tracked.delivery!==watchdog.owner});
        throw error;
      } finally {watchdog.pending=false;}
    }
  }
  activityAt(scene,state,pastedAt) {
    return state?.sessionId===scene.sessionId ? Math.max(pastedAt,this.responseAt(state)) : pastedAt;
  }
  responseAt(state) {
    return Number.isFinite(state?.lastResponseAt) && state.lastResponseAt<=this.now() ? state.lastResponseAt : 0;
  }
  async observeDelivery(scene,tracked,delivery,state,now) {
    if(await this.readMode()!=='multi') {delivery.recovery=null;return false;}
    // A pair must finish even when Escape creates Stop/idle or transcript writes.
    if(delivery.recovery?.pending)return true;
    if(delivery.recovery?.sessionId!==undefined && delivery.recovery.sessionId!==scene.sessionId)delivery.recovery=null;
    let recovery=delivery.recovery;
    // Any actual AI work after paste disarms this observation, regardless of
    // which turn produced it. Retain only the independent one-shot screen check.
    const responseAt=state.sessionId===scene.sessionId ? this.responseAt(state) : 0;
    if(!state.transcriptPending && recovery && responseAt>recovery.responseAt) {
      delivery.recovery=null;recovery=null;
    }
    if(!recovery && !state.transcriptPending) {
      if(responseAt>delivery.pastedAt)delivery.noResponseEligible=false;
      else if(responseAt>delivery.silenceSince)delivery.silenceSince=delivery.pastedAt;
    }
    if(!delivery.noResponseEligible)return false;
    const activityAt=delivery.silenceSince;
    const silenceMs=Math.max(0,now-(recovery ? recovery.activityAt : activityAt));
    if(!recovery && (state.transcriptPending || silenceMs<NO_RESPONSE_SILENCE_MS))return false;
    if(!recovery && now<delivery.retryAt)return true;
    const episode=recovery ?? {sessionId:scene.sessionId,activityAt,responseAt:now,pending:true,nudgedAt:null};
    const valid=async(current,{continuing=false}={})=>{
      if(current.sessionId!==episode.sessionId || this.scenes.get(scene.sessionGroup)!==tracked ||
        tracked.delivery!==delivery || delivery.recovery!==episode || await this.readMode()!=='multi' ||
        !await this.canRecover(current))return false;
      if(continuing)return true;
      const fresh=await this.readState(current);
      if(fresh?.sessionId!==current.sessionId || fresh.transcriptPending)return false;
      if(episode.nudgedAt!==null)return this.responseAt(fresh)<=episode.responseAt;
      return this.responseAt(fresh)<=episode.activityAt;
    };
    if(!recovery) {
      if(!await this.canRecover(scene))return false;
      if(tracked.delivery!==delivery || delivery.recovery)return true;
      delivery.recovery=episode;
      try {
        const result=await this.nudge(scene,valid);
        const escapeEnqueued=result?.ok===true || result?.steps?.[0]?.ok===true;
        const acceptedAt=result?.ok ? result.enqueuedAt : result?.steps?.[0]?.enqueuedAt;
        const resumeAfter=Number.isFinite(acceptedAt) ? acceptedAt : this.now();
        await this.diagnostic({event:'no_response_nudge',reason:'no_response_nudge',sessionGroup:scene.sessionGroup,
          runId:scene.runId,run_id:scene.runId,runtime:scene.runtime,silence_ms:Math.max(0,this.now()-activityAt),
          enqueued:result?.ok===true,escape_enqueued:escapeEnqueued,
          superseded:tracked.delivery!==delivery || delivery.recovery!==episode});
        const owner=tracked.delivery;
        if(owner?.recovery!==episode)return true;
        if(result?.ok)episode.nudgedAt=resumeAfter;
        else {owner.recovery=null;owner.retryAt=this.now()+NO_RESPONSE_RETRY_MS;}
      } catch(error) {
        await this.diagnostic({event:'no_response_nudge',reason:'no_response_nudge',sessionGroup:scene.sessionGroup,
          runId:scene.runId,run_id:scene.runId,runtime:scene.runtime,silence_ms:Math.max(0,this.now()-activityAt),
          enqueued:false,outcome:'unknown',superseded:tracked.delivery!==delivery});
        const owner=tracked.delivery;
        if(owner?.recovery===episode) {
          owner.recovery=null;owner.retryAt=this.now()+NO_RESPONSE_RETRY_MS;
        }
        throw error;
      } finally {episode.pending=false;}
    } else if(episode.nudgedAt!==null && now-episode.nudgedAt>=NO_RESPONSE_GRACE_MS) {
      if(await this.stopScene(scene,'no_response_restart',valid,{reason:'no_response_restart',silence_ms:silenceMs})) {
        if(tracked.delivery?.recovery===episode)tracked.delivery=null;
        return true;
      }
    }
    return delivery.recovery!==null || now<delivery.retryAt;
  }

  async tick(scenes) {
    if(this.stopped)return;
    for (const probe of [...this.probes.values()]) {
      try {await this.pollProbe(probe);} catch(error) {this.log(error);}
    }
    const current = scenes ?? await this.listScenes();
    for (const scene of current) {
      try {await this.observeScene(scene);} catch(error) {this.log(error);}
    }
    const present = new Set(current.map(s=>s.sessionGroup));
    for (const group of this.scenes.keys()) if (!present.has(group)) this.scenes.delete(group);
  }
  async shutdown() {
    this.stopped=true;
    // Release IPC waiters immediately; a committed control remains in C4, and
    // shutdown never waits for its eventual acknowledgement or invents one.
    for(const probe of [...this.probes.values()])this.finish(probe,{recovered:false,stopped:true});
    await Promise.allSettled([...this.preparations]);
  }

}
