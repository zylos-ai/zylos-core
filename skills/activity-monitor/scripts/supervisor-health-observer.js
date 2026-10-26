import { createHash } from 'node:crypto';
import { recoveryEligibility } from './runtime-health.js';

const TERMINAL = new Set(['done', 'failed', 'timeout', 'cancelled', 'superseded']);
const fingerprint = text => createHash('sha256').update(String(text ?? '')).digest('hex');
const sameRun = (a, b) => Boolean(a && b && a.runtime === b.runtime && a.runId && a.runId === b.runId);

/** Observation owns no process launcher and never waits for an acknowledgement in tick. */
export class SupervisorHealthObserver {
  constructor({ coordinator, listScenes, readIdentity, readState, readScreen, matchScreen,
    insertControl, getControlById, buildTargetBinding, stop, readMode,
    getModeTransition = () => null, getDrainFence = () => null, manualPending = () => false,
    resolveToolRule = () => null, interrupt, checkAuth, diagnostic = () => {}, now = Date.now,
    log = () => {}, recoveryDeadlineMs = 120000 } = {}) {
    Object.assign(this, { coordinator, listScenes, readIdentity, readState, readScreen, matchScreen,
      insertControl, getControlById, buildTargetBinding, stop, readMode, getModeTransition,
      getDrainFence, manualPending, resolveToolRule, interrupt, checkAuth, diagnostic, now, log, recoveryDeadlineMs });
    this.probes = new Map();
    this.scenes = new Map();
    this.verifications = new Map();
    this.preparations = new Set();
    this.stopped = false;
  }
  probeInFlight(runtime) { return this.probes.has(runtime); }
  sceneState(scene) {
    let state = this.scenes.get(scene.sessionGroup);
    if (!state || !sameRun(state, scene)) {
      state = { runtime: scene.runtime, runId: scene.runId, delivery: null, rateHits:0, sticky: null, frozen: null, watchdog: null };
      this.scenes.set(scene.sessionGroup, state);
    }
    return state;
  }
  notifyDelivered({ sessionGroup, runId, runtime, pastedAt }) {
    if (this.stopped || !sessionGroup || !runId || !runtime || !Number.isFinite(pastedAt)) return false;
    const state = this.sceneState({sessionGroup, runId, runtime});
    if (!state.delivery || pastedAt > state.delivery.pastedAt) {
      state.delivery = {pastedAt, lastAt:pastedAt, elapsed:0, toolsActive:false, responded:false, screenChecked:false};
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
  async stopScene(scene, event) {
    if (!await this.canAct(scene, {requireReady:true})) return false;
    if(await this.stop(scene) === false)return false;
    await this.diagnostic({event, sessionGroup:scene.sessionGroup, runId:scene.runId, runtime:scene.runtime});
    return true;
  }
  async due(runtime) {
    const state = await this.coordinator.restore(runtime);
    const cache = await this.coordinator.readNegativeCache(runtime, state);
    return recoveryEligibility(state, { runtime, cache, nowMs: this.now() }).eligible;
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
  async prepareProbe(probe) {
    if(this.stopped)return this.finish(probe,{recovered:false,stopped:true});
    if (!probe.force && !await this.due(probe.runtime)) return this.finish(probe,{recovered:false});
    const mode = await this.readMode();
    const scenes = (await this.listScenes()).filter(s => s.runtime === probe.runtime && s.ready === true && s.runId)
      .sort((a,b) => a.sessionGroup === 'origin' ? -1 : b.sessionGroup === 'origin' ? 1 : a.sessionGroup.localeCompare(b.sessionGroup));
    for (const scene of scenes) {
      if (!await this.canAct(scene,{requireReady:true,requireOpen:true})) continue;
      const binding = await this.buildTargetBinding(scene);
      // Binding construction may perform I/O; repeat identity and gates immediately before insertion.
      if (!await this.canAct(scene,{requireReady:true,requireOpen:true}) || this.stopped) continue;
      const deadline = this.now() + (probe.phase === 'recovery' ? this.recoveryDeadlineMs : 300000);
      const controlId = await this.insertControl(`Heartbeat check. [phase=${probe.phase}]`, {
        sessionGroup:mode === 'single' ? null : scene.sessionGroup, targetBinding:binding,
        priority:0,bypassState:true,ackDeadlineAt:Math.floor(deadline/1000),
      });
      if (!Number.isInteger(controlId) || controlId <= 0) throw new Error('Recovery control was not inserted');
      Object.assign(probe,{scene:{...scene},controlId,deadline,preparing:false});
      if(probe.phase === 'recovery') await this.coordinator.markProbeQueued(probe.runtime);
      return;
    }
    this.finish(probe,{recovered:false});
  }
  async pollProbe(probe) {
    if (this.stopped || probe.preparing) return;
    const current = await this.readIdentity(probe.scene.sessionGroup);
    if (!sameRun(probe.scene,current)) return this.finish(probe,{recovered:false,stale:true});
    const row = await this.getControlById(probe.controlId);
    if (!row || !TERMINAL.has(row.status)) return;
    let screen,screenFingerprint;
    if(row.status === 'done') {try{screen=await this.readScreen(probe.scene);screenFingerprint=fingerprint(screen);}catch{}}
    else {screen=await this.readScreen(probe.scene);screenFingerprint=fingerprint(screen);}
    const matches = row.status === 'done' ? {} : await this.matchScreen(probe.runtime,screen);
    const checked = await this.readIdentity(probe.scene.sessionGroup);
    const result = await this.coordinator.applyProbeResult({runtime:probe.runtime,runId:probe.scene.runId,
      current:checked,terminal:row.last_error === 'STALE_TARGET' ? 'STALE_TARGET' : row.status,matches,
      identity:(await this.readState(probe.scene))?.healthIdentity ?? {session_id:probe.scene.sessionId},screenFingerprint});
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
    const tools = state.tools ?? [];
    const delivery = tracked.delivery;
    if (delivery) {
      const eventResponse = state.sessionId === scene.sessionId && state.lastActivityAt > delivery.pastedAt;
      if (eventResponse || state.transcriptMtimeMs > delivery.pastedAt) delivery.responded = true;
      // Current active tools also cover a late delivery notification whose paste preceded observation.
      if (!delivery.toolsActive && !tools.length) delivery.elapsed += Math.max(0,now-delivery.lastAt);
      delivery.lastAt = now; delivery.toolsActive = tools.length > 0;
      if (!delivery.responded && await this.readMode() === 'multi' && delivery.elapsed >= 600000) {
        if (await this.stopScene(scene,'no_response_detected')) {tracked.delivery = null;return;}
      }
      if (!delivery.screenChecked && await this.checkDeliveredScreen(scene, tracked, delivery, state, now)) return;
    }
    if (!tools.length) {tracked.frozen=null;tracked.watchdog=null;return;}
    if (Number.isFinite(state.contextSwitches)) {
      if (!tracked.frozen || tracked.frozen.value !== state.contextSwitches) tracked.frozen={value:state.contextSwitches,since:now};
      else if (now-tracked.frozen.since >= 60000) {
        if (await this.stopScene(scene,'process_frozen')) return;
      }
    } else tracked.frozen=null;
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
    if (tracked.watchdog?.id !== id) tracked.watchdog={id,retryAt:0,graceUntil:null};
    const watchdog=tracked.watchdog;
    if (watchdog.graceUntil !== null) {
      if (now > watchdog.graceUntil) await this.stopScene(scene,`tool_timeout_${tool.name}`);
    } else if (now >= watchdog.retryAt && await this.canAct(scene,{requireReady:true})) {
      const result = await this.interrupt(scene,rule.watchdog.interruptKey);
      if (result?.ok) watchdog.graceUntil=now+rule.watchdog.interruptGraceSec*1000;
      else watchdog.retryAt=now+rule.watchdog.cooldownSec*1000;
    }
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
